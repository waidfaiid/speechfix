import { ffmpegManager } from './FFmpegManager'
import { audioContextManager } from '../AudioContextManager'
import type { ProcessingParams, ExportOptions } from '@/types/processing.types'
import type { BiquadFilterType } from '@/types/audio.types'
import { applySpectralSubtraction } from '../analysis/HumAnalyzer'
import { DYNAMICS_WORKING_LEVEL_LUFS } from '../analysis/dynamicsMeter'

const QUALITY_BITRATE: Record<string, Record<string, string>> = {
  mp3:  { low: '96k',  medium: '192k', high: '320k',  lossless: '320k' },
  aac:  { low: '96k',  medium: '192k', high: '256k',  lossless: '256k' },
  ogg:  { low: '3',    medium: '6',    high: '9',     lossless: '9' },
  flac: { low: '0',    medium: '0',    high: '0',     lossless: '0' },
  wav:  { low: '0',    medium: '0',    high: '0',     lossless: '0' },
  m4a:  { low: '96k',  medium: '192k', high: '256k',  lossless: '256k' },
}

const PREVIEW_SAMPLE_RATE = 48000

function codecCutoffFor(sampleRate: number): string {
  return String(Math.floor(sampleRate / 2))
}

function formatCoeff(value: number): string {
  if (Math.abs(value) < 1e-15) return '0'
  return Number(value.toFixed(15)).toString()
}

/**
 * Build an FFmpeg biquad with the same coefficient family used by Web Audio's
 * BiquadFilterNode. This keeps the offline export EQ aligned with the realtime
 * browser preview instead of relying on FFmpeg's similar-but-different filters
 * (`equalizer`, `bass`, `treble`, `highpass`, ...).
 */
function buildWebAudioBiquadFilter(
  type: BiquadFilterType,
  freq: number,
  q: number,
  gainDb: number,
  sampleRate = PREVIEW_SAMPLE_RATE,
): string | null {
  const nyquist = sampleRate / 2
  const clampedFreq = Math.max(1, Math.min(freq, nyquist - 1))
  const safeQ = Math.max(0.0001, q)
  const w0 = (2 * Math.PI * clampedFreq) / sampleRate
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const A = Math.pow(10, gainDb / 40)
  const alpha = sinW0 / (2 * safeQ)

  const coefficients = (() => {
    switch (type) {
      case 'lowpass':
        return {
          b0: (1 - cosW0) / 2,
          b1: 1 - cosW0,
          b2: (1 - cosW0) / 2,
          a0: 1 + alpha,
          a1: -2 * cosW0,
          a2: 1 - alpha,
        }

      case 'highpass':
        return {
          b0: (1 + cosW0) / 2,
          b1: -(1 + cosW0),
          b2: (1 + cosW0) / 2,
          a0: 1 + alpha,
          a1: -2 * cosW0,
          a2: 1 - alpha,
        }

      case 'bandpass':
        return {
          b0: sinW0 / 2,
          b1: 0,
          b2: -sinW0 / 2,
          a0: 1 + alpha,
          a1: -2 * cosW0,
          a2: 1 - alpha,
        }

      case 'notch':
        return {
          b0: 1,
          b1: -2 * cosW0,
          b2: 1,
          a0: 1 + alpha,
          a1: -2 * cosW0,
          a2: 1 - alpha,
        }

      case 'allpass':
        return {
          b0: 1 - alpha,
          b1: -2 * cosW0,
          b2: 1 + alpha,
          a0: 1 + alpha,
          a1: -2 * cosW0,
          a2: 1 - alpha,
        }

      case 'peaking':
        return {
          b0: 1 + alpha * A,
          b1: -2 * cosW0,
          b2: 1 - alpha * A,
          a0: 1 + alpha / A,
          a1: -2 * cosW0,
          a2: 1 - alpha / A,
        }

      case 'lowshelf': {
        // Web Audio shelves do not expose Q as a bandwidth control; use the
        // standard shelf slope S=1 form from the Audio EQ Cookbook.
        const shelfAlpha = (sinW0 / 2) * Math.SQRT2
        const twoSqrtAAlpha = 2 * Math.sqrt(A) * shelfAlpha
        return {
          b0: A * ((A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha),
          b1: 2 * A * ((A - 1) - (A + 1) * cosW0),
          b2: A * ((A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha),
          a0: (A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha,
          a1: -2 * ((A - 1) + (A + 1) * cosW0),
          a2: (A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha,
        }
      }

      case 'highshelf': {
        // Same Web Audio shelf slope assumption as lowshelf.
        const shelfAlpha = (sinW0 / 2) * Math.SQRT2
        const twoSqrtAAlpha = 2 * Math.sqrt(A) * shelfAlpha
        return {
          b0: A * ((A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha),
          b1: -2 * A * ((A - 1) + (A + 1) * cosW0),
          b2: A * ((A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha),
          a0: (A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha,
          a1: 2 * ((A - 1) - (A + 1) * cosW0),
          a2: (A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha,
        }
      }

      default:
        return null
    }
  })()

  if (!coefficients) return null

  return [
    `biquad=b0=${formatCoeff(coefficients.b0)}`,
    `b1=${formatCoeff(coefficients.b1)}`,
    `b2=${formatCoeff(coefficients.b2)}`,
    `a0=${formatCoeff(coefficients.a0)}`,
    `a1=${formatCoeff(coefficients.a1)}`,
    `a2=${formatCoeff(coefficients.a2)}`,
    'precision=f64',
    'normalize=0',
  ].join(':')
}

// ---------------------------------------------------------------------------
// Internal chain builders
// ---------------------------------------------------------------------------

/**
 * Filters applied BEFORE the de-esser: hum removal, noise reduction,
 * high-pass, and tonal EQ correction.
 */
/**
 * @param skipHumAndEQ – pass `true` when hum removal and EQ have already been
 *   applied offline (via applyPreFiltersOffline) before RNNoise processing.
 *   In that case FFmpeg only needs the aresample guard; applying hum/EQ a
 *   second time would double the correction.
 */
function buildPreDeEsserFilters(params: ProcessingParams, skipHumAndEQ = false): string[] {
  const filters: string[] = [`aresample=${PREVIEW_SAMPLE_RATE}`]

  if (!skipHumAndEQ) {
    if (params.humEnabled) {
      if (params.humAutoMode && params.humDetectedFreqs.length > 0) {
        // Auto mode: peaking biquad per detected peak, gain scaled by slider
        params.humDetectedFreqs.forEach((peak) => {
          if (!peak.enabled) return
          const filter = buildWebAudioBiquadFilter('peaking', peak.frequency, peak.q, peak.gainDb * params.humAmount)
          if (filter) filters.push(filter)
        })
      } else if (!params.humAutoMode && params.humAmount > 0) {
        // Manual mode: 4-band peaking at 50/100/150/200 Hz (max -70 dB at fundamental)
        const g = -(params.humAmount * 70)
        const q = params.humQ
        const humFilters = [
          buildWebAudioBiquadFilter('peaking', 50,  q, g),
          buildWebAudioBiquadFilter('peaking', 100, q, g * 0.7),
          buildWebAudioBiquadFilter('peaking', 150, q, g * 0.5),
          buildWebAudioBiquadFilter('peaking', 200, q, g * 0.3),
        ].filter((f): f is string => Boolean(f))
        filters.push(...humFilters)
      }
    }

    if (params.eqEnabled) {
      params.eqBands.forEach((band) => {
        if (!band.enabled) return
        const gain = band.gain * params.eqIntensity
        const isGainless = band.type === 'highpass' || band.type === 'lowpass' ||
          band.type === 'notch' || band.type === 'bandpass' || band.type === 'allpass'
        if (!isGainless && Math.abs(gain) < 0.1) return

        const filter = buildWebAudioBiquadFilter(band.type, band.freq, band.q, gain)
        if (filter) filters.push(filter)
      })
    }
  }

  // Noise reduction is handled by RNNoise pre-processing in exportFile() before
  // FFmpeg sees the audio; no FFmpeg filter needed here.

  return filters
}

/**
 * Two-stage compression — mirrors AudioEngine.ts (before de-esser).
 *
 * FFmpeg's `acompressor` threshold is a LINEAR amplitude ratio (0.000976…1),
 * NOT a dB value. All thresholds are converted with 10^(dB/20) here.
 * The knee parameter range is 1–8 dB; knee=0 is below the minimum.
 */
function buildCompressionFilters(params: ProcessingParams): string[] {
  if (!params.compressionEnabled) return []
  const amount = params.compressionAmount
  const isMixed = params.contentType === 'mixed'

  // Stage 1: peak catcher — matches AudioEngine stage-1 logic
  const s1ThreshDb = isMixed ? -4 : -8
  const s1ThreshLin = Math.pow(10, s1ThreshDb / 20).toFixed(6)
  const s1Ratio = (isMixed ? 1 + amount * 3 : 1 + amount * 11).toFixed(1)

  // Stage 2: LA2A-style — matches AudioEngine stage-2 logic
  const s2ThreshDb = -14 - amount * 18 + (isMixed ? 6 : 0)
  const s2ThreshLin = Math.pow(10, s2ThreshDb / 20).toFixed(6)
  const ratio = (2 + amount * 3).toFixed(1)
  const release = Math.round(250 + amount * 550)

  // knee=8 is the maximum FFmpeg allows (Web Audio defaults to 30 dB, but 8 is
  // the best available approximation — wider knee = softer onset = more signal
  // reaches the exciter, matching the preview's gentle compression behaviour).
  return [
    `acompressor=threshold=${s1ThreshLin}:ratio=${s1Ratio}:attack=3:release=50:knee=8`,
    `acompressor=threshold=${s2ThreshLin}:ratio=${ratio}:attack=25:release=${release}:knee=8`,
  ]
}

/**
 * Filters applied AFTER the de-esser: harmonic exciter only.
 *
 * Mirrors audioMath.ts exactly.  All three modes use a dry/wet blend that
 * keeps unity small-signal gain (quiet passages are not amplified):
 *
 *   sat(x) = tanh(x·drive) / drive   ← slope at x=0 is always 1
 *   f(x)   = x·(1−wet) + sat(x)·wet  ← still slope 1 for any wet value
 *
 * All constants are pre-computed from the fixed params.exciterAmount value
 * so the aeval expression contains only numeric literals.
 */
function buildPostDeEsserFilters(params: ProcessingParams): string[] {
  const filters: string[] = []
  if (!params.exciterEnabled || params.exciterAmount <= 0) return filters

  const amount = params.exciterAmount
  // Pre-drive boost: the Web Audio DynamicsCompressorNode's lookahead and
  // gain-smoothing behaviour leaves the signal effectively louder at the
  // WaveShaperNode input than the raw compressed signal would suggest.
  // A +4 dB boost here (matched by −4 dB after the waveshaper) replicates
  // that effective drive level, producing equivalent harmonic saturation.
  // The net gain through this section remains 0 dB; only the tanh drive increases.
  const DRIVE_BOOST_DB = 4.0
  filters.push(`volume=${DRIVE_BOOST_DB}dB`)

  // 4× oversampling mirrors Web Audio WaveShaperNode oversample='4x'.
  // Upsampling reconstructs the continuous-time signal, revealing inter-sample
  // peaks (typically 1–3 dB higher than digital peaks) that the tanh processes
  // exactly as the browser's waveshaper does.  The downsample at the end applies
  // an anti-aliasing filter that matches the browser's behaviour.
  const OVERSAMPLE_RATE = PREVIEW_SAMPLE_RATE * 4 // 192 000 Hz
  filters.push(`aresample=${OVERSAMPLE_RATE}`)

  if (params.exciterMode === 'tube') {
    // Mirrors createTubeCurve exactly.
    // DC offset (dc) is cancelled analytically inside the expression.
    const drive = 1 + amount * 3.25
    const bias  = 0.08 * amount
    const wet   = Math.pow(amount, 1.3) * 0.88
    const dc    = Math.tanh(bias * drive) / drive
    const dry   = 1 - wet
    // f(x) = x·dry + (tanh((x+bias)·drive)/drive − dc)·wet
    filters.push(
      `aeval=val(ch)*${dry.toFixed(6)}+(tanh((val(ch)+${bias.toFixed(6)})*${drive.toFixed(6)})/${drive.toFixed(6)}-${dc.toFixed(6)})*${wet.toFixed(6)}:c=same`,
    )

  } else if (params.exciterMode === 'tape') {
    // Mirrors createTapeCurve exactly.
    const drive = 1 + amount * 3.65
    const wet   = Math.pow(amount, 1.3) * 0.80
    const dry   = 1 - wet
    // f(x) = x·dry + tanh(x·drive)/drive·wet
    filters.push(
      `aeval=val(ch)*${dry.toFixed(6)}+tanh(val(ch)*${drive.toFixed(6)})/${drive.toFixed(6)}*${wet.toFixed(6)}:c=same`,
    )

  } else {
    // Mirrors createAutoCurve: tube (0–30 %) + tape blends in (40–100 %)
    // DC is cancelled analytically in the tube term (- dcCorr).
    const t = Math.min(1, amount / 0.3)
    const p = Math.max(0, (amount - 0.4) / 0.6)

    const tubeDrive = 1 + amount * 3.25
    const bias      = 0.08 * t
    const tubeWet   = Math.pow(amount, 1.3) * 0.88
    const dc        = Math.tanh(bias * tubeDrive) / tubeDrive
    const tubeBlend = 1 - p * 0.5
    const tapeBlend = p * 0.5

    if (p <= 0) {
      // Only tube path
      const dry = 1 - tubeWet
      filters.push(
        `aeval=val(ch)*${dry.toFixed(6)}+(tanh((val(ch)+${bias.toFixed(6)})*${tubeDrive.toFixed(6)})/${tubeDrive.toFixed(6)}-${dc.toFixed(6)})*${tubeWet.toFixed(6)}:c=same`,
      )
    } else {
      // Tube + tape blend — expand into a single aeval pass
      const tapeDrive    = 1 + p * 3.65
      const tapeWet      = Math.pow(p, 1.3) * 0.80
      const xCoeff       = ((1 - tubeWet) * tubeBlend + (1 - tapeWet) * tapeBlend).toFixed(6)
      const tubeSatCoeff = (tubeWet * tubeBlend).toFixed(6)
      const tapeSatCoeff = (tapeWet * tapeBlend).toFixed(6)
      const dcCorr       = (dc * tubeWet * tubeBlend).toFixed(6)
      const tubeExpr = `tanh((val(ch)+${bias.toFixed(6)})*${tubeDrive.toFixed(6)})/${tubeDrive.toFixed(6)}*${tubeSatCoeff}`
      const tapeExpr = `tanh(val(ch)*${tapeDrive.toFixed(6)})/${tapeDrive.toFixed(6)}*${tapeSatCoeff}`
      filters.push(`aeval=val(ch)*${xCoeff}+${tubeExpr}+${tapeExpr}-${dcCorr}:c=same`)
    }
  }

  // Downsample back to the working sample rate after oversampled processing.
  filters.push(`aresample=${PREVIEW_SAMPLE_RATE}`)
  // Compensate the pre-drive boost — net gain through the exciter block = 0 dB.
  filters.push(`volume=${-DRIVE_BOOST_DB}dB`)
  return filters
}

/**
 * Build a `-filter_complex` graph string that applies a proper dynamic de-esser
 * using FFmpeg's `sidechaincompress` filter.
 *
 * The sidechain signal is a narrow bandpass copy of the audio centred at the
 * detected sibilance frequency (from LTAS analysis).  When the sidechain energy
 * exceeds the threshold, gain is reduced on the main signal.
 *
 * Signal path:
 *   [0:a] → preFilters → asplit → [main] ─────────────────────────────┐
 *                                 [sc_src] → bandpass → [sc]           │
 *                                                   [main][sc] → sidechaincompress
 *                                                              → postFilters → normAndLimit → [out]
 *
 * @param preFilters  FFmpeg filter strings before de-esser (hum, noise, EQ)
 * @param postFilters FFmpeg filter strings after de-esser (compression)
 * @param normAndLimit  Normalisation + limiter chain, or empty string
 * @param params      Processing parameters (provides frequency + amount)
 * @param withMeasurement  If true, appends `ebur128=peak=true` for LUFS measurement
 */
function buildDeEsserFilterComplex(
  preFilters:      string[],
  postFilters:     string[],
  normAndLimit:    string,
  params:          ProcessingParams,
  withMeasurement: boolean,
  compressionFilters: string[] = buildCompressionFilters(params),
): string {
  const freq = Math.round(params.desibilanceFreq)

  // Threshold in linear amplitude (0–1).
  // Maps amount=0.1 → −13.6 dBFS (0.208), amount=1.0 → −28 dBFS (0.040).
  // sidechaincompress threshold range: 0.000976563 to 1.
  const threshDb     = -(12 + params.desibilanceAmount * 16)
  const threshLinear = Math.pow(10, threshDb / 20).toFixed(6)

  // Sidechain gain multiplier: makes the compressor more sensitive to the
  // sidechain signal relative to the main signal.
  const scGain = 1.5

  const parts: string[] = []
  const preChain = preFilters.join(',')
  const compChain = compressionFilters.join(',')

  parts.push(`[0:a]${preChain || `aresample=${PREVIEW_SAMPLE_RATE}`}[pre]`)

  let splitInput = 'pre'
  if (compChain) {
    parts.push(`[pre]${compChain}[comp]`)
    splitInput = 'comp'
  }

  parts.push(`[${splitInput}]asplit=2[main][sc_src]`)

  // Narrow bandpass around the detected sibilance frequency (Q=2.5 covers the
  // full S-band without being so narrow that it misses frequency-spread sibilance).
  parts.push(`[sc_src]bandpass=f=${freq}:width_type=q:width=2.5[sc]`)

  // Dynamic de-esser: 4:1 ratio, 1 ms attack (catches fast S transients),
  // 60 ms release (no pumping between words).
  const scComp = `[main][sc]sidechaincompress=threshold=${threshLinear}:ratio=4:attack=1:release=60:level_sc=${scGain}`

  // Assemble the after-de-esser chain
  const afterFilters: string[] = [...postFilters]
  if (normAndLimit)    afterFilters.push(normAndLimit)
  if (withMeasurement) afterFilters.push('ebur128=peak=true')
  const afterChain = afterFilters.join(',')

  if (afterChain) {
    parts.push(`${scComp}[de]`)
    parts.push(`[de]${afterChain}[out]`)
  } else {
    parts.push(`${scComp}[out]`)
  }

  return parts.join('; ')
}

// ---------------------------------------------------------------------------
// Public API (backward-compatible)
// ---------------------------------------------------------------------------

/**
 * Build the complete signal-processing chain as a simple `-af` string.
 *
 * When de-essing is enabled this uses a static peaking EQ (the fallback path).
 * The dynamic version uses `-filter_complex` and is handled directly in
 * `exportFile`.
 *
 * Exported for tests and the old call-sites that don't need the dynamic path.
 */
export function buildProcessingChain(params: ProcessingParams): string {
  const filters: string[] = [
    ...buildPreDeEsserFilters(params),
    ...buildCompressionFilters(params),
  ]

  if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
    const gain = -(params.desibilanceAmount * 12)
    const freq = Math.round(params.desibilanceFreq)
    filters.push(`equalizer=f=${freq}:width_type=q:width=3:g=${gain.toFixed(1)}`)
  }

  filters.push(...buildPostDeEsserFilters(params))

  return filters.join(',')
}

// ---------------------------------------------------------------------------

/**
 * Encode an AudioBuffer as a 32-bit float WAV (IEEE PCM, format 3).
 * Compatible with FFmpeg's `pcm_f32le` decoder.
 */
function audioBufferToWavBytes(buffer: AudioBuffer): Uint8Array {
  const numChannels = buffer.numberOfChannels
  const sampleRate  = buffer.sampleRate
  const numSamples  = buffer.length
  const bytesPerSample = 4  // float32
  const dataSize    = numChannels * numSamples * bytesPerSample
  const headerSize  = 44
  const wav         = new ArrayBuffer(headerSize + dataSize)
  const view        = new DataView(wav)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)                                    // chunk size
  view.setUint16(20, 3, true)                                     // IEEE float
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true)
  view.setUint16(32, numChannels * bytesPerSample, true)
  view.setUint16(34, 32, true)                                    // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(offset, buffer.getChannelData(ch)[i], true)
      offset += 4
    }
  }
  return new Uint8Array(wav)
}

/**
 * Apply hum removal and EQ correction offline using OfflineAudioContext.
 *
 * This mirrors exactly what AudioEngine does in the preview signal chain so
 * that the RNNoise denoiser receives a spectrally corrected signal in exports —
 * the model was trained on balanced speech and produces artefacts when the
 * input has an abnormal frequency response (e.g. extreme low-mid buildup
 * from a thin or coloured room microphone).
 */
async function applyPreFiltersOffline(
  audioBuffer: AudioBuffer,
  params: ProcessingParams,
): Promise<AudioBuffer> {
  const { numberOfChannels, length, sampleRate } = audioBuffer
  const offCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate)
  const source = offCtx.createBufferSource()
  source.buffer = audioBuffer

  const chain: AudioNode[] = [source]

  // Hum filters — mirrors AudioEngine humFilters
  if (params.humEnabled) {
    if (params.humAutoMode && params.humDetectedFreqs.length > 0) {
      // Auto mode: peaking filter per detected peak, gain scaled by slider
      params.humDetectedFreqs.forEach((peak) => {
        if (!peak.enabled) return
        const f = offCtx.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = peak.frequency
        f.Q.value = peak.q
        f.gain.value = peak.gainDb * params.humAmount
        chain.push(f)
      })
    } else if (!params.humAutoMode && params.humAmount > 0) {
      // Manual mode: 4-band peaking (max -70 dB at fundamental, matching AudioEngine)
      const HUM_HARMONIC_SCALE = [1, 0.7, 0.5, 0.3]
      ;[50, 100, 150, 200].forEach((freq, i) => {
        const f = offCtx.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = freq
        f.Q.value = params.humQ
        f.gain.value = -(params.humAmount * 70) * (HUM_HARMONIC_SCALE[i] ?? 0.3)
        chain.push(f)
      })
    }
  }

  // EQ bands — mirrors AudioEngine eqNodes
  if (params.eqEnabled) {
    params.eqBands.forEach((band) => {
      if (!band.enabled) return
      const gain = band.gain * params.eqIntensity
      const isGainless = band.type === 'highpass' || band.type === 'lowpass'
      if (!isGainless && Math.abs(gain) < 0.1) return
      const f = offCtx.createBiquadFilter()
      f.type = band.type
      f.frequency.value = band.freq
      f.Q.value = band.q
      if (!isGainless) f.gain.value = gain
      chain.push(f)
    })
  }

  for (let i = 0; i < chain.length - 1; i++) {
    chain[i].connect(chain[i + 1])
  }
  chain[chain.length - 1].connect(offCtx.destination)
  source.start()

  return offCtx.startRendering()
}

/**
 * Apply RNNoise speech denoising to every channel of an AudioBuffer.
 *
 * RNNoise operates at 48 kHz natively — no resampling artefacts.
 * Each channel is processed independently through the WASM at full resolution
 * and mixed with the original via `noiseAmount` (0 = dry, 1 = full RNNoise).
 *
 * @returns A new AudioBuffer at the same sample rate / channel count / length.
 */
/** Compiled RNNoise WASM module — loaded once and reused for every export. */
let _rnnoiseModule: WebAssembly.Module | null = null

/**
 * Apply RNNoise speech denoising to every channel of an AudioBuffer.
 *
 * Strategy:
 *  1. Each channel is rendered at 100 % wet through an OfflineAudioContext +
 *     AudioWorklet (exactly the same worklet as the live preview).
 *  2. The pure RNNoise output is then mixed with the original in JavaScript
 *     using sample-accurate latency compensation (delaySamples = latencyMs).
 *
 * This two-stage approach avoids putting a DelayNode in the offline graph
 * (which caused phase-alignment drift at partial mix values) and avoids direct
 * WASM instantiation in the main thread (which can fail when the module has
 * environment-specific imports satisfied only inside the AudioWorklet scope).
 * Channels are processed sequentially to keep resource usage predictable.
 *
 * @returns A new AudioBuffer at the same sample rate / channel count / length.
 */
async function applyRnnoiseDenoising(
  audioBuffer: AudioBuffer,
  noiseAmount: number,
  latencyMs: number,
): Promise<AudioBuffer> {
  if (!_rnnoiseModule) {
    const resp = await fetch('/rnnoise.wasm')
    if (!resp.ok) throw new Error(`rnnoise.wasm fetch failed: ${resp.status}`)
    _rnnoiseModule = await WebAssembly.compile(await resp.arrayBuffer())
  }

  const { numberOfChannels, length, sampleRate } = audioBuffer
  const delaySamples = Math.round(latencyMs * sampleRate / 1000)
  const outputChannels: Float32Array[] = []

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const input = audioBuffer.getChannelData(ch)

    // ── Stage 1: render 100 % denoised output via OfflineAudioContext ──────
    const offCtx = new OfflineAudioContext(1, length, sampleRate)
    await offCtx.audioWorklet.addModule('/rnnoise.worklet.js')

    const chBuf = offCtx.createBuffer(1, length, sampleRate)
    chBuf.copyToChannel(input as Float32Array<ArrayBuffer>, 0)
    const source = offCtx.createBufferSource()
    source.buffer = chBuf

    const rnnoiseNode = new AudioWorkletNode(offCtx, 'rnnoise', {
      channelCountMode: 'explicit',
      channelCount: 1,
      channelInterpretation: 'speakers',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { module: _rnnoiseModule },
    })

    source.connect(rnnoiseNode)
    rnnoiseNode.connect(offCtx.destination)
    source.start()

    const rendered = await offCtx.startRendering()
    const rnOut = rendered.getChannelData(0)

    // ── Stage 2: sample-accurate dry / wet mix ──────────────────────────────
    // rnOut[i] is the denoised version of input[i − delaySamples].
    // Reading rnOut[i + delaySamples] therefore aligns it with input[i].
    const mixed = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const wetIdx = i + delaySamples
      const wet    = wetIdx < length ? rnOut[wetIdx] : 0
      mixed[i]     = wet * noiseAmount + input[i] * (1 - noiseAmount)
    }
    outputChannels.push(mixed)
  }

  // Assemble channels into the output AudioBuffer (no rendering, memory only).
  const assembleCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate)
  const outBuf = assembleCtx.createBuffer(numberOfChannels, length, sampleRate)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    outBuf.copyToChannel(outputChannels[ch] as Float32Array<ArrayBuffer>, ch)
  }
  return outBuf
}

// ---------------------------------------------------------------------------
// LUFS measurement (pass 1)
// ---------------------------------------------------------------------------

/**
 * Parse the integrated loudness (I) from FFmpeg ebur128 log output.
 * The summary section contains a line like: "    I:         -24.3 LUFS"
 */
function parseLUFS(logs: string[]): number | null {
  // Search from the end — the summary appears after processing finishes.
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/^\s*I:\s*(-?\d+\.?\d*)/)
    if (m) return parseFloat(m[1])
  }
  return null
}

/**
 * Pass 1: measure the integrated LUFS of the source signal. The realtime
 * WebAudio preview computes its pre-limiter target gain from the decoded source
 * loudness. Using the same source reference here keeps the export limiter driven
 * like the preview while still letting every processing edit change the signal
 * that reaches the limiter.
 */
async function measureFilteredLUFS(inputName: string, afChain: string): Promise<number | null> {
  const logs = await ffmpegManager.execCaptureLogs([
    '-i', inputName,
    '-af', afChain,
    '-f', 'null', '-',
  ])
  return parseLUFS(logs)
}

async function measureSourceLUFS(inputName: string): Promise<number> {
  const logs = await ffmpegManager.execCaptureLogs([
    '-i', inputName,
    '-af', `aresample=${PREVIEW_SAMPLE_RATE},ebur128=peak=true`,
    '-f', 'null', '-',
  ])

  const lufs = parseLUFS(logs)
  if (lufs !== null) return lufs

  // Fallback: use volumedetect RMS (less accurate but always available).
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/mean_volume:\s*(-?\d+\.?\d*)/)
    if (m) return parseFloat(m[1]) + 3   // rough LUFS ≈ RMS + 3 dB for speech
  }

  return -20 // safe fallback
}

// ---------------------------------------------------------------------------
// Spectral subtraction helper (wraps HumAnalyzer.applySpectralSubtraction)
// ---------------------------------------------------------------------------

/**
 * Apply spectral subtraction to every channel of an AudioBuffer.
 * Returns a new AudioBuffer at the same sample rate / length / channel count.
 */
async function applySpectralSubtractionToBuffer(
  buffer: AudioBuffer,
  noiseProfile: Float32Array,
  alpha: number,
): Promise<AudioBuffer> {
  const offCtx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  )
  const out = offCtx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const inData = buffer.getChannelData(ch).slice() as Float32Array<ArrayBufferLike>
    const cleaned = applySpectralSubtraction(inData, noiseProfile, alpha)
    out.copyToChannel(cleaned as Float32Array<ArrayBuffer>, ch)
  }

  // Return the processed buffer directly (no graph rendering needed)
  return out
}

// ---------------------------------------------------------------------------
// Two-pass export
// ---------------------------------------------------------------------------

/**
 * Two-pass export:
 *
 * 1. Measure integrated LUFS of the source signal (no file written), matching
 *    the realtime preview's pre-limiter gain reference.
 * 2. Apply linear volume gain from that source reference, then run the signal
 *    through `alimiter` (true 1:∞ brick-wall limiter, ceiling −1 dBTP).
 *
 * Unlike `loudnorm` with LRA=11 this approach never dynamically compresses the
 * loudness range. It also keeps the limiter stage consistent with WebAudio
 * monitoring, so EQ moves do not change which limiter behaviour the user hears.
 */
export async function exportFile(
  file: File,
  params: ProcessingParams,
  options: ExportOptions,
  onProgress?: (p: number) => void,
  /** Averaged noise magnitude spectrum from HumAnalyzer – required for spectral subtraction export */
  humNoiseProfile: Float32Array | null = null,
): Promise<Blob> {
  if (!ffmpegManager.isLoaded) await ffmpegManager.load()

  const stamp = Date.now()
  const ext = file.name.split('.').pop() ?? 'wav'
  const outputName = `output_${stamp}.${options.format}`

  // ---- JS-side pre-processing (RNNoise + optional spectral subtraction) ------
  // When noise reduction or spectral subtraction is active we decode the file,
  // run the relevant JS passes, write a 32-bit float WAV to the FFmpeg VFS and
  // set preFiltersApplied so the FFmpeg chain does not re-apply hum/EQ.
  let inputName: string
  let denoisedInputName: string | null = null
  // True when hum + EQ have been baked into the WAV fed to FFmpeg so the
  // FFmpeg filter chain must not apply them a second time.
  let preFiltersApplied = false

  // Spectral subtraction runs automatically whenever a noise profile is active
  const needsSpectralSub =
    params.humEnabled &&
    params.humAutoMode &&
    params.humDetectedFreqs.length > 0 &&
    humNoiseProfile !== null

  const needsJsPrePass = (params.noiseEnabled && params.noiseAmount > 0) || needsSpectralSub

  if (needsJsPrePass) {
    onProgress?.(3)
    const ctx = audioContextManager.context
    if (ctx) {
      try {
        const rawArrayBuffer = await file.arrayBuffer()
        const decoded = await ctx.decodeAudioData(rawArrayBuffer)

        // Apply hum notch filters + EQ offline before RNNoise / spectral subtraction.
        // RNNoise was trained on balanced speech — it produces artefacts
        // when fed audio with an abnormal frequency response.
        let processed = await applyPreFiltersOffline(decoded, params)

        // Phase 4: Spectral subtraction — removes residual broadband hum
        // between the notch-filtered peaks using the captured noise profile.
        if (needsSpectralSub && humNoiseProfile) {
          const alpha = params.humSubtractionAlpha
          processed = await applySpectralSubtractionToBuffer(processed, humNoiseProfile, alpha)
        }

        // RNNoise neural denoising (if enabled)
        if (params.noiseEnabled && params.noiseAmount > 0) {
          processed = await applyRnnoiseDenoising(processed, params.noiseAmount, params.noiseLatencyMs)
        }

        const wavBytes = audioBufferToWavBytes(processed)
        denoisedInputName = `input_denoised_${stamp}.wav`
        await ffmpegManager.writeFile(denoisedInputName, wavBytes)
        inputName = denoisedInputName
        preFiltersApplied = true
      } catch (err) {
        console.warn('[Export pre-pass] processing failed, falling back to original audio:', err)
        inputName = `input_${stamp}.${ext}`
        await ffmpegManager.writeFile(inputName, file)
      }
    } else {
      inputName = `input_${stamp}.${ext}`
      await ffmpegManager.writeFile(inputName, file)
    }
  } else {
    inputName = `input_${stamp}.${ext}`
    await ffmpegManager.writeFile(inputName, file)
  }

  // --- Pass 1: measure loudness references for makeup + target LUFS ---
  onProgress?.(5)
  const measuredLUFS = await measureSourceLUFS(inputName)

  // When a JS pre-pass applied noise reduction, the denoised audio has a
  // lower integrated LUFS (the noise floor is gone).  If we derive the
  // final volume normalisation from the denoised LUFS, FFmpeg applies a
  // larger gain boost and the speech ends up several dB louder than the
  // original export.  Instead we measure the original file's LUFS and use
  // it as the normalization reference so speech level is identical
  // regardless of whether noise reduction is active.
  let normRefLUFS = measuredLUFS
  if (preFiltersApplied && denoisedInputName) {
    const origRefName = `input_lufsref_${stamp}.${ext}`
    await ffmpegManager.writeFile(origRefName, file)
    const origLUFS = await measureSourceLUFS(origRefName)
    normRefLUFS = origLUFS
  }

  // Normalize the input to DYNAMICS_WORKING_LEVEL_LUFS before processing so
  // that the compressor and exciter receive the same signal level as in the
  // Web Audio preview chain (which also normalises to this working level via
  // inputNormalizeGain).  Without this, a loud source (+7 dB above working
  // level) would drive the exciter harder in the export than in the preview,
  // causing audibly different saturation character.
  const inputNormDb = DYNAMICS_WORKING_LEVEL_LUFS - normRefLUFS
  const normVol = Math.abs(inputNormDb) > 0.05
    ? `volume=${inputNormDb.toFixed(3)}dB`
    : null

  const preFilters = buildPreDeEsserFilters(params, preFiltersApplied)
  // Prepend input normalisation so all measurements and the export chain
  // operate at the same working level as the preview.
  const normPreFilters = normVol ? [normVol, ...preFilters] : preFilters
  const preChain = normPreFilters.join(',') || `aresample=${PREVIEW_SAMPLE_RATE}`
  const postEqLUFS = (await measureFilteredLUFS(inputName, `${preChain},ebur128=peak=true`)) ?? measuredLUFS

  // Pass 1: measure LUFS after compression but WITHOUT the exciter.
  // The exciter heavily compresses peaks (up to −10 dB at 100 %), which
  // would make processedLUFS fall sharply, triggering a large positive
  // makeupDb that then undoes the exciter's character in Pass 2.
  // Excluding the exciter here means the gain compensation only accounts
  // for compression; the exciter's sonic character is preserved intact.
  let processedLUFS = postEqLUFS
  if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
    const fc = buildDeEsserFilterComplex(
      normPreFilters,   // includes input normalisation
      [],               // postFilters excluded from measurement
      'ebur128=peak=true',
      params,
      false,
    )
    const logs = await ffmpegManager.execCaptureLogs([
      '-i', inputName,
      '-filter_complex', fc,
      '-map', '[out]',
      '-f', 'null', '-',
    ])
    processedLUFS = parseLUFS(logs) ?? postEqLUFS
  } else {
    const chain = [
      ...normPreFilters,
      ...buildCompressionFilters(params),
      // exciter deliberately excluded — see comment above
      'ebur128=peak=true',
    ].filter(Boolean).join(',')
    processedLUFS = (await measureFilteredLUFS(inputName, chain)) ?? postEqLUFS
  }

  const makeupDb = Math.max(-12, Math.min(12, postEqLUFS - processedLUFS))
  onProgress?.(30)

  const targetLUFS = params.limiterTarget

  // After makeupDb is applied the signal is back at postEqLUFS.
  // gainDb then lifts it from postEqLUFS to targetLUFS — no makeupDb subtraction.
  // (Old formula subtracted makeupDb a second time, making the export
  //  as many dB too quiet as the compression gain-reduction, ~6–10 dB.)
  const gainDb = Math.max(-30, Math.min(30, targetLUFS - postEqLUFS))

  const limitLinear = Math.pow(10, -1 / 20).toFixed(6)
  const normAndLimit = [
    makeupDb !== 0 ? `volume=${makeupDb.toFixed(2)}dB` : null,
    `volume=${gainDb.toFixed(2)}dB`,
    `alimiter=level_in=1:level_out=1:limit=${limitLinear}:attack=5:release=50:asc=1`,
  ].filter(Boolean).join(',')

  // --- Pass 2: export ---
  ffmpegManager.setProgressCallback((p) => {
    // Map FFmpeg's 0–100 onto the 30–100 range (pass 1 took 0–30).
    onProgress?.(30 + Math.round(p * 0.7))
  })

  // Trim: -ss / -to placed before -i for lossless input seeking (frame-accurate for audio)
  const trimArgs: string[] = []
  if (options.trimStart && options.trimStart > 0) {
    trimArgs.push('-ss', options.trimStart.toFixed(3))
  }
  if (options.trimEnd && options.trimEnd > 0) {
    trimArgs.push('-to', options.trimEnd.toFixed(3))
  }

  const args = [
    ...trimArgs,
    '-i', inputName,
    '-ar', String(options.sampleRate),
    '-ac', String(options.channels),
  ]

  if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
    // Dynamic de-esser: build a filter_complex that applies the sidechaincompress
    // de-esser before the normalization + limiter.
    // normPreFilters already includes the input-level normalisation volume filter.
    const postFilters = buildPostDeEsserFilters(params)
    const fc = buildDeEsserFilterComplex(normPreFilters, postFilters, normAndLimit, params, false)
    args.push('-filter_complex', fc, '-map', '[out]')
  } else {
    const comp = buildCompressionFilters(params)
    const post = buildPostDeEsserFilters(params)
    // normPreFilters already includes the input-level normalisation volume filter.
    const fullChain = [...normPreFilters, ...comp, ...post, normAndLimit].filter(Boolean).join(',')
    args.push('-af', fullChain)
  }

  if (options.format === 'mp3') {
    args.push(
      '-c:a', 'libmp3lame',
      '-b:a', QUALITY_BITRATE.mp3[options.quality],
      // Prevent LAME's bitrate-dependent auto low-pass from making exports
      // darker than the realtime Web Audio preview.
      '-cutoff', codecCutoffFor(options.sampleRate),
    )
  } else if (options.format === 'aac' || options.format === 'm4a') {
    args.push(
      '-c:a', 'aac',
      '-b:a', QUALITY_BITRATE.aac[options.quality],
      // FFmpeg's AAC encoder also adapts bandwidth to bitrate by default.
      '-cutoff', codecCutoffFor(options.sampleRate),
    )
  } else if (options.format === 'ogg') {
    args.push('-c:a', 'libvorbis', '-q:a', QUALITY_BITRATE.ogg[options.quality])
  } else if (options.format === 'flac') {
    args.push('-c:a', 'flac')
  } else if (options.format === 'wav') {
    args.push('-c:a', 'pcm_s16le')
  }

  args.push('-y', outputName)

  await ffmpegManager.exec(args)

  const data = await ffmpegManager.readFile(outputName)
  await ffmpegManager.deleteFile(inputName)
  if (denoisedInputName && denoisedInputName !== inputName) {
    await ffmpegManager.deleteFile(denoisedInputName)
  }
  await ffmpegManager.deleteFile(outputName)

  if (data.length === 0) {
    throw new Error('FFmpeg hat eine leere Ausgabedatei erzeugt. Bitte prüfen Sie die Filter-Einstellungen.')
  }

  onProgress?.(100)

  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
    aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg',
  }
  return new Blob([data as unknown as ArrayBuffer], { type: mimeTypes[options.format] ?? 'audio/mpeg' })
}
