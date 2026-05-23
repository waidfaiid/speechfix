import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import {
  IOS_PREVIEW_SAMPLE_RATE,
  isIOS,
  shouldDecodeViaFfmpeg,
} from '@/utils/mobileAudio'

function decodeWithWebAudio(ctx: AudioContext, arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('decodeAudioData timed out after 90 s'))
    }, 90_000)

    const done = (buf: AudioBuffer) => { clearTimeout(timer); resolve(buf) }
    const fail = (err: unknown) => {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    try {
      ctx.decodeAudioData(arrayBuffer.slice(0), done, fail)
    } catch (e) {
      fail(e)
    }
  })
}

/** Downmix stereo → mono without keeping both buffers referenced longer than needed. */
function downmixToMono(buffer: AudioBuffer, ctx: BaseAudioContext): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer

  const mono = ctx.createBuffer(1, buffer.length, buffer.sampleRate)
  const out = mono.getChannelData(0)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const chunk = 131_072

  for (let off = 0; off < buffer.length; off += chunk) {
    const end = Math.min(buffer.length, off + chunk)
    for (let i = off; i < end; i++) out[i] = (left[i] + right[i]) * 0.5
  }
  return mono
}

async function decodeViaFfmpeg(file: File, sampleRate: number): Promise<AudioBuffer> {
  if (!ffmpegManager.isLoaded) {
    await ffmpegManager.load()
  }

  const inputExt = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'mp3'
  const inputName = `decode_in_${Date.now()}.${inputExt}`
  const outputName = `decode_out_${Date.now()}.f32le`

  try {
    await ffmpegManager.writeFile(inputName, file)
    await ffmpegManager.exec([
      '-i', inputName,
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      outputName,
    ])

    const raw = await ffmpegManager.readFile(outputName)
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
    const sampleCount = Math.floor(bytes.byteLength / 4)

    const ctx = new OfflineAudioContext(1, 1, sampleRate)
    const buffer = ctx.createBuffer(1, sampleCount, sampleRate)
    const channel = buffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4)
    const chunk = 65_536
    for (let off = 0; off < sampleCount; off += chunk) {
      const end = Math.min(sampleCount, off + chunk)
      for (let i = off; i < end; i++) {
        channel[i] = view.getFloat32(i * 4, true)
      }
    }
    return buffer
  } finally {
    await ffmpegManager.deleteFile(inputName)
    await ffmpegManager.deleteFile(outputName)
  }
}

export interface DecodeAudioOptions {
  /** Target preview sample rate (AudioContext rate on mobile). */
  sampleRate: number
  /** Force mono output to halve RAM on mobile. */
  forceMono?: boolean
}

/**
 * Decode a user file into an AudioBuffer suitable for in-browser preview.
 * On iOS with long/compressed files, FFmpeg decodes to mono f32le to avoid
 * Safari OOM kills during decodeAudioData.
 */
export async function decodeAudioFile(
  ctx: AudioContext,
  file: File,
  options: DecodeAudioOptions,
): Promise<AudioBuffer> {
  const { sampleRate, forceMono = isIOS() } = options

  let buffer: AudioBuffer

  if (shouldDecodeViaFfmpeg(file)) {
    try {
      buffer = await decodeViaFfmpeg(file, sampleRate)
    } catch (err) {
      console.warn('[decodeAudioFile] FFmpeg decode failed, falling back to Web Audio:', err)
      const arrayBuffer = await file.arrayBuffer()
      buffer = await decodeWithWebAudio(ctx, arrayBuffer)
    }
  } else {
    const arrayBuffer = await file.arrayBuffer()
    buffer = await decodeWithWebAudio(ctx, arrayBuffer)
  }

  if (forceMono && buffer.numberOfChannels > 1) {
    buffer = downmixToMono(buffer, ctx)
  }

  return buffer
}
