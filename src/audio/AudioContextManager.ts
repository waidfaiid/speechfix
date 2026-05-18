type StateListener = (state: AudioContextState) => void

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
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      return this.ctx
    }

    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AudioCtx({ sampleRate: 48000, latencyHint: 'interactive' })

    if (this.ctx.state === 'suspended') await this.ctx.resume()

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
      '/worklets/denoise-processor.js',
      '/worklets/de-esser-processor.js',
    ]
    for (const path of modules) {
      try {
        await this.ctx.audioWorklet.addModule(path)
      } catch {
        // Worklet registration failures are non-fatal; the engine falls back
        // to the static BiquadFilter de-esser when the worklet is unavailable.
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
