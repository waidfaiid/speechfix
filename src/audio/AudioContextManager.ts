import { AUDIO_CONTEXT_SAMPLE_RATE, isIOS } from '@/utils/mobileAudio'

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
   * On iOS, audio is routed through a MediaStreamDestinationNode → <audio> element
   * instead of ctx.destination.  This guarantees the media-playback audio session
   * (not the ringer bus), so:
   *   - the hardware silent switch does NOT mute the audio
   *   - volume buttons control media volume (not ringer volume)
   *   - audio routes to the loudspeaker, not the earpiece
   * On non-iOS platforms these are both null and ctx.destination is used directly.
   */
  private _streamDest: MediaStreamAudioDestinationNode | null = null
  private _streamAudioEl: HTMLAudioElement | null = null

  /** True once the iOS <audio> element is playing (or not needed on this platform). */
  private _sessionUnlocked = false
  /** Prevents registering the visibilitychange listener more than once. */
  private _visibilityListenerAdded = false

  get context(): AudioContext | null {
    return this.ctx
  }

  get state(): AudioContextState {
    return this.ctx?.state ?? 'closed'
  }

  /**
   * The AudioNode that should receive the master output of the audio graph.
   * On iOS this is the MediaStreamDestinationNode (feeds the <audio> element).
   * On all other platforms this is ctx.destination.
   */
  get outputDestination(): AudioNode | null {
    return this._streamDest ?? this.ctx?.destination ?? null
  }

  async initOnUserGesture(): Promise<AudioContext> {
    // ── SYNCHRONOUS SECTION — everything before the first `await` ─────────────
    // iOS requires audio.play() to be called synchronously within the same
    // microtask as the user gesture.  All setup that calls audio.play() MUST
    // happen here, before any await.

    if (this.ctx && this.ctx.state !== 'closed') {
      // Context already exists — just resume if suspended and restart the
      // iOS audio element if it stopped (e.g. page was backgrounded).
      this._resumeIOSStream()

      if (this.ctx.state === 'suspended') {
        await withTimeout(this.ctx.resume(), 3000, 'AudioContext.resume').catch((err) => {
          console.warn('[AudioContextManager] resume() timed out or failed:', err)
        })
      }
      return this.ctx
    }

    // First call — create the AudioContext and iOS output chain synchronously.
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AudioCtx({ sampleRate: AUDIO_CONTEXT_SAMPLE_RATE, latencyHint: 'interactive' })

    // Set up the iOS MediaStream output path synchronously while we are still
    // inside the user-gesture microtask.  audio.play() is called here (not
    // awaited) so iOS registers this as a media-playback session immediately.
    if (isIOS()) {
      this._setupIOSStreamOutput()
    }

    // Fallback unlock for cases where the MediaStream approach is not used
    // (non-iOS) or if the stream setup failed.
    this.unlockAudioSession()

    // ── ASYNC SECTION — after this point we are outside the gesture epoch ─────
    if (this.ctx.state === 'suspended') {
      await withTimeout(this.ctx.resume(), 3000, 'AudioContext.resume (initial)').catch((err) => {
        console.warn('[AudioContextManager] initial resume() timed out or failed:', err)
      })
    }

    this.ctx.addEventListener('statechange', () => {
      this.listeners.forEach((l) => l(this.ctx!.state))
    })

    // Re-resume context and restart iOS audio element when the page becomes
    // visible again (returns from background, lock screen, app switcher, etc.).
    if (!this._visibilityListenerAdded) {
      this._visibilityListenerAdded = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (this.ctx?.state === 'suspended') {
            this.ctx.resume().catch(() => {})
          }
          this._resumeIOSStream()
        }
      })
    }

    await this.registerWorklets()
    this.notify()
    return this.ctx
  }

  /**
   * Creates a MediaStreamAudioDestinationNode and wires it to an <audio>
   * element that plays back the stream.  Must be called SYNCHRONOUSLY within
   * a user-gesture handler so that audio.play() is authorised by iOS.
   *
   * After this call masterOut should connect to this._streamDest instead of
   * ctx.destination; the <audio> element provides the actual speaker output.
   */
  private _setupIOSStreamOutput(): void {
    if (!this.ctx || this._streamDest) return
    try {
      this._streamDest = this.ctx.createMediaStreamDestination()

      const el = document.createElement('audio')
      el.srcObject = this._streamDest.stream
      el.setAttribute('playsinline', '')
      // Must NOT be muted — a muted element stays on the ringer bus on iOS.
      el.muted = false
      document.body.appendChild(el)
      this._streamAudioEl = el

      // play() is called synchronously here — still within the gesture microtask.
      el.play().then(() => {
        this._sessionUnlocked = true
        console.log('[AudioContextManager] iOS MediaStream output active')
      }).catch((err) => {
        console.warn('[AudioContextManager] iOS stream play() failed:', err)
        // Tear down the failed stream so a later retry can try again.
        this._streamDest = null
        try { el.remove() } catch { /* */ }
        this._streamAudioEl = null
      })
    } catch (err) {
      console.warn('[AudioContextManager] iOS stream setup failed:', err)
      this._streamDest = null
      this._streamAudioEl = null
    }
  }

  /**
   * Restarts the iOS <audio> element if it is paused (e.g. after the page
   * was backgrounded and brought back to the foreground).  Must be called
   * from a user-gesture handler or a visibilitychange event.
   */
  private _resumeIOSStream(): void {
    if (this._streamAudioEl && this._streamAudioEl.paused) {
      this._streamAudioEl.play().catch(() => {})
    }
  }

  /**
   * Public wrapper so AudioEngine.play() can restart the iOS stream on the
   * play-button gesture (belt-and-suspenders in case the stream was paused).
   */
  resumeIOSStreamOutput(): void {
    this._resumeIOSStream()
  }

  /**
   * Switches the iOS audio session from the "ringer" route to the
   * "media playback" route by playing a 1-sample silent WAV through a
   * throwaway HTMLAudioElement.  Used as a secondary unlock when the
   * MediaStream path is not available.
   *
   * CRITICAL: this method is SYNCHRONOUS and MUST be called before any
   * `await` so it fires within the user-gesture microtask.  If audio.play()
   * rejects (gesture epoch expired), _sessionUnlocked resets to false so the
   * next user tap retries.
   */
  unlockAudioSession(): void {
    if (this._sessionUnlocked) return
    this._sessionUnlocked = true   // optimistic — reset on rejection
    try {
      // Build a minimal 46-byte WAV: 44-byte header + 1 sample of silence.
      const wav = new Uint8Array(46)
      const view = new DataView(wav.buffer)
      const str = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) wav[off + i] = s.charCodeAt(i)
      }
      str(0, 'RIFF'); view.setUint32(4, 38, true);    str(8, 'WAVE')
      str(12, 'fmt '); view.setUint32(16, 16, true);  view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)     // mono
      view.setUint32(24, 22050, true)  // sample rate
      view.setUint32(28, 44100, true)  // byte rate
      view.setUint16(32, 2, true)     // block align
      view.setUint16(34, 16, true)    // bits per sample
      str(36, 'data'); view.setUint32(40, 2, true)    // 1 sample
      // bytes 44-45 already 0 (silence)

      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const audioEl = document.createElement('audio')
      audioEl.src = url
      audioEl.setAttribute('playsinline', '')
      audioEl.muted = false
      document.body.appendChild(audioEl)

      audioEl.play().then(() => {
        URL.revokeObjectURL(url)
        setTimeout(() => { try { audioEl.pause(); audioEl.remove() } catch { /* */ } }, 500)
      }).catch(() => {
        this._sessionUnlocked = false
        URL.revokeObjectURL(url)
        try { audioEl.remove() } catch { /* */ }
      })
    } catch (err) {
      this._sessionUnlocked = false
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
