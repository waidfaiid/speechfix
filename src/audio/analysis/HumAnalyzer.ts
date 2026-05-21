/**
 * HumAnalyzer – Phase 1 & 2 of the auto hum-removal pipeline.
 *
 * Workflow:
 *  1. Extract samples from a user-marked "silence region" of an AudioBuffer.
 *  2. Apply Hanning window + FFT (size 8192) to ~20 overlapping frames.
 *  3. Average the magnitude spectra → noise fingerprint.
 *  4. Estimate local noise floor (sliding median) and detect peaks ≥ 15 dB above it.
 *  5. Classify peaks as tonal (narrow) vs. broadband (ignore).
 *  6. Build harmonic groups and assign Q + notch depth per peak.
 *  7. Return DetectedHumPeak[] + averaged magnitude spectrum for spectral subtraction.
 */

import type { DetectedHumPeak } from '@/types/processing.types'

const FFT_SIZE = 8192
const OVERLAP = 0.5
const MIN_FRAMES = 4
const TARGET_FRAMES = 20
const MIN_DB_ABOVE_FLOOR = 15
/** A peak is considered "narrow" (tonal) when its -3 dB bandwidth is less than
 *  this fraction of its center frequency (i.e. Q > 1/MAX_RELATIVE_BW). */
const MAX_RELATIVE_BW = 0.05
/** Maximum Q cap applied to any generated notch filter. */
const Q_MAX = 200
/** Minimum Q – prevents overly wide notches on very low frequencies. */
const Q_MIN = 20
/** Ratio of harmonic frequency tolerance (e.g. 0.02 = ±2 %). */
const HARMONIC_TOLERANCE = 0.03

// ---------------------------------------------------------------------------
// Hanning window
// ---------------------------------------------------------------------------

function makeHanningWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  }
  return w
}

// ---------------------------------------------------------------------------
// Cooley–Tukey radix-2 FFT (in-place, power-of-2 sizes only)
// ---------------------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  // Bit-reversal permutation
  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    while (j & bit) {
      j ^= bit
      bit >>= 1
    }
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < halfLen; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + halfLen] * curRe - im[i + k + halfLen] * curIm
        const vIm = re[i + k + halfLen] * curIm + im[i + k + halfLen] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + halfLen] = uRe - vRe
        im[i + k + halfLen] = uIm - vIm
        const newRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = newRe
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sliding-median noise-floor estimator
// ---------------------------------------------------------------------------

function estimateNoiseFloor(magnitudeDb: Float32Array, windowBins: number): Float32Array {
  const n = magnitudeDb.length
  const floor = new Float32Array(n)
  const half = Math.floor(windowBins / 2)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    const slice: number[] = []
    for (let k = lo; k <= hi; k++) slice.push(magnitudeDb[k])
    slice.sort((a, b) => a - b)
    floor[i] = slice[Math.floor(slice.length / 2)]
  }
  return floor
}

// ---------------------------------------------------------------------------
// Inverse FFT (for spectral subtraction)
// ---------------------------------------------------------------------------

export function ifft(re: Float64Array, im: Float64Array): void {
  // Conjugate → forward FFT → conjugate → scale
  for (let i = 0; i < im.length; i++) im[i] = -im[i]
  fft(re, im)
  const n = re.length
  for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] = -im[i] / n
  }
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export interface HumAnalysisResult {
  peaks: DetectedHumPeak[]
  /** Averaged linear magnitude spectrum (length = FFT_SIZE / 2 + 1) */
  noiseProfile: Float32Array
  sampleRate: number
  fftSize: number
}

/**
 * Analyse the noise profile from a user-selected silence region.
 *
 * @param buffer     Full AudioBuffer of the loaded file
 * @param startSec   Start of silence region in seconds
 * @param endSec     End of silence region in seconds
 */
export async function analyzeNoiseProfile(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
): Promise<HumAnalysisResult> {
  const sr = buffer.sampleRate
  const startSample = Math.floor(startSec * sr)
  const endSample = Math.min(Math.floor(endSec * sr), buffer.length)
  const regionLength = endSample - startSample

  if (regionLength < FFT_SIZE) {
    throw new Error(
      `Stille-Region zu kurz (${(regionLength / sr).toFixed(2)} s). Mindestens ${(FFT_SIZE / sr).toFixed(2)} s erforderlich.`,
    )
  }

  // Mix all channels to mono
  const mono = new Float32Array(regionLength)
  const numCh = buffer.numberOfChannels
  for (let ch = 0; ch < numCh; ch++) {
    const chData = buffer.getChannelData(ch)
    for (let i = 0; i < regionLength; i++) {
      mono[i] += chData[startSample + i] / numCh
    }
  }

  const window = makeHanningWindow(FFT_SIZE)
  const hopSize = Math.floor(FFT_SIZE * (1 - OVERLAP))
  const maxFrames = Math.floor((regionLength - FFT_SIZE) / hopSize) + 1
  const numFrames = Math.max(MIN_FRAMES, Math.min(TARGET_FRAMES, maxFrames))
  const numBins = FFT_SIZE / 2 + 1

  // Average magnitude spectrum (linear)
  const avgMag = new Float64Array(numBins)

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = Math.floor((frame / Math.max(1, numFrames - 1)) * Math.max(0, regionLength - FFT_SIZE))
    const re = new Float64Array(FFT_SIZE)
    const im = new Float64Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[offset + i] * window[i]
    }
    fft(re, im)
    for (let k = 0; k < numBins; k++) {
      avgMag[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k])
    }
  }
  for (let k = 0; k < numBins; k++) avgMag[k] /= numFrames

  // Convert to dB (avoid -Inf)
  const magDb = new Float32Array(numBins)
  for (let k = 0; k < numBins; k++) {
    magDb[k] = avgMag[k] > 1e-10 ? 20 * Math.log10(avgMag[k]) : -120
  }

  // Noise-floor estimation: sliding median over ±40 bins (~40 * sr / FFT_SIZE Hz)
  const noiseFloor = estimateNoiseFloor(magDb, 80)

  // Peak detection
  const peaks = detectPeaks(magDb, noiseFloor, sr)

  // Save linear profile (Float32) for spectral subtraction
  const noiseProfile = new Float32Array(numBins)
  for (let k = 0; k < numBins; k++) noiseProfile[k] = avgMag[k]

  return { peaks, noiseProfile, sampleRate: sr, fftSize: FFT_SIZE }
}

// ---------------------------------------------------------------------------
// Peak detection + harmonic grouping
// ---------------------------------------------------------------------------

function detectPeaks(
  magDb: Float32Array,
  noiseFloor: Float32Array,
  sampleRate: number,
): DetectedHumPeak[] {
  const numBins = magDb.length
  const binHz = sampleRate / (2 * (numBins - 1))

  // 1. Find all local maxima that are sufficiently above the noise floor
  const candidates: Array<{ bin: number; freq: number; dbAboveFloor: number }> = []

  for (let k = 1; k < numBins - 1; k++) {
    const above = magDb[k] - noiseFloor[k]
    if (above < MIN_DB_ABOVE_FLOOR) continue
    if (magDb[k] <= magDb[k - 1] || magDb[k] <= magDb[k + 1]) continue
    candidates.push({ bin: k, freq: k * binHz, dbAboveFloor: above })
  }

  // 2. Narrow-band check: measure -3 dB bandwidth
  const narrowPeaks = candidates.filter((c) => {
    const targetDb = magDb[c.bin] - 3
    // Walk left
    let lo = c.bin
    while (lo > 0 && magDb[lo - 1] >= targetDb) lo--
    // Walk right
    let hi = c.bin
    while (hi < numBins - 1 && magDb[hi + 1] >= targetDb) hi++
    const bwHz = (hi - lo) * binHz
    const relBw = bwHz / Math.max(c.freq, 1)
    return relBw < MAX_RELATIVE_BW
  })

  // 3. Harmonic grouping: mark peaks that are integer multiples of a root
  // Sort by amplitude (strongest first) so fundamentals are identified first
  narrowPeaks.sort((a, b) => b.dbAboveFloor - a.dbAboveFloor)

  const harmonicGroup = new Map<number, number>() // bin → fundamental bin
  for (let i = 0; i < narrowPeaks.length; i++) {
    const fi = narrowPeaks[i].freq
    if (harmonicGroup.has(narrowPeaks[i].bin)) continue // already assigned
    // Check if this is an overtone of an earlier peak
    let isOvertone = false
    for (let j = 0; j < i; j++) {
      const fj = narrowPeaks[j].freq
      if (fi <= fj) continue
      const ratio = fi / fj
      const nearestInt = Math.round(ratio)
      if (nearestInt >= 2 && Math.abs(ratio - nearestInt) / nearestInt < HARMONIC_TOLERANCE) {
        isOvertone = true
        harmonicGroup.set(narrowPeaks[i].bin, narrowPeaks[j].bin)
        break
      }
    }
    if (!isOvertone) {
      harmonicGroup.set(narrowPeaks[i].bin, narrowPeaks[i].bin) // own fundamental
    }
  }

  // 4. Build DetectedHumPeak list
  const result: DetectedHumPeak[] = []

  for (const p of narrowPeaks) {
    const freq = p.freq
    if (freq < 20 || freq > 24000) continue // outside audible range

    // Measure -3 dB bandwidth to derive Q
    const targetDb = magDb[p.bin] - 3
    let lo = p.bin
    let hi = p.bin
    while (lo > 0 && magDb[lo - 1] >= targetDb) lo--
    while (hi < numBins - 1 && magDb[hi + 1] >= targetDb) hi++
    const bwHz = Math.max((hi - lo) * binHz, binHz)
    const measuredQ = freq / bwHz

    const q = Math.max(Q_MIN, Math.min(Q_MAX, measuredQ))

    // Notch depth: proportional to dB above floor, capped at 70 dB
    const gainDb = -Math.min(p.dbAboveFloor * 1.2, 70)

    result.push({ frequency: freq, amplitude: p.dbAboveFloor, q, gainDb, enabled: true })
  }

  // Sort by frequency ascending
  result.sort((a, b) => a.frequency - b.frequency)

  return result
}

// ---------------------------------------------------------------------------
// Spectral subtraction (exported for use in Transcoder offline pass)
// ---------------------------------------------------------------------------

/**
 * Apply spectral subtraction to a mono PCM array in-place.
 *
 * @param samples     Float32Array of mono PCM samples (modified in-place)
 * @param noiseProfile Linear magnitude spectrum (from analyzeNoiseProfile)
 * @param alpha       Subtraction factor (0.5 = gentle, 2.0 = aggressive)
 * @param fftSize     Must match noiseProfile length * 2 - 2
 */
export function applySpectralSubtraction(
  samples: Float32Array<ArrayBufferLike>,
  noiseProfile: Float32Array<ArrayBufferLike>,
  alpha: number,
  fftSize: number = FFT_SIZE,
): Float32Array {
  const hopSize = fftSize >> 1
  const numBins = fftSize / 2 + 1
  const hanWin = makeHanningWindow(fftSize)
  const output = new Float64Array(samples.length)
  const overlapAcc = new Float64Array(samples.length)

  for (let offset = 0; offset + fftSize <= samples.length; offset += hopSize) {
    const re = new Float64Array(fftSize)
    const im = new Float64Array(fftSize)

    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[offset + i] * hanWin[i]
    }

    fft(re, im)

    // Spectral subtraction: M_clean = max(M_signal - α * M_noise, β * M_signal)
    const beta = 0.01 // spectral floor to avoid musical noise
    for (let k = 0; k < numBins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const phase = Math.atan2(im[k], re[k])
      const cleanMag = Math.max(mag - alpha * noiseProfile[k], beta * mag)
      re[k] = cleanMag * Math.cos(phase)
      im[k] = cleanMag * Math.sin(phase)
      // Mirror for negative frequencies (conjugate symmetry)
      if (k > 0 && k < numBins - 1) {
        re[fftSize - k] = re[k]
        im[fftSize - k] = -im[k]
      }
    }

    ifft(re, im)

    // Overlap-add with Hanning window
    for (let i = 0; i < fftSize; i++) {
      output[offset + i] += re[i] * hanWin[i]
      overlapAcc[offset + i] += hanWin[i] * hanWin[i]
    }
  }

  // Normalize overlap
  const result = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    result[i] = overlapAcc[i] > 1e-6 ? output[i] / overlapAcc[i] : 0
  }
  return result
}
