/** True on iPhone / iPad / iPod (incl. iPadOS desktop UA). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/** Preview sample rate on iOS — keeps decoded RAM within Safari's tab budget. */
export const IOS_PREVIEW_SAMPLE_RATE = 16_000

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
    // ~1 MB/min stereo 44.1 kHz 16-bit is a coarse speech estimate
    return (file.size / (1024 * 1024)) * 60
  }
  const bitrateKbps = file.type.includes('mpeg') || ext === 'mp3' ? 128 : 192
  return (file.size * 8) / (bitrateKbps * 1000)
}

const LOSSLESS_EXTS = new Set(['wav', 'flac', 'aiff', 'aif'])

/**
 * On iOS, Safari's MP3 decoder + a stereo AudioBuffer often exceeds the tab memory
 * limit for sermons longer than ~20 min. FFmpeg decodes directly to mono f32le.
 */
export function shouldDecodeViaFfmpeg(file: File): boolean {
  if (!isIOS()) return false
  const durationSec = estimateDurationSec(file)
  const bytes = estimateDecodedBytes(durationSec, IOS_PREVIEW_SAMPLE_RATE, 1)
  return file.size > 12 * 1024 * 1024 || durationSec > 18 * 60 || bytes > 90 * 1024 * 1024
}

/** Slice used for integrated loudness on very long files (full pass is expensive). */
export const LUFS_ANALYSIS_MAX_SEC = 120
