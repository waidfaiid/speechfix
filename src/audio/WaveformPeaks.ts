import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import { WAVEFORM_DECODE_RATE, WAVEFORM_PEAKS_PER_SEC } from '@/utils/mobileAudio'

export interface WaveformPeakData {
  /** Interleaved min/max pairs: [min0, max0, min1, max1, …] */
  peaks: Float32Array
  /** Number of peak pairs (length = peakCount * 2). */
  peakCount: number
  /** Total file duration in seconds (from decoded sample count). */
  duration: number
  /** Peaks per second of audio — needed to map time → peak index. */
  peaksPerSec: number
}

/**
 * Decode a file at a low sample rate via FFmpeg and extract a compact peak
 * array suitable for waveform rendering.  The decoded buffer is processed in
 * JS-sized chunks and discarded immediately so peak memory stays low.
 *
 * Memory profile for a 3 h file:
 *   Decoded f32le at 8 kHz mono  → 346 MB  (temporary, freed after peak extraction)
 *   Peak array at 100 peaks/sec  →   8.6 MB (kept)
 */
export async function computeWaveformPeaks(file: File): Promise<WaveformPeakData> {
  if (!ffmpegManager.isLoaded) await ffmpegManager.load()

  const stamp = Date.now()
  const inputExt = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'mp3'
  const inputName = `wf_in_${stamp}.${inputExt}`
  const outputName = `wf_out_${stamp}.f32le`

  try {
    await ffmpegManager.writeFile(inputName, file)
    await ffmpegManager.exec([
      '-i', inputName,
      '-ac', '1',
      '-ar', String(WAVEFORM_DECODE_RATE),
      '-f', 'f32le',
      outputName,
    ])

    const raw = await ffmpegManager.readFile(outputName)
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
    const sampleCount = Math.floor(bytes.byteLength / 4)
    const duration = sampleCount / WAVEFORM_DECODE_RATE

    const samplesPerPeak = Math.max(1, Math.round(WAVEFORM_DECODE_RATE / WAVEFORM_PEAKS_PER_SEC))
    const peakCount = Math.ceil(sampleCount / samplesPerPeak)
    const peaks = new Float32Array(peakCount * 2)
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4)

    for (let p = 0; p < peakCount; p++) {
      const start = p * samplesPerPeak
      const end = Math.min(sampleCount, start + samplesPerPeak)
      let mn = 0
      let mx = 0
      for (let i = start; i < end; i++) {
        const v = view.getFloat32(i * 4, true)
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      peaks[p * 2] = mn
      peaks[p * 2 + 1] = mx
    }

    return { peaks, peakCount, duration, peaksPerSec: WAVEFORM_PEAKS_PER_SEC }
  } finally {
    await ffmpegManager.deleteFile(inputName)
    await ffmpegManager.deleteFile(outputName)
  }
}
