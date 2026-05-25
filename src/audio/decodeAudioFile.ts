import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import {
  AUDIO_CONTEXT_SAMPLE_RATE,
  isIOS,
  needsChunkedPlayback,
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

/**
 * Shared FFmpeg input file management: keeps the file written to FFmpeg FS
 * once and reuses across chunk decodes for the same file.
 */
let _ffmpegInputFile: { name: string; fileRef: File } | null = null

async function ensureFfmpegInput(file: File): Promise<string> {
  if (_ffmpegInputFile && _ffmpegInputFile.fileRef === file) return _ffmpegInputFile.name
  if (_ffmpegInputFile) {
    await ffmpegManager.deleteFile(_ffmpegInputFile.name).catch(() => {})
  }
  if (!ffmpegManager.isLoaded) await ffmpegManager.load()
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'mp3'
  const name = `chunk_src.${ext}`
  await ffmpegManager.writeFile(name, file)
  _ffmpegInputFile = { name, fileRef: file }
  return name
}

/** Release the cached FFmpeg input file. */
export function releaseFfmpegInput(): void {
  if (_ffmpegInputFile) {
    ffmpegManager.deleteFile(_ffmpegInputFile.name).catch(() => {})
    _ffmpegInputFile = null
  }
}

/**
 * Decode a time-range chunk of a file via FFmpeg at the given sample rate.
 * Returns a mono AudioBuffer. Used for chunked playback on iOS.
 */
export async function decodeChunk(
  file: File,
  startSec: number,
  durationSec: number,
  sampleRate: number = AUDIO_CONTEXT_SAMPLE_RATE,
): Promise<AudioBuffer> {
  if (!ffmpegManager.isLoaded) await ffmpegManager.load()

  const inputName = await ensureFfmpegInput(file)
  const stamp = Date.now()
  const outputName = `chunk_${stamp}.f32le`

  try {
    const args = ['-ss', startSec.toFixed(3)]
    if (durationSec > 0) args.push('-t', durationSec.toFixed(3))
    args.push('-i', inputName, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', outputName)

    await ffmpegManager.exec(args)

    const raw = await ffmpegManager.readFile(outputName)
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
    const sampleCount = Math.floor(bytes.byteLength / 4)

    const ctx = new OfflineAudioContext(1, Math.max(1, sampleCount), sampleRate)
    const buffer = ctx.createBuffer(1, sampleCount, sampleRate)
    const channel = buffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4)
    const blockSize = 65_536
    for (let off = 0; off < sampleCount; off += blockSize) {
      const end = Math.min(sampleCount, off + blockSize)
      for (let i = off; i < end; i++) {
        channel[i] = view.getFloat32(i * 4, true)
      }
    }
    return buffer
  } finally {
    await ffmpegManager.deleteFile(outputName)
  }
}

async function decodeViaFfmpeg(file: File, sampleRate: number): Promise<AudioBuffer> {
  if (!ffmpegManager.isLoaded) await ffmpegManager.load()

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

    const ctx = new OfflineAudioContext(1, Math.max(1, sampleCount), sampleRate)
    const buffer = ctx.createBuffer(1, sampleCount, sampleRate)
    const channel = buffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4)
    const blockSize = 65_536
    for (let off = 0; off < sampleCount; off += blockSize) {
      const end = Math.min(sampleCount, off + blockSize)
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
  /** Target preview sample rate (AudioContext rate). */
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

  if (needsChunkedPlayback(file)) {
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
