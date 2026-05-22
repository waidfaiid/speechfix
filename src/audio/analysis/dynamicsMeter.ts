import type { ContentType } from '@/types/processing.types'

/** 300 ms blocks, 150 ms hop — aligned with speech dynamics and preview/export parity. */
export const DYNAMICS_WINDOW_SEC = 0.3
export const DYNAMICS_HOP_SEC = 0.15
export const DYNAMICS_SILENCE_DBFS = -50

/** UI scale: left = high dynamics, right = heavily compressed. */
export const DYNAMICS_SCALE_MAX_DB = 20
export const DYNAMICS_IDEAL_MIN_DB = 9
export const DYNAMICS_IDEAL_MAX_DB = 12
/** Auto-compress threshold for pure speech recordings. */
export const DYNAMICS_AUTO_TARGET_DB = 10
/** Auto-compress threshold for mixed content (speech + music) — wider acceptable range. */
export const DYNAMICS_AUTO_TARGET_DB_MIXED = 14

/**
 * Reference working level for the processing chain (EBU R128 production level).
 * Source audio is normalised to this level at the chain INPUT so that the EQ,
 * compressors and de-esser always receive material with adequate headroom,
 * regardless of the original recording level.  The output normalisation gain
 * then brings the processed signal from this level up to the limiter target.
 */
export const DYNAMICS_WORKING_LEVEL_LUFS = -23

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  // For mono files return the channel data directly — no copy needed.
  // All call-sites either read the data or pass it to decimateMono()
  // which always creates its own new Float32Array, so this is safe.
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)

  const { length, numberOfChannels } = buffer
  const mono = new Float32Array(length)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) mono[i] += data[i]
  }
  for (let i = 0; i < length; i++) mono[i] /= numberOfChannels
  return mono
}

/** RMS level in dBFS for one window. */
export function windowRmsDb(samples: Float32Array, start: number, length: number): number {
  let sumSq = 0
  const end = Math.min(start + length, samples.length)
  const n = end - start
  if (n <= 0) return DYNAMICS_SILENCE_DBFS - 1
  for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
  const rms = Math.sqrt(sumSq / n)
  return 20 * Math.log10(rms || 1e-12)
}

/**
 * Dynamics range = P80 − P20 of 300 ms RMS levels (non-silent windows only).
 */
export function measureDynamicsRangeDb(
  samples: Float32Array,
  sampleRate: number,
): number {
  const windowSamples = Math.max(1, Math.round(sampleRate * DYNAMICS_WINDOW_SEC))
  const hopSamples = Math.max(1, Math.round(sampleRate * DYNAMICS_HOP_SEC))
  const levels: number[] = []

  for (let i = 0; i + windowSamples <= samples.length; i += hopSamples) {
    const db = windowRmsDb(samples, i, windowSamples)
    if (db > DYNAMICS_SILENCE_DBFS) levels.push(db)
  }

  if (levels.length < 2) return 0

  levels.sort((a, b) => a - b)
  const spread = percentile(levels, 0.8) - percentile(levels, 0.2)
  return Math.max(0, Math.min(DYNAMICS_SCALE_MAX_DB, spread))
}

export function measureBufferDynamicsRangeDb(buffer: AudioBuffer): number {
  return measureDynamicsRangeDb(mixToMono(buffer), buffer.sampleRate)
}

/** Map dynamics (dB) to bar position: 0 = left (high dynamics), 1 = right (compressed). */
export function dynamicsDbToPosition(dynamicsDb: number): number {
  return Math.max(0, Math.min(1, 1 - dynamicsDb / DYNAMICS_SCALE_MAX_DB))
}

/** Suggest compression amount (0–1) from original dynamics; targets 10 dB. Returns 0 if already at or below target. */
export function suggestCompressionAmount(originalDynamicsDb: number): number {
  if (originalDynamicsDb <= DYNAMICS_AUTO_TARGET_DB) return 0
  const excess = originalDynamicsDb - DYNAMICS_AUTO_TARGET_DB
  return Math.min(1, Math.max(0.15, excess / 14))
}

// ---------------------------------------------------------------------------
// Offline software-compressor simulation (feed-forward, no Web Audio required)
// ---------------------------------------------------------------------------

/**
 * Decimate to ~4 kHz for speed.  For P80-P20 RMS measurements we don't need
 * sample-accurate playback — envelope shape is preserved well enough.
 */
function decimateMono(mono: Float32Array, originalSr: number, targetSr = 4000): { data: Float32Array; sr: number } {
  const step = Math.max(1, Math.round(originalSr / targetSr))
  const len = Math.floor(mono.length / step)
  const data = new Float32Array(len)
  for (let i = 0; i < len; i++) data[i] = mono[i * step]
  return { data, sr: originalSr / step }
}

/**
 * Single compressor stage — RMS power-envelope follower.
 * Uses a squared-amplitude smoother (attack/release in power domain), which closely
 * matches Web Audio DynamicsCompressorNode's RMS detector and avoids the systematic
 * over-compression of a raw peak detector.
 */
function applyCompressorSw(
  samples: Float32Array,
  sr: number,
  thresholdDb: number,
  ratio: number,
  attackSec: number,
  releaseSec: number,
): Float32Array {
  const out = new Float32Array(samples.length)
  const atkC = Math.exp(-1 / (sr * Math.max(attackSec, 1 / sr)))
  const relC = Math.exp(-1 / (sr * Math.max(releaseSec, 1 / sr)))
  const threshLin = Math.pow(10, thresholdDb / 20)
  let envPow = 0   // smoothed power (RMS² domain)
  let gainLin = 1.0

  for (let i = 0; i < samples.length; i++) {
    // Power-domain envelope follower — equivalent to an RMS detector
    const pow = samples[i] * samples[i]
    const c = pow > envPow ? atkC : relC
    envPow = c * envPow + (1 - c) * pow

    // Gain reduction from RMS level
    const rmsLin = Math.sqrt(envPow)
    const targetGain = rmsLin > threshLin ? Math.pow(rmsLin / threshLin, 1 / ratio - 1) : 1.0
    gainLin = targetGain < gainLin
      ? atkC * gainLin + (1 - atkC) * targetGain
      : relC * gainLin + (1 - relC) * targetGain
    out[i] = samples[i] * gainLin
  }
  return out
}

/** Compute RMS of non-silent windows (uses `gateMono` for silence detection if supplied). */
function nonSilentWindowRms(
  samples: Float32Array,
  sampleRate: number,
  gateMono: Float32Array | null = null,
): number {
  const winLen = Math.max(1, Math.round(sampleRate * DYNAMICS_WINDOW_SEC))
  let sumSq = 0
  let count = 0
  const gate = gateMono ?? samples
  for (let i = 0; i + winLen <= samples.length; i += winLen) {
    const gateDb = windowRmsDb(gate, i, winLen)
    if (gateDb <= DYNAMICS_SILENCE_DBFS) continue
    for (let j = i; j < i + winLen; j++) sumSq += samples[j] * samples[j]
    count += winLen
  }
  if (count === 0) return 0
  return Math.sqrt(sumSq / count)
}

/**
 * Compute the static makeup gain in dB that keeps perceived loudness constant
 * when the two-stage compressor is enabled.  Must be applied as a fixed gain
 * node — never dynamically per-frame (that causes upward-compression pumping).
 *
 * @param inputGainDb - Pre-chain gain matching AudioEngine inputNormalizeGain
 *   so the simulation operates at the correct level.
 */
export function computeMakeupGainDb(
  buffer: AudioBuffer,
  compressionEnabled: boolean,
  compressionAmount: number,
  inputGainDb = 0,
  contentType: ContentType = 'speech',
): number {
  if (!compressionEnabled || compressionAmount === 0) return 0

  const { data: rawMono, sr } = decimateMono(mixToMono(buffer), buffer.sampleRate)

  // Apply pre-chain input gain so simulation matches the actual processing level
  let mono = rawMono
  if (inputGainDb !== 0) {
    const g = Math.pow(10, inputGainDb / 20)
    mono = new Float32Array(rawMono.length)
    for (let i = 0; i < rawMono.length; i++) mono[i] = rawMono[i] * g
  }

  const origRms = nonSilentWindowRms(mono, sr)
  if (origRms < 1e-10) return 0

  const amount = compressionAmount
  const isMixed = contentType === 'mixed'
  // Stage 1: mirrors AudioEngine — capped at 4:1 for mixed, 12:1 for speech
  const s1ratio = isMixed ? 1 + amount * 3 : 1 + amount * 11
  const s1threshold = isMixed ? -4 : -8
  let compressed = applyCompressorSw(mono, sr, s1threshold, s1ratio, 0.003, 0.05)
  // Stage 2: threshold raised +6 dB for mixed to protect music dynamics
  const s2threshold = -14 - amount * 18 + (isMixed ? 6 : 0)
  compressed = applyCompressorSw(
    compressed, sr,
    s2threshold, 2 + amount * 3, 0.025, 0.25 + amount * 0.55,
  )
  const compRms = nonSilentWindowRms(compressed, sr, mono)
  if (compRms < 1e-10) return 0

  const makeupDb = 20 * Math.log10(origRms / compRms)
  return Math.max(-18, Math.min(18, makeupDb))
}

/**
 * Compute the P80-P20 dynamics range of the full buffer after virtual two-stage
 * compression, without requiring Web Audio.  Runs synchronously in < 100 ms
 * for a 1-hour file (decimated to 4 kHz).
 *
 * @param inputGainDb - Pre-chain gain applied before simulation (matches AudioEngine
 *   inputNormalizeGain).  Pass `DYNAMICS_WORKING_LEVEL_LUFS - sourceLUFS` so the
 *   simulation operates at the same level as the real processing chain.
 */
export function computeCompressedDynamicsDbSync(
  buffer: AudioBuffer,
  compressionEnabled: boolean,
  compressionAmount: number,
  inputGainDb = 0,
  contentType: ContentType = 'speech',
): number {
  let { data, sr } = decimateMono(mixToMono(buffer), buffer.sampleRate)

  if (inputGainDb !== 0) {
    const g = Math.pow(10, inputGainDb / 20)
    for (let i = 0; i < data.length; i++) data[i] *= g
  }

  if (compressionEnabled && compressionAmount > 0) {
    const amount = compressionAmount
    const isMixed = contentType === 'mixed'
    // Stage 1: capped at 4:1 for mixed (music protection), 12:1 for speech
    const s1ratio = isMixed ? 1 + amount * 3 : 1 + amount * 11
    const s1threshold = isMixed ? -4 : -8
    data = applyCompressorSw(data, sr, s1threshold, s1ratio, 0.003, 0.05)
    // Stage 2: threshold raised +6 dB for mixed to protect music dynamics
    const threshold = -14 - amount * 18 + (isMixed ? 6 : 0)
    const ratio = 2 + amount * 3
    const release = 0.25 + amount * 0.55
    data = applyCompressorSw(data, sr, threshold, ratio, 0.025, release)
  }

  return measureDynamicsRangeDb(data, sr)
}
