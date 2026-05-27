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
  /**
   * Set to true once the iOS audio session has been switched from the
   * "ringer" bus to the "media playback" bus.  Prevents duplicate unlock
   * calls when initOnUserGesture() is invoked more than once.
   */
  private _sessionUnlocked = false
  /** Prevents registering the visibilitychange listener more than once. */
  private _visibilityListenerAdded = false

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

    // Must happen before statechange listener and worklet registration so that
    // the audio session is in the correct state when first audio nodes fire.
    await this._unlockAudioSession()

    this.ctx.addEventListener('statechange', () => {
      this.listeners.forEach((l) => l(this.ctx!.state))
    })

    // Resume the AudioContext when the page becomes visible again.
    // On Android and some iOS scenarios the context is suspended while the
    // browser tab is in the background (screen lock, app switcher, call, etc.).
    // Without this the user would have to tap a UI control before audio resumes.
    if (!this._visibilityListenerAdded) {
      this._visibilityListenerAdded = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.ctx?.state === 'suspended') {
          this.ctx.resume().catch(() => {})
        }
      })
    }

    await this.registerWorklets()
    this.notify()
    return this.ctx
  }

  /**
   * Switches the iOS audio session from the "ringer" route to the
   * "media playback" route by playing a single silent frame through an
   * HTMLAudioElement backed by a MediaStreamDestinationNode.
   *
   * Without this, Web Audio output on iOS:
   *   - is muted by the hardware silent-mode (mute) switch regardless of
   *     the software volume level
   *   - is controlled by the ringer volume buttons, not the media volume
   *   - may route to the earpiece instead of the loudspeaker
   *
   * After this call, all three problems are resolved for the lifetime of
   * the audio context.  The method is a no-op on non-iOS browsers (safe
   * to call everywhere — MediaStreamDestinationNode is universally supported).
   */
  private async _unlockAudioSession(): Promise<void> {
    if (!this.ctx || this._sessionUnlocked) return
    try {
      const dest = this.ctx.createMediaStreamDestination()
      const audioEl = document.createElement('audio')
      audioEl.srcObject = dest.stream
      // playsinline prevents iOS from opening the system media player.
      audioEl.setAttribute('playsinline', '')
      // The element must NOT be muted — a muted element does not trigger
      // the iOS audio session category switch.
      audioEl.muted = false

      // Feed exactly one sample of silence so the element has something to
      // decode; this is enough to register the media-playback session.
      const silentBuf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const src = this.ctx.createBufferSource()
      src.buffer = silentBuf
      src.connect(dest)

      // The element must be in the DOM before play() is called on iOS.
      document.body.appendChild(audioEl)
      await audioEl.play()
      src.start()

      this._sessionUnlocked = true

      // Detach the throwaway element once the unlock frame has played.
      setTimeout(() => {
        try { audioEl.pause(); audioEl.remove() } catch { /* */ }
      }, 500)
    } catch (err) {
      console.warn('[AudioContextManager] audio session unlock failed:', err)
    }
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
