import { ffmpegManager } from './FFmpegManager'
import type { ProcessingParams, ExportOptions } from '@/types/processing.types'

const QUALITY_BITRATE: Record<string, Record<string, string>> = {
  mp3:  { low: '96k',  medium: '192k', high: '320k',  lossless: '320k' },
  aac:  { low: '96k',  medium: '192k', high: '256k',  lossless: '256k' },
  ogg:  { low: '3',    medium: '6',    high: '9',     lossless: '9' },
  flac: { low: '0',    medium: '0',    high: '0',     lossless: '0' },
  wav:  { low: '0',    medium: '0',    high: '0',     lossless: '0' },
  m4a:  { low: '96k',  medium: '192k', high: '256k',  lossless: '256k' },
}

// ---------------------------------------------------------------------------
// Internal chain builders
// ---------------------------------------------------------------------------

/**
 * Filters applied BEFORE the de-esser: hum removal, noise reduction,
 * high-pass, and tonal EQ correction.
 */
function buildPreDeEsserFilters(params: ProcessingParams): string[] {
  const filters: string[] = []

  if (params.humEnabled && params.humAmount > 0) {
    const g = -(params.humAmount * 20)
    const q = params.humQ
    filters.push(`equalizer=f=50:width_type=q:width=${q}:g=${g.toFixed(1)}`)
    filters.push(`equalizer=f=100:width_type=q:width=${q}:g=${(g * 0.7).toFixed(1)}`)
    filters.push(`equalizer=f=150:width_type=q:width=${q}:g=${(g * 0.5).toFixed(1)}`)
    filters.push(`equalizer=f=200:width_type=q:width=${q}:g=${(g * 0.3).toFixed(1)}`)
  }

  if (params.noiseEnabled && params.noiseAmount > 0) {
    const nf = -(20 + params.noiseAmount * 30)
    filters.push(`afftdn=nf=${nf.toFixed(0)}`)
  }

  // High-pass always on
  filters.push('highpass=f=80')

  if (params.eqEnabled) {
    params.eqBands.forEach((band) => {
      if (!band.enabled) return
      const gain = band.gain * params.eqIntensity

      if (band.type === 'highpass') {
        // Mirrors EQ node[i] in AudioEngine which is set to type='highpass'.
        // noiseHP (80 Hz, Q=0.7) is already in the chain; this adds the user-
        // adjustable HP band on top, exactly as the Web Audio graph does.
        filters.push(`highpass=f=${band.freq}:width_type=q:width=${band.q.toFixed(2)}`)
        return
      }
      if (band.type === 'lowpass') {
        filters.push(`lowpass=f=${band.freq}:width_type=q:width=${band.q.toFixed(2)}`)
        return
      }
      if (Math.abs(gain) < 0.1) return
      if (band.type === 'highshelf') {
        // Web Audio BiquadFilterNode highshelf ignores Q — use S=1 (Butterworth slope)
        filters.push(`treble=f=${band.freq}:g=${gain.toFixed(1)}:width_type=s:width=1`)
      } else if (band.type === 'lowshelf') {
        // Web Audio BiquadFilterNode lowshelf ignores Q — use S=1 (Butterworth slope)
        filters.push(`bass=f=${band.freq}:g=${gain.toFixed(1)}:width_type=s:width=1`)
      } else {
        // Peaking: width_type=q uses Q factor (dimensionless), matching Web Audio Q
        filters.push(`equalizer=f=${band.freq}:width_type=q:width=${band.q.toFixed(2)}:g=${gain.toFixed(1)}`)
      }
    })
  }

  return filters
}

/**
 * Filters applied AFTER the de-esser: dynamics compression and harmonic exciter.
 */
function buildPostDeEsserFilters(params: ProcessingParams): string[] {
  const filters: string[] = []

  if (params.compressionEnabled && params.compressionAmount > 0) {
    // Mirror AudioEngine.ts exactly: threshold -12→-36 dB, ratio 1:1→6:1
    const threshold = -12 - params.compressionAmount * 24
    const ratio = (1 + params.compressionAmount * 5).toFixed(1)
    // attack/release match AudioEngine: 0.015 s = 15 ms, 0.15 s = 150 ms, knee = 8 dB
    filters.push(`acompressor=threshold=${threshold.toFixed(1)}dB:ratio=${ratio}:attack=15:release=150:knee=8`)
  }

  // Exciter: tanh waveshaping — mirrors AudioEngine.ts WaveShaper (after compressor)
  if (params.exciterEnabled && params.exciterAmount > 0) {
    if (params.exciterMode === 'warmth') {
      // createWarmthCurve: drive = 1 + (amount*0.5)*1.5; out = 0.9*tanh(x*drive)/tanh(drive) + 0.1*x
      // val(ch) is the sample for the current channel — correct for mono and stereo
      const drive = (1 + params.exciterAmount * 0.5 * 1.5).toFixed(4)
      const tanhDrive = Math.tanh(parseFloat(drive)).toFixed(6)
      filters.push(`aeval=0.9*tanh(val(ch)*${drive})/${tanhDrive}+0.1*val(ch):c=same`)
    } else {
      // createSoftClipCurve (brilliance): drive = 1 + (amount*0.4)*3; out = tanh(x*drive)/tanh(drive)
      const drive = (1 + params.exciterAmount * 0.4 * 3).toFixed(4)
      const tanhDrive = Math.tanh(parseFloat(drive)).toFixed(6)
      filters.push(`aeval=tanh(val(ch)*${drive})/${tanhDrive}:c=same`)
    }
  }

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

  if (preChain) {
    parts.push(`[0:a]${preChain}[pre]`)
    parts.push(`[pre]asplit=2[main][sc_src]`)
  } else {
    parts.push(`[0:a]asplit=2[main][sc_src]`)
  }

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
 * `measureProcessedLUFS` / `exportFile`.
 *
 * Exported for tests and the old call-sites that don't need the dynamic path.
 */
export function buildProcessingChain(params: ProcessingParams): string {
  const filters: string[] = [
    ...buildPreDeEsserFilters(params),
  ]

  if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
    // Static fallback de-esser: narrow peaking cut at the detected frequency.
    // Max cut increased to −12 dB; Q=3 is wide enough to cover the full S band.
    const gain = -(params.desibilanceAmount * 12)
    const freq = Math.round(params.desibilanceFreq)
    filters.push(`equalizer=f=${freq}:width_type=q:width=3:g=${gain.toFixed(1)}`)
  }

  filters.push(...buildPostDeEsserFilters(params))

  return filters.join(',')
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
 * Pass 1: measure the integrated LUFS of the processed (but not yet normalised)
 * signal.  When de-essing is enabled this uses a `-filter_complex` graph so that
 * the dynamic de-esser is included in the measurement, ensuring the normalization
 * gain computed in the caller is accurate.
 */
async function measureProcessedLUFS(
  inputName: string,
  params:    ProcessingParams,
): Promise<number> {
  const preFilters  = buildPreDeEsserFilters(params)
  const postFilters = buildPostDeEsserFilters(params)

  let logs: string[]

  if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
    // Dynamic de-esser path: sidechaincompress requires filter_complex.
    const fc = buildDeEsserFilterComplex(preFilters, postFilters, '', params, true)
    logs = await ffmpegManager.execCaptureLogs([
      '-i', inputName,
      '-filter_complex', fc,
      '-map', '[out]',
      '-f', 'null', '-',
    ])
  } else {
    // Simple -af path (no de-esser or de-esser disabled).
    const chain = [...preFilters, ...postFilters, 'ebur128=peak=true']
      .filter(Boolean)
      .join(',')
    logs = await ffmpegManager.execCaptureLogs([
      '-i', inputName,
      '-af', chain,
      '-f', 'null', '-',
    ])
  }

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
// Two-pass export
// ---------------------------------------------------------------------------

/**
 * Two-pass export:
 *
 * 1. Measure integrated LUFS of the processed signal (no file written).
 *    When de-essing is enabled the measurement uses the dynamic sidechaincompress
 *    path so that the normalization gain is accurate.
 * 2. Apply linear volume gain so the output hits `targetLUFS`, then run the
 *    signal through `alimiter` (true 1:∞ brick-wall limiter, ceiling −1 dBTP).
 *
 * Unlike `loudnorm` with LRA=11 this approach never dynamically compresses
 * the loudness range — noise and speech are boosted by the same linear gain,
 * and only the very sharpest transients are caught by the true limiter.
 */
export async function exportFile(
  file: File,
  params: ProcessingParams,
  options: ExportOptions,
  onProgress?: (p: number) => void,
): Promise<Blob> {
  if (!ffmpegManager.isLoaded) await ffmpegManager.load()

  const ext = file.name.split('.').pop() ?? 'wav'
  const inputName  = `input_${Date.now()}.${ext}`
  const outputName = `output_${Date.now()}.${options.format}`

  await ffmpegManager.writeFile(inputName, file)

  // --- Pass 1: measure ---
  onProgress?.(5)
  const measuredLUFS = await measureProcessedLUFS(inputName, params)
  onProgress?.(30)

  // Compute the linear gain needed to reach the target.
  // Clamp to ±30 dB so a pathologically quiet/loud file doesn't explode.
  const targetLUFS = params.limiterTarget
  const gainDb = Math.max(-30, Math.min(30, targetLUFS - measuredLUFS))

  // True brick-wall limiter ceiling: −1 dBTP
  const limitLinear = Math.pow(10, -1 / 20).toFixed(6)   // 0.891251
  const normAndLimit = `volume=${gainDb.toFixed(2)}dB,alimiter=level_in=1:level_out=1:limit=${limitLinear}:attack=5:release=50:asc=1`

  // --- Pass 2: export ---
  ffmpegManager.setProgressCallback((p) => {
    // Map FFmpeg's 0–100 onto the 30–100 range (pass 1 took 0–30).
    onProgress?.(30 + Math.round(p * 0.7))
  })

  const args = [
    '-i', inputName,
    '-ar', String(options.sampleRate),
    '-ac', String(options.channels),
  ]

  if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
    // Dynamic de-esser: build a filter_complex that applies the sidechaincompress
    // de-esser before the normalization + limiter.
    const preFilters  = buildPreDeEsserFilters(params)
    const postFilters = buildPostDeEsserFilters(params)
    const fc = buildDeEsserFilterComplex(preFilters, postFilters, normAndLimit, params, false)
    args.push('-filter_complex', fc, '-map', '[out]')
  } else {
    // Simple -af path.
    const preFilters  = buildPreDeEsserFilters(params)
    const postFilters = buildPostDeEsserFilters(params)
    const fullChain   = [...preFilters, ...postFilters, normAndLimit].filter(Boolean).join(',')
    args.push('-af', fullChain)
  }

  if (options.format === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', QUALITY_BITRATE.mp3[options.quality])
  } else if (options.format === 'aac' || options.format === 'm4a') {
    args.push('-c:a', 'aac', '-b:a', QUALITY_BITRATE.aac[options.quality])
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
  await ffmpegManager.deleteFile(outputName)

  onProgress?.(100)

  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
    aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg',
  }
  return new Blob([data as unknown as ArrayBuffer], { type: mimeTypes[options.format] ?? 'audio/mpeg' })
}
