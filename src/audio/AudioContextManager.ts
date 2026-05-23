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

    // iOS Safari decodes audio into an AudioBuffer at the context's sample rate.
    // A 30-minute stereo file at 48 kHz produces a ~700 MB decoded buffer, which
    // exceeds iOS Safari's per-tab memory budget and kills the page.
    // At 22 050 Hz the same file decodes to ~320 MB, which fits comfortably on
    // iPhone 11+ (4 GB RAM).  Speech quality is unaffected; export still uses
    // FFmpeg at full quality independently of this context rate.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && typeof window !== 'undefined'
    const sampleRate = isIOS ? 22050 : 48000

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
