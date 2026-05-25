import { AUDIO_CONTEXT_SAMPLE_RATE } from '@/utils/mobileAudio'

type StateListener = (state: AudioContextState) => void

/**
 * Returns a Promise that rejects after `ms` milliseconds.
 * Used to guard against iOS Safari operations that can hang indefinitely
 * (e.g. AudioContext.resume() or audioWorklet.addModule() outside a user gesture).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[iOS timeout] ${label} timed out after ${ms} ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

class AudioContextManager {
  private ctx: AudioContext | null = null
  private listeners: Set<StateListener> = new Set()

  get context(): AudioContext | null {
    return this.ctx
  }

  get state(): AudioContextState {
    return this.ctx?.state ?? 'closed'
  }

  async initOnUserGesture(): Promise<AudioContext> {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') {
        // iOS Safari can hang on resume() when called outside a synchronous user-gesture
        // handler. Wrap with a generous timeout so loading never freezes.
        await withTimeout(this.ctx.resume(), 3000, 'AudioContext.resume').catch((err) => {
          console.warn('[AudioContextManager] resume() timed out or failed:', err)
        })
      }
      return this.ctx
    }

    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext

    const sampleRate = AUDIO_CONTEXT_SAMPLE_RATE

    this.ctx = new AudioCtx({ sampleRate, latencyHint: 'interactive' })

    if (this.ctx.state === 'suspended') {
      await withTimeout(this.ctx.resume(), 3000, 'AudioContext.resume (initial)').catch((err) => {
        console.warn('[AudioContextManager] initial resume() timed out or failed:', err)
      })
    }

    this.ctx.addEventListener('statechange', () => {
      this.listeners.forEach((l) => l(this.ctx!.state))
    })

    await this.registerWorklets()
    this.notify()
    return this.ctx
  }

  private async registerWorklets(): Promise<void> {
    if (!this.ctx) return
    const modules = [
      '/worklets/de-esser-processor.js',
      '/worklets/preview-limiter-processor.js',
      '/rnnoise.worklet.js',
    ]
    for (const path of modules) {
      try {
        // iOS Safari can hang on addModule() — guard with a 6-second timeout per module.
        await withTimeout(this.ctx.audioWorklet.addModule(path), 6000, `addModule(${path})`)
      } catch (err) {
        // Worklet registration failures are non-fatal; the engine falls back to
        // simpler Web Audio nodes when a preview processor is unavailable.
        console.warn(`[AudioContextManager] failed to register worklet ${path}:`, err)
      }
    }
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend()
    this.notify()
  }

  async resume(): Promise<void> {
    await this.ctx?.resume()
    this.notify()
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((l) => l(this.state))
  }
}

export const audioContextManager = new AudioContextManager()
