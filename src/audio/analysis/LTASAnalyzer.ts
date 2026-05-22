/**
 * Long-Term Average Spectrum (LTAS) analyzer.
 *
 * Decodes an audio file and computes the averaged FFT magnitude spectrum
 * across all non-silent frames. Returns 512 dB values on a log-spaced
 * frequency grid matching the EQ graph (20–20000 Hz).
 *
 * Uses a pure-JS radix-2 Cooley-Tukey FFT – no external dependencies.
 * Processing yields to the event loop every 200 frames to stay non-blocking.
 */

const FFT_SIZE = 4096
const HOP = FFT_SIZE / 2
const SILENCE_THRESHOLD = 0.0005  // ~-66 dBFS RMS

/**
 * Maximum number of FFT frames to process regardless of file length.
 * Frames are sampled uniformly across the full duration so the LTAS
 * represents the whole recording. 4 000 frames is statistically more
 * than sufficient for a stable long-term average spectrum and keeps
 * analysis time under ~10 s even for very long recordings.
 */
const MAX_LTAS_FRAMES = 4000

const GRID_POINTS = 512
const MIN_FREQ = 20
const MAX_FREQ = 20000

// ---------------------------------------------------------------------------
// In-place radix-2 Cooley-Tukey FFT
// ---------------------------------------------------------------------------

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const N = re.length

  // Bit-reversal permutation
  let j = 0
  for (let i = 1; i < N; i++) {
    let bit = N >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]];
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }

  // Butterfly stages
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wBaseRe = Math.cos(ang)
    const wBaseIm = Math.sin(ang)
    for (let i = 0; i < N; i += len) {
      let wRe = 1
      let wIm = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm
        const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + half] = uRe - vRe
        im[i + k + half] = uIm - vIm
        const nextRe = wRe * wBaseRe - wIm * wBaseIm
        wIm = wRe * wBaseIm + wIm * wBaseRe
        wRe = nextRe
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hann window (pre-computed once)
// ---------------------------------------------------------------------------

const HANN_WINDOW = new Float32Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))
}

// ---------------------------------------------------------------------------
// Map FFT bins → 512-point log grid
// ---------------------------------------------------------------------------

function buildBinToGrid(sampleRate: number): Int32Array {
  const binFreq = sampleRate / FFT_SIZE
  const map = new Int32Array(FFT_SIZE / 2)
  for (let k = 1; k < FFT_SIZE / 2; k++) {
    const freq = k * binFreq
    if (freq < MIN_FREQ || freq > MAX_FREQ) {
      map[k] = -1
      continue
    }
    map[k] = Math.round(
      (Math.log(freq / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ)) * (GRID_POINTS - 1)
    )
  }
  return map
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze an audio source and return a 512-point LTAS (dB, log-freq grid).
 * Accepts an already-decoded AudioBuffer (preferred, avoids a second full decode)
 * or a raw File (will be decoded here as a fallback).
 * Reports progress via onProgress (0–1).
 */
export async function analyzeLTAS(
  source: AudioBuffer | File,
  onProgress?: (p: number) => void
): Promise<Float32Array> {
  let audioBuffer: AudioBuffer
  if (source instanceof AudioBuffer) {
    audioBuffer = source
  } else {
    const arrayBuffer = await source.arrayBuffer()
    const tmpCtx = new AudioContext()
    audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer)
    await tmpCtx.close()
  }

  // Mix down to mono.
  // For mono files: use getChannelData(0) directly — no 617 MB copy needed.
  const sampleRate = audioBuffer.sampleRate
  const numChannels = audioBuffer.numberOfChannels
  const length = audioBuffer.length
  const mono: Float32Array = numChannels === 1
    ? audioBuffer.getChannelData(0)
    : (() => {
        const m = new Float32Array(length)
        for (let ch = 0; ch < numChannels; ch++) {
          const chData = audioBuffer.getChannelData(ch)
          for (let n = 0; n < length; n++) m[n] += chData[n]
        }
        for (let n = 0; n < length; n++) m[n] /= numChannels
        return m
      })()

  const binToGrid = buildBinToGrid(sampleRate)
  const gridSum = new Float64Array(GRID_POINTS)
  const gridCount = new Int32Array(GRID_POINTS)

  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)

  // Total possible frames at the native hop size
  const rawNumFrames = Math.max(1, Math.floor((length - FFT_SIZE) / HOP))

  // For long recordings stride through the file uniformly so that at most
  // MAX_LTAS_FRAMES FFTs are computed. This keeps analysis time under ~10 s
  // while still capturing the full spectral character of the recording.
  const stride = Math.max(1, Math.ceil(rawNumFrames / MAX_LTAS_FRAMES))
  const numFrames = Math.ceil(rawNumFrames / stride)
  let validFrames = 0

  for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
    const start = frameIdx * stride * HOP

    // Fill + window
    let rmsSum = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = mono[start + i] * HANN_WINDOW[i]
      re[i] = s
      im[i] = 0
      rmsSum += s * s
    }

    // Skip silence
    const rms = Math.sqrt(rmsSum / FFT_SIZE)
    if (rms < SILENCE_THRESHOLD) continue

    // FFT
    fftInPlace(re, im)

    // Accumulate magnitudes into grid
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const g = binToGrid[k]
      if (g < 0) continue
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      gridSum[g] += mag
      gridCount[g]++
    }

    validFrames++

    // Yield every 200 frames to keep the UI responsive
    if (frameIdx % 200 === 199) {
      onProgress?.(frameIdx / numFrames)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  onProgress?.(1)

  if (validFrames === 0) {
    return new Float32Array(GRID_POINTS).fill(-60)
  }

  // Average and convert to dB
  const ltas = new Float32Array(GRID_POINTS)
  for (let g = 0; g < GRID_POINTS; g++) {
    const avg = gridCount[g] > 0 ? gridSum[g] / gridCount[g] : 0
    ltas[g] = 20 * Math.log10(Math.max(avg, 1e-12))
  }

  // Fill any gaps (bins with no FFT data) by linear interpolation
  let lastValid = -1
  for (let g = 0; g < GRID_POINTS; g++) {
    if (gridCount[g] > 0) {
      if (lastValid >= 0 && g - lastValid > 1) {
        // Interpolate gap
        for (let k = lastValid + 1; k < g; k++) {
          const t = (k - lastValid) / (g - lastValid)
          ltas[k] = ltas[lastValid] * (1 - t) + ltas[g] * t
        }
      }
      lastValid = g
    }
  }

  return ltas
}
