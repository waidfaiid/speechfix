import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

type ProgressCallback = (progress: number) => void

class FFmpegManager {
  private ffmpeg: FFmpeg | null = null
  private loading = false
  private loaded = false
  private onProgress: ProgressCallback | null = null

  setProgressCallback(fn: ProgressCallback | null) { this.onProgress = fn }

  async load(): Promise<void> {
    if (this.loaded || this.loading) return
    this.loading = true

    this.ffmpeg = new FFmpeg()
    this.ffmpeg.on('progress', ({ progress }) => {
      this.onProgress?.(Math.round(progress * 100))
    })
    this.ffmpeg.on('log', ({ message }) => {
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.debug('[ffmpeg]', message)
    })

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'
    const hasSAB = typeof SharedArrayBuffer !== 'undefined'

    if (hasSAB) {
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      })
    } else {
      console.warn('[FFmpeg] SharedArrayBuffer not available – using single-threaded fallback')
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      })
    }

    this.loaded = true
    this.loading = false
  }

  get instance(): FFmpeg {
    if (!this.ffmpeg || !this.loaded) throw new Error('FFmpeg not loaded')
    return this.ffmpeg
  }

  get isLoaded() { return this.loaded }

  async writeFile(name: string, data: Uint8Array | File): Promise<void> {
    const bytes = data instanceof File ? await fetchFile(data) : data
    await this.instance.writeFile(name, bytes)
  }

  async readFile(name: string): Promise<Uint8Array> {
    const result = await this.instance.readFile(name)
    return result as Uint8Array
  }

  async exec(args: string[]): Promise<void> {
    const logs: string[] = []
    const handler = ({ message }: { message: string }) => logs.push(message)
    this.instance.on('log', handler)
    let code = 0
    try {
      code = await this.instance.exec(args)
    } finally {
      this.instance.off('log', handler)
    }
    if (code !== 0) {
      // Keep only the last few non-empty lines — they contain the actual error.
      const tail = logs.filter(l => l.trim()).slice(-6).join(' | ')
      throw new Error(`FFmpeg fehlgeschlagen (Exit-Code ${code})${tail ? `: ${tail}` : ''}`)
    }
  }

  /**
   * Run FFmpeg and capture all log lines for parsing measurement output
   * (e.g. ebur128 loudness summary). The permanent dev-mode log listener
   * is unaffected; this adds a temporary second listener.
   */
  async execCaptureLogs(args: string[]): Promise<string[]> {
    const logs: string[] = []
    const handler = ({ message }: { message: string }) => logs.push(message)
    this.instance.on('log', handler)
    let code = 0
    try {
      code = await this.instance.exec(args)
    } finally {
      this.instance.off('log', handler)
    }
    if (code !== 0) {
      throw new Error(`FFmpeg fehlgeschlagen (Exit-Code ${code}). Logs: ${logs.slice(-5).join(' | ')}`)
    }
    return logs
  }

  async deleteFile(name: string): Promise<void> {
    try { await this.instance.deleteFile(name) } catch { /* ignore */ }
  }
}

export const ffmpegManager = new FFmpegManager()
