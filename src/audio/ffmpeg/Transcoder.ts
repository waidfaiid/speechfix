import { ffmpegManager } from './FFmpegManager'
import { audioContextManager } from '../AudioContextManager'
import type { ProcessingParams, ExportOptions } from '@/types/processing.types'
import type { BiquadFilterType } from '@/types/audio.types'
import { applySpectralSubtraction } from '../analysis/HumAnalyzer'
import { DYNAMICS_WORKING_LEVEL_LUFS } from '../analysis/dynamicsMeter'
import { isIOS, AUDIO_CONTEXT_SAMPLE_RATE, estimateDurationSec, estimateDecodedBytes } from '@/utils/mobileAudio'

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
  // FFmpeg processes audio frame-by-frame (~4096 samples), so the upsampled
  // frames are only ~65 KB in flight at any time — no WASM memory pressure.
  const OVERSAMPLE_RATE = PREVIEW_SAMPLE_RATE * 4 // 192 000 Hz
  filters.push(`aresample=${OVERSAMPLE_RATE}`)

  // FFmpeg's aeval expression evaluator does NOT include tanh() in its
  // built-in function table (only sinh and cosh are present).  We express
  // tanh(x) as sinh(x)/cosh(x), which is mathematically identical.
  // For typical audio signals (|val| ≤ 1, max drive ≈ 4.25) both sinh and
  // cosh stay well within float range, so there is no risk of overflow.

  if (params.exciterMode === 'tube') {
    const drive = 1 + amount * 3.25
    const bias  = 0.08 * amount
    const wet   = Math.pow(amount, 1.3) * 0.88
    const dc    = Math.tanh(bias * drive) / drive
    const dry   = 1 - wet
    // f(x) = x·dry + (tanh((x+bias)·drive)/drive − dc)·wet
    // tanh(u) → sinh(u)/cosh(u)
    const u = `(val(ch)+${bias.toFixed(6)})*${drive.toFixed(6)}`
    filters.push(
      `aeval=val(ch)*${dry.toFixed(6)}+(sinh(${u})/cosh(${u})/${drive.toFixed(6)}-${dc.toFixed(6)})*${wet.toFixed(6)}:c=same`,
    )

  } else if (params.exciterMode === 'tape') {
    const drive = 1 + amount * 3.65
    const wet   = Math.pow(amount, 1.3) * 0.80
    const dry   = 1 - wet
    // f(x) = x·dry + tanh(x·drive)/drive·wet
    const u = `val(ch)*${drive.toFixed(6)}`
    filters.push(
      `aeval=val(ch)*${dry.toFixed(6)}+sinh(${u})/cosh(${u})/${drive.toFixed(6)}*${wet.toFixed(6)}:c=same`,
    )

  } else {
    // Mirrors createAutoCurve: tube (0–30 %) + tape blends in (40–100 %)
    const t = Math.min(1, amount / 0.3)
    const p = Math.max(0, (amount - 0.4) / 0.6)

    const tubeDrive = 1 + amount * 3.25
    const bias      = 0.08 * t
    const tubeWet   = Math.pow(amount, 1.3) * 0.88
    const dc        = Math.tanh(bias * tubeDrive) / tubeDrive
    const tubeBlend = 1 - p * 0.5
    const tapeBlend = p * 0.5

    if (p <= 0) {
      const dry = 1 - tubeWet
      const u = `(val(ch)+${bias.toFixed(6)})*${tubeDrive.toFixed(6)}`
      filters.push(
        `aeval=val(ch)*${dry.toFixed(6)}+(sinh(${u})/cosh(${u})/${tubeDrive.toFixed(6)}-${dc.toFixed(6)})*${tubeWet.toFixed(6)}:c=same`,
      )
    } else {
      const tapeDrive    = 1 + p * 3.65
      const tapeWet      = Math.pow(p, 1.3) * 0.80
      const xCoeff       = ((1 - tubeWet) * tubeBlend + (1 - tapeWet) * tapeBlend).toFixed(6)
      const tubeSatCoeff = (tubeWet * tubeBlend).toFixed(6)
      const tapeSatCoeff = (tapeWet * tapeBlend).toFixed(6)
      const dcCorr       = (dc * tubeWet * tubeBlend).toFixed(6)
      const tubeU = `(val(ch)+${bias.toFixed(6)})*${tubeDrive.toFixed(6)}`
      const tapeU = `val(ch)*${tapeDrive.toFixed(6)}`
      const tubeExpr = `sinh(${tubeU})/cosh(${tubeU})/${tubeDrive.toFixed(6)}*${tubeSatCoeff}`
      const tapeExpr = `sinh(${tapeU})/cosh(${tapeU})/${tapeDrive.toFixed(6)}*${tapeSatCoeff}`
      filters.push(`aeval=val(ch)*${xCoeff}+${tubeExpr}+${tapeExpr}-${dcCorr}:c=same`)
    }
  }

  // Downsample back to working rate and remove the pre-drive boost.
  filters.push(`aresample=${PREVIEW_SAMPLE_RATE}`)
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

  // Process in chunks to keep peak memory bounded on mobile devices.
  // 30 s at 48 kHz ≈ 5.5 MB per OfflineAudioContext instead of the full file.
  const CHUNK_SAMPLES = 30 * sampleRate
  // RNNoise is stateful (GRU hidden state). Feed a 1-second warm-up prefix
  // from the preceding audio so the model reaches steady state before the
  // output region begins — avoids audible quality dips at chunk boundaries.
  const WARMUP_SAMPLES = sampleRate

  const outputChannels: Float32Array[] = []

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const input = audioBuffer.getChannelData(ch)
    const mixed = new Float32Array(length)

    let chunkStart = 0
    while (chunkStart < length) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SAMPLES, length)
      const chunkLen = chunkEnd - chunkStart

      // Warm-up: include preceding samples so RNNoise hidden state is primed.
      const warmupStart = Math.max(0, chunkStart - WARMUP_SAMPLES)
      const warmupLen = chunkStart - warmupStart

      // Extend past chunkEnd by delaySamples so the latency-compensated read
      // never falls outside the rendered buffer (except at the file tail).
      const processEnd = Math.min(chunkEnd + delaySamples, length)
      const totalLen = processEnd - warmupStart

      // ── Render this chunk through RNNoise ──────────────────────────────
      const offCtx = new OfflineAudioContext(1, totalLen, sampleRate)
      await offCtx.audioWorklet.addModule('/rnnoise.worklet.js')

      const chBuf = offCtx.createBuffer(1, totalLen, sampleRate)
      chBuf.getChannelData(0).set(
        input.subarray(warmupStart, processEnd) as Float32Array<ArrayBuffer>,
      )

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

      // ── Dry / wet mix for the output region of this chunk ──────────────
      // rnOut[j] is the denoised version of the input at position j − delaySamples
      // within the chunk. Reading rnOut[warmupLen + i + delaySamples] aligns
      // the denoised sample with input[chunkStart + i].
      for (let i = 0; i < chunkLen; i++) {
        const rnIdx = warmupLen + i + delaySamples
        const wet = rnIdx < totalLen ? rnOut[rnIdx] : 0
        mixed[chunkStart + i] = wet * noiseAmount + input[chunkStart + i] * (1 - noiseAmount)
      }

      chunkStart = chunkEnd

      // Yield to the event loop so the GC can reclaim the OfflineAudioContext
      // and its backing buffers before we allocate the next chunk.
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    outputChannels.push(mixed)
  }

  // Assemble channels into the output AudioBuffer (no rendering, memory only).
  const outBuf = new AudioBuffer({ length, sampleRate, numberOfChannels })
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
 * Measure the integrated LUFS after applying a filter chain.
 * Supports optional -ss/-to args for trimmed measurement.
 */
async function measureFilteredLUFSWithTrim(inputName: string, afChain: string, trimArgs: string[] = [], inputFormatArgs: string[] = []): Promise<number | null> {
  const logs = await ffmpegManager.execCaptureLogs([
    ...inputFormatArgs,
    ...trimArgs,
    '-i', inputName,
    '-af', afChain,
    '-f', 'null', '-',
  ])
  return parseLUFS(logs)
}

/**
 * Measure the integrated LUFS of the source file with optional trim.
 */
async function measureSourceLUFSWithTrim(inputName: string, trimArgs: string[] = [], inputFormatArgs: string[] = []): Promise<number> {
  const logs = await ffmpegManager.execCaptureLogs([
    ...inputFormatArgs,
    ...trimArgs,
    '-i', inputName,
    '-af', `aresample=${PREVIEW_SAMPLE_RATE},ebur128=peak=true`,
    '-f', 'null', '-',
  ])

  const lufs = parseLUFS(logs)
  if (lufs !== null) return lufs

  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/mean_volume:\s*(-?\d+\.?\d*)/)
    if (m) return parseFloat(m[1]) + 3
  }

  return -20
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
 * Structured progress reporting for granular UI feedback.
 * Each step gets a label and proportional weight so the progress bar moves
 * smoothly and predictably.
 */
interface ExportStep {
  label: string
  weight: number
}

function buildExportSteps(params: ProcessingParams, needsJsPrePass: boolean, preFiltersApplied: boolean): ExportStep[] {
  const steps: ExportStep[] = []

  if (needsJsPrePass) {
    steps.push({ label: 'Audio dekodieren & trimmen…', weight: 5 })
    if (params.humEnabled || params.eqEnabled) {
      steps.push({ label: 'Hum/EQ offline anwenden…', weight: 8 })
    }
    if (params.humEnabled && params.humAutoMode && params.humDetectedFreqs.length > 0) {
      steps.push({ label: 'Spektrale Subtraktion…', weight: 10 })
    }
    if (params.noiseEnabled && params.noiseAmount > 0) {
      steps.push({ label: 'Rauschunterdrückung (RNNoise)…', weight: 25 })
    }
    steps.push({ label: 'Denoised Audio schreiben…', weight: 3 })
  } else {
    steps.push({ label: 'Audio vorbereiten…', weight: 3 })
  }

  steps.push({ label: 'Lautheit messen…', weight: 15 })

  const needsCompression = params.compressionEnabled && params.compressionAmount > 0
  const needsDeEsser = params.desibilanceEnabled && params.desibilanceAmount > 0
  if (needsCompression || needsDeEsser) {
    steps.push({ label: 'Dynamik analysieren…', weight: 15 })
  }

  steps.push({ label: 'Exportieren & Limiter…', weight: 50 })
  steps.push({ label: 'Wird abgeschlossen…', weight: 2 })

  return steps
}

class StepProgressReporter {
  private steps: ExportStep[]
  private totalWeight: number
  private completedWeight = 0
  private currentStepIdx = 0
  private onProgress: (p: number) => void

  constructor(steps: ExportStep[], onProgress: (p: number) => void) {
    this.steps = steps
    this.totalWeight = steps.reduce((sum, s) => sum + s.weight, 0)
    this.onProgress = onProgress
  }

  get currentLabel(): string {
    return this.steps[this.currentStepIdx]?.label ?? 'Wird verarbeitet…'
  }

  /** Report intra-step progress (0–1) */
  reportSubProgress(fraction: number): void {
    const step = this.steps[this.currentStepIdx]
    if (!step) return
    const pct = ((this.completedWeight + step.weight * Math.min(1, fraction)) / this.totalWeight) * 100
    this.onProgress(Math.round(Math.min(99, pct)))
  }

  /** Mark the current step as done and advance to the next. */
  completeStep(): void {
    const step = this.steps[this.currentStepIdx]
    if (step) this.completedWeight += step.weight
    this.currentStepIdx++
    const pct = (this.completedWeight / this.totalWeight) * 100
    this.onProgress(Math.round(Math.min(99, pct)))
  }

  finish(): void {
    this.onProgress(100)
  }
}

// ---------------------------------------------------------------------------
// Chunked pre-pass for large files on iOS
// ---------------------------------------------------------------------------

/**
 * Memory-bounded pre-pass for iOS: decodes, filters, and denoises audio in
 * 2-minute chunks, encoding each to FLAC in FFmpeg's virtual FS. A concat
 * list file is created so subsequent FFmpeg calls (LUFS measurement, final
 * encode) can stream through the chunks without holding everything in memory.
 *
 * Peak WASM FS: source file + one raw chunk (~23 MB) + accumulated FLAC
 * chunks (~5-8 MB each). Peak JS: one 2-min AudioBuffer (~23 MB) + RNNoise
 * processing buffers. Total stays well under 200 MB even for hour-long files.
 */
async function chunkedPrePass(
  file: File,
  params: ProcessingParams,
  trimStart: number | undefined,
  trimEnd: number | undefined,
  stamp: number,
  humNoiseProfile: Float32Array | null,
): Promise<{ concatListName: string, chunkNames: string[], inputFormatArgs: string[] }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'mp3'
  const srcName = `exp_src_${stamp}.${ext}`
  const sampleRate = AUDIO_CONTEXT_SAMPLE_RATE
  const CHUNK_SEC = 120

  await ffmpegManager.writeFile(srcName, file)

  const needsRnnoise = params.noiseEnabled && params.noiseAmount > 0
  const needsPreFilters = params.humEnabled || params.eqEnabled
  const needsSpectralSub =
    params.humEnabled &&
    params.humAutoMode &&
    params.humDetectedFreqs.length > 0 &&
    humNoiseProfile !== null

  const chunkNames: string[] = []
  let chunkIdx = 0
  const effectiveStart = trimStart ?? 0

  for (let startSec = effectiveStart; ; startSec += CHUNK_SEC) {
    // Respect trim end
    if (trimEnd != null && startSec >= trimEnd) break
    const duration = trimEnd != null
      ? Math.min(CHUNK_SEC, trimEnd - startSec)
      : CHUNK_SEC

    // ── Decode this chunk via FFmpeg ────────────────────────────────────
    const rawChunkName = `exp_raw_${stamp}_${chunkIdx}.f32le`
    await ffmpegManager.exec([
      '-ss', String(startSec),
      '-t', String(duration),
      '-i', srcName,
      '-ac', '1', '-ar', String(sampleRate),
      '-f', 'f32le', '-y', rawChunkName,
    ])

    const raw = await ffmpegManager.readFile(rawChunkName)
    await ffmpegManager.deleteFile(rawChunkName)

    if (raw.length === 0) break

    const sampleCount = Math.floor(raw.length / 4)

    // ── Copy into AudioBuffer ──────────────────────────────────────────
    const samples = new Float32Array(raw.buffer, (raw as Uint8Array).byteOffset, sampleCount)
    let buffer = new AudioBuffer({ length: sampleCount, sampleRate, numberOfChannels: 1 })
    buffer.copyToChannel(samples.slice() as Float32Array<ArrayBuffer>, 0)

    // ── Apply pre-filters (hum/EQ) ────────────────────────────────────
    if (needsPreFilters) {
      buffer = await applyPreFiltersOffline(buffer, params)
    }

    // ── Spectral subtraction ──────────────────────────────────────────
    if (needsSpectralSub && humNoiseProfile) {
      buffer = await applySpectralSubtractionToBuffer(buffer, humNoiseProfile, params.humSubtractionAlpha)
    }

    // ── RNNoise denoising ─────────────────────────────────────────────
    if (needsRnnoise) {
      buffer = await applyRnnoiseDenoising(buffer, params.noiseAmount, params.noiseLatencyMs)
    }

    // ── Encode processed chunk to FLAC in WASM FS ─────────────────────
    const procRawName = `exp_proc_${stamp}_${chunkIdx}.f32le`
    const channelData = buffer.getChannelData(0)
    await ffmpegManager.writeFile(procRawName, new Uint8Array(
      channelData.buffer, channelData.byteOffset, channelData.byteLength,
    ))

    const flacName = `exp_flac_${stamp}_${chunkIdx}.flac`
    await ffmpegManager.exec([
      '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1',
      '-i', procRawName,
      '-c:a', 'flac', '-y', flacName,
    ])
    await ffmpegManager.deleteFile(procRawName)
    chunkNames.push(flacName)
    chunkIdx++

    // End of file: chunk shorter than expected
    if (sampleCount < duration * sampleRate * 0.95) break

    // Yield for GC to reclaim AudioBuffer + raw bytes
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  // Free original file from WASM FS
  await ffmpegManager.deleteFile(srcName)

  // Create concat demuxer list — subsequent FFmpeg calls use this as input
  const listContent = chunkNames.map(n => `file '${n}'`).join('\n')
  const concatListName = `exp_concat_${stamp}.txt`
  await ffmpegManager.writeFile(concatListName, new TextEncoder().encode(listContent))

  return {
    concatListName,
    chunkNames,
    inputFormatArgs: ['-f', 'concat', '-safe', '0'],
  }
}

/**
 * Decode a file via FFmpeg at the given sample rate, returning a mono AudioBuffer.
 * Used for the export pre-pass on iOS where ctx.decodeAudioData can OOM on large files.
 */
async function decodeViaFfmpegForExport(file: File, sampleRate: number): Promise<AudioBuffer> {
  const stamp = Date.now()
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'mp3'
  const inputName = `exp_dec_in_${stamp}.${ext}`
  const outputName = `exp_dec_out_${stamp}.f32le`

  await ffmpegManager.writeFile(inputName, file)
  await ffmpegManager.exec([
    '-i', inputName,
    '-ac', '1',
    '-ar', String(sampleRate),
    '-f', 'f32le',
    outputName,
  ])

  // Free input from WASM FS immediately — only the decoded output is needed.
  await ffmpegManager.deleteFile(inputName)
  let raw: Uint8Array | undefined = await ffmpegManager.readFile(outputName)

  // Free decoded output from WASM FS — data is now in JS.
  await ffmpegManager.deleteFile(outputName)

  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
  raw = undefined
  const sampleCount = Math.floor(bytes.byteLength / 4)

  // AudioBuffer constructor avoids the ~N×4 byte internal allocation that
  // OfflineAudioContext would make just to serve as a createBuffer() factory.
  const buffer = new AudioBuffer({ length: sampleCount, sampleRate, numberOfChannels: 1 })

  // Direct Float32Array view on the raw bytes — same endianness (LE on ARM/x86).
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, sampleCount)
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)

  // Let GC reclaim the raw byte array before the caller allocates more.
  await new Promise(resolve => setTimeout(resolve, 0))

  return buffer
}

/**
 * Trim an AudioBuffer to a sub-region [startSec, endSec].
 * Returns the original buffer if no trimming is needed.
 */
function trimAudioBuffer(buffer: AudioBuffer, startSec: number, endSec: number | undefined): AudioBuffer {
  const sr = buffer.sampleRate
  const startSample = Math.max(0, Math.round(startSec * sr))
  const endSample = endSec != null ? Math.min(buffer.length, Math.round(endSec * sr)) : buffer.length
  if (startSample === 0 && endSample >= buffer.length) return buffer

  const trimmedLength = endSample - startSample
  if (trimmedLength <= 0) return buffer

  const out = new AudioBuffer({ length: trimmedLength, sampleRate: sr, numberOfChannels: buffer.numberOfChannels })
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(
      buffer.getChannelData(ch).subarray(startSample, endSample) as Float32Array<ArrayBuffer>,
      ch,
    )
  }
  return out
}

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

  // --- Determine which processing modules are actually active ---
  const needsCompression = params.compressionEnabled && params.compressionAmount > 0
  const needsDeEsser = params.desibilanceEnabled && params.desibilanceAmount > 0
  const needsExciter = params.exciterEnabled && params.exciterAmount > 0
  const needsSpectralSub =
    params.humEnabled &&
    params.humAutoMode &&
    params.humDetectedFreqs.length > 0 &&
    humNoiseProfile !== null
  const needsRnnoise = params.noiseEnabled && params.noiseAmount > 0
  const needsJsPrePass = needsRnnoise || needsSpectralSub

  // Trimming: apply early so all processing only touches the exported region
  const hasTrim = (options.trimStart != null && options.trimStart > 0) ||
    (options.trimEnd != null && options.trimEnd > 0)

  // --- Build structured progress steps ---
  const steps = buildExportSteps(params, needsJsPrePass, false)
  const noopReport = { reportSubProgress: () => {}, completeStep: () => {}, finish: () => {}, get currentLabel() { return '' } }
  const reporter = onProgress
    ? new StepProgressReporter(steps, onProgress)
    : noopReport as unknown as StepProgressReporter

  // ---- JS-side pre-processing (RNNoise + optional spectral subtraction) ------
  let inputName: string
  let denoisedInputName: string | null = null
  let preFiltersApplied = false
  // When the denoised audio is written as raw f32le or uses a concat demuxer,
  // FFmpeg needs explicit format args before -i.
  let inputFormatArgs: string[] = []
  // FLAC chunk filenames to clean up after export (chunked path only)
  let chunkCleanupNames: string[] = []
  let concatListCleanup: string | null = null

  // On iOS, large files cannot be decoded to raw PCM in one shot — WASM
  // linear memory cannot hold the full decoded output. Use the chunked
  // pipeline that processes 2-minute segments independently.
  const estimatedDecoded = estimateDecodedBytes(estimateDurationSec(file), AUDIO_CONTEXT_SAMPLE_RATE, 1)
  const useChunked = isIOS() && needsJsPrePass && estimatedDecoded > 100 * 1024 * 1024

  if (useChunked) {
    reporter.reportSubProgress(0)
    try {
      const result = await chunkedPrePass(
        file, params,
        hasTrim && options.trimStart && options.trimStart > 0 ? options.trimStart : undefined,
        hasTrim && options.trimEnd && options.trimEnd > 0 ? options.trimEnd : undefined,
        stamp, humNoiseProfile,
      )
      inputName = result.concatListName
      inputFormatArgs = result.inputFormatArgs
      chunkCleanupNames = result.chunkNames
      concatListCleanup = result.concatListName
      preFiltersApplied = true
      // Consume all pre-pass progress steps
      reporter.completeStep()
    } catch (err) {
      console.warn('[Chunked pre-pass] failed, falling back to original audio:', err)
      inputName = `input_${stamp}.${ext}`
      await ffmpegManager.writeFile(inputName, file)
      reporter.completeStep()
    }
  } else if (needsJsPrePass) {
    reporter.reportSubProgress(0)
    const ctx = audioContextManager.context
    if (ctx) {
      try {
        // On iOS, use FFmpeg to decode at 48 kHz to avoid Safari OOM from
        // decodeAudioData on large files while ensuring RNNoise gets 48 kHz input.
        let decoded: AudioBuffer
        if (isIOS()) {
          decoded = await decodeViaFfmpegForExport(file, AUDIO_CONTEXT_SAMPLE_RATE)
        } else {
          const rawArrayBuffer = await file.arrayBuffer()
          decoded = await ctx.decodeAudioData(rawArrayBuffer)
        }

        // Trim EARLY so RNNoise only processes the exported region
        if (hasTrim) {
          decoded = trimAudioBuffer(decoded, options.trimStart ?? 0, options.trimEnd)
        }
        reporter.completeStep() // "Audio dekodieren & trimmen"

        // Apply hum notch filters + EQ offline before RNNoise
        let processed: AudioBuffer
        if (params.humEnabled || params.eqEnabled) {
          processed = await applyPreFiltersOffline(decoded, params)
          reporter.completeStep() // "Hum/EQ offline anwenden"
        } else {
          processed = decoded
        }
        decoded = null!
        await new Promise(resolve => setTimeout(resolve, 0))

        // Spectral subtraction
        if (needsSpectralSub && humNoiseProfile) {
          const alpha = params.humSubtractionAlpha
          processed = await applySpectralSubtractionToBuffer(processed, humNoiseProfile, alpha)
          reporter.completeStep() // "Spektrale Subtraktion"
        }

        // RNNoise neural denoising (if enabled)
        if (needsRnnoise) {
          processed = await applyRnnoiseDenoising(processed, params.noiseAmount, params.noiseLatencyMs)
          reporter.completeStep() // "Rauschunterdrückung"
        }

        // Write processed audio to FFmpeg FS.
        if (processed.numberOfChannels === 1) {
          const channelData = processed.getChannelData(0)
          const pcmBytes = new Uint8Array(
            channelData.buffer, channelData.byteOffset, channelData.byteLength,
          )
          denoisedInputName = `input_denoised_${stamp}.f32le`
          await ffmpegManager.writeFile(denoisedInputName, pcmBytes)
          inputFormatArgs = ['-f', 'f32le', '-ar', String(processed.sampleRate), '-ac', '1']
        } else {
          const wavBytes = audioBufferToWavBytes(processed)
          denoisedInputName = `input_denoised_${stamp}.wav`
          await ffmpegManager.writeFile(denoisedInputName, wavBytes)
        }
        inputName = denoisedInputName
        preFiltersApplied = true
        processed = null!
        await new Promise(resolve => setTimeout(resolve, 0))
        reporter.completeStep() // "Denoised Audio schreiben"
      } catch (err) {
        console.warn('[Export pre-pass] processing failed, falling back to original audio:', err)
        inputName = `input_${stamp}.${ext}`
        await ffmpegManager.writeFile(inputName, file)
        reporter.completeStep()
      }
    } else {
      inputName = `input_${stamp}.${ext}`
      await ffmpegManager.writeFile(inputName, file)
      reporter.completeStep()
    }
  } else {
    inputName = `input_${stamp}.${ext}`
    await ffmpegManager.writeFile(inputName, file)
    reporter.completeStep() // "Audio vorbereiten"
  }

  // --- Pass 1: measure loudness references for makeup + target LUFS ---
  // When trim is active and we did NOT do a JS pre-pass, we trim the input
  // file for measurement via FFmpeg's -ss/-to so measurements reflect the
  // actual exported region. When JS pre-pass ran, the buffer is already trimmed.
  const measureTrimArgs: string[] = []
  if (hasTrim && !preFiltersApplied) {
    if (options.trimStart && options.trimStart > 0) measureTrimArgs.push('-ss', options.trimStart.toFixed(3))
    if (options.trimEnd && options.trimEnd > 0) measureTrimArgs.push('-to', options.trimEnd.toFixed(3))
  }

  const measuredLUFS = await measureSourceLUFSWithTrim(inputName, measureTrimArgs, inputFormatArgs)

  // When JS pre-pass was used, the denoised audio is quieter. Use original
  // file's LUFS as the normalisation reference so speech level stays consistent.
  let normRefLUFS = measuredLUFS
  if (preFiltersApplied) {
    const origRefName = `input_lufsref_${stamp}.${ext}`
    await ffmpegManager.writeFile(origRefName, file)
    const origMeasureTrim: string[] = []
    if (hasTrim) {
      if (options.trimStart && options.trimStart > 0) origMeasureTrim.push('-ss', options.trimStart.toFixed(3))
      if (options.trimEnd && options.trimEnd > 0) origMeasureTrim.push('-to', options.trimEnd.toFixed(3))
    }
    normRefLUFS = await measureSourceLUFSWithTrim(origRefName, origMeasureTrim)
    await ffmpegManager.deleteFile(origRefName)
  }

  reporter.completeStep() // "Lautheit messen"

  // Normalize input to working level (matches preview's inputNormalizeGain)
  const inputNormDb = DYNAMICS_WORKING_LEVEL_LUFS - normRefLUFS
  const normVol = Math.abs(inputNormDb) > 0.05
    ? `volume=${inputNormDb.toFixed(3)}dB`
    : null

  const preFilters = buildPreDeEsserFilters(params, preFiltersApplied)
  const normPreFilters = normVol ? [normVol, ...preFilters] : preFilters
  const preChain = normPreFilters.join(',') || `aresample=${PREVIEW_SAMPLE_RATE}`

  // Measure postEQ LUFS — only if hum/EQ are applied via FFmpeg (not pre-baked)
  let postEqLUFS: number
  if (!preFiltersApplied && (params.humEnabled || params.eqEnabled)) {
    postEqLUFS = (await measureFilteredLUFSWithTrim(inputName, `${preChain},ebur128=peak=true`, measureTrimArgs, inputFormatArgs)) ?? measuredLUFS
  } else {
    postEqLUFS = measuredLUFS
  }

  // Measure processedLUFS ONLY when compression or de-esser are active
  // (these are the only modules that change integrated loudness significantly).
  let processedLUFS = postEqLUFS
  if (needsCompression || needsDeEsser) {
    if (needsDeEsser) {
      const fc = buildDeEsserFilterComplex(
        normPreFilters,
        [],
        'ebur128=peak=true',
        params,
        false,
      )
      const logs = await ffmpegManager.execCaptureLogs([
        ...inputFormatArgs,
        ...measureTrimArgs,
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
        'ebur128=peak=true',
      ].filter(Boolean).join(',')
      processedLUFS = (await measureFilteredLUFSWithTrim(inputName, chain, measureTrimArgs, inputFormatArgs)) ?? postEqLUFS
    }
    reporter.completeStep() // "Dynamik analysieren"
  }

  const makeupDb = Math.max(-12, Math.min(12, postEqLUFS - processedLUFS))
  const targetLUFS = params.limiterTarget
  const gainDb = Math.max(-30, Math.min(30, targetLUFS - postEqLUFS))

  const limitLinear = Math.pow(10, -1 / 20).toFixed(6)
  const normAndLimit = [
    makeupDb !== 0 ? `volume=${makeupDb.toFixed(2)}dB` : null,
    `volume=${gainDb.toFixed(2)}dB`,
    params.limiterEnabled
      ? `alimiter=level_in=1:level_out=1:limit=${limitLinear}:attack=5:release=50:asc=1`
      : null,
  ].filter(Boolean).join(',')

  // --- Pass 2: export ---
  ffmpegManager.setProgressCallback((p) => {
    reporter.reportSubProgress(p / 100)
  })

  // When JS pre-pass already trimmed the buffer, don't trim again in FFmpeg.
  // When no pre-pass, apply trim args to the final encode.
  const encodeTrimArgs: string[] = (hasTrim && !preFiltersApplied) ? measureTrimArgs : []

  const args = [
    ...inputFormatArgs,
    ...encodeTrimArgs,
    '-i', inputName,
    '-ar', String(options.sampleRate),
    '-ac', String(options.channels),
  ]

  if (needsDeEsser) {
    const postFilters = needsExciter ? buildPostDeEsserFilters(params) : []
    const compressionFilters = needsCompression ? buildCompressionFilters(params) : []
    const fc = buildDeEsserFilterComplex(normPreFilters, postFilters, normAndLimit, params, false, compressionFilters)
    args.push('-filter_complex', fc, '-map', '[out]')
  } else {
    const comp = needsCompression ? buildCompressionFilters(params) : []
    const post = needsExciter ? buildPostDeEsserFilters(params) : []
    const fullChain = [...normPreFilters, ...comp, ...post, normAndLimit].filter(Boolean).join(',')
    args.push('-af', fullChain)
  }

  if (options.format === 'mp3') {
    args.push(
      '-c:a', 'libmp3lame',
      '-b:a', QUALITY_BITRATE.mp3[options.quality],
      '-cutoff', codecCutoffFor(options.sampleRate),
    )
  } else if (options.format === 'aac' || options.format === 'm4a') {
    args.push(
      '-c:a', 'aac',
      '-b:a', QUALITY_BITRATE.aac[options.quality],
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
  reporter.completeStep() // "Exportieren & Limiter"

  const data = await ffmpegManager.readFile(outputName)
  await ffmpegManager.deleteFile(inputName)
  if (denoisedInputName && denoisedInputName !== inputName) {
    await ffmpegManager.deleteFile(denoisedInputName)
  }
  // Clean up FLAC chunks and concat list from chunked pre-pass
  for (const name of chunkCleanupNames) {
    await ffmpegManager.deleteFile(name)
  }
  if (concatListCleanup && concatListCleanup !== inputName) {
    await ffmpegManager.deleteFile(concatListCleanup)
  }
  await ffmpegManager.deleteFile(outputName)

  ffmpegManager.setProgressCallback(null)

  if (data.length === 0) {
    throw new Error('FFmpeg hat eine leere Ausgabedatei erzeugt. Bitte prüfen Sie die Filter-Einstellungen.')
  }

  reporter.completeStep() // "Wird abgeschlossen"
  reporter.finish()

  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
    aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg',
  }
  return new Blob([data as unknown as ArrayBuffer], { type: mimeTypes[options.format] ?? 'audio/mpeg' })
}
