/** True on iPhone / iPad / iPod (incl. iPadOS desktop UA). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/**
 * AudioContext sample rate — 48 kHz on all platforms.
 * RNNoise requires exactly 48 kHz (480-sample frames = 10 ms).
 * On iOS we use chunked decoding to stay within Safari's memory budget
 * while still delivering full-quality audio and noise reduction.
 */
export const AUDIO_CONTEXT_SAMPLE_RATE = 48_000

/**
 * How many seconds of audio to keep decoded at 48 kHz for live preview.
 * On iOS, only this window is kept in memory; the rest is freed.
 * 90 s × 48 kHz × mono × 4 bytes ≈ 17 MB — well within Safari's budget.
 */
export const CHUNK_DURATION_SEC = 90

/**
 * Start pre-fetching the next chunk when playback is within this many
 * seconds of the chunk boundary.
 */
export const CHUNK_PREFETCH_SEC = 20

/**
 * Sample rate used for the waveform overview decode.
 * Low enough that even a 3 h file is manageable (3 h × 8 kHz × 4 B ≈ 346 MB),
 * but we only keep the extracted peak array (~9 MB for 3 h), not the raw samples.
 */
export const WAVEFORM_DECODE_RATE = 8_000

/** Peaks per second stored in the waveform overview array. */
export const WAVEFORM_PEAKS_PER_SEC = 100

/** Bytes for a decoded float32 buffer (all channels). */
export function estimateDecodedBytes(
  durationSec: number,
  sampleRate: number,
  channels = 2,
): number {
  return Math.ceil(durationSec * sampleRate * channels * 4)
}

/** Rough duration from compressed file size (128 kbps fallback). */
export function estimateDurationSec(file: File): number {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (LOSSLESS_EXTS.has(ext)) {
    return (file.size / (1024 * 1024)) * 60
  }
  const bitrateKbps = file.type.includes('mpeg') || ext === 'mp3' ? 128 : 192
  return (file.size * 8) / (bitrateKbps * 1000)
}

const LOSSLESS_EXTS = new Set(['wav', 'flac', 'aiff', 'aif'])

/**
 * Whether this file needs chunked playback (iOS with files that would exceed
 * the Safari tab memory budget if decoded fully at 48 kHz).
 * Threshold: any file whose 48 kHz mono decode would exceed ~80 MB (≈ 7 min).
 */
export function needsChunkedPlayback(file: File): boolean {
  if (!isIOS()) return false
  const durationSec = estimateDurationSec(file)
  const bytes48k = estimateDecodedBytes(durationSec, AUDIO_CONTEXT_SAMPLE_RATE, 1)
  return bytes48k > 80 * 1024 * 1024
}

/**
 * Legacy compat: whether FFmpeg decode is needed.
 * Now equivalent to needsChunkedPlayback (chunked mode uses FFmpeg).
 */
export function shouldDecodeViaFfmpeg(file: File): boolean {
  return needsChunkedPlayback(file)
}

/** Slice used for integrated loudness on very long files (full pass is expensive). */
export const LUFS_ANALYSIS_MAX_SEC = 120
