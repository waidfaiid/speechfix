import { audioContextManager } from './AudioContextManager'
import type { ProcessingParams } from '@/types/processing.types'
import { createSoftClipCurve, createWarmthCurve, dbToLinear } from '@/utils/audioMath'
import { LUFSAnalyzer } from './analysis/LUFSAnalyzer'
import { createPinkNoiseBuffer, measureRmsDbfs } from './analysis/pinkNoise'
import { DYNAMICS_WORKING_LEVEL_LUFS } from './analysis/dynamicsMeter'
import type { createNoiseSuppressionAudioWorklet as CreateFn } from '@workadventure/noise-suppression/audio-worklet'

/**
 * Duration of the gain ramp (seconds) when the DTLN dry/wet balance changes.
 * Short enough to feel responsive, long enough to avoid a click.
 */
const DTLN_RAMP_S = 0.020   // 20 ms

export interface AudioMetering {
  limiterInterventionDb: number
}

/** Inferred return type of createNoiseSuppressionAudioWorklet. */
type DtlnWorkletHandle = Awaited<ReturnType<typeof CreateFn>>

export class AudioEngine {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null

  // DTLN MediaStream bridge — spans two AudioContexts (48 kHz ↔ 16 kHz).
  private dtlnContext: AudioContext | null = null
  /** Sink in the 48 kHz context; receives the post-hum audio. */
  private dtlnBridgeIn: MediaStreamAudioDestinationNode | null = null
  /** Source in the 48 kHz context; feeds the EQ chain after DTLN. */
  private dtlnBridgeOut: MediaStreamAudioSourceNode | null = null
  /** Source node in the 16 kHz context fed from dtlnBridgeIn. */
  private dtlnSrc: MediaStreamAudioSourceNode | null = null
  /** Sink in the 16 kHz context whose stream becomes dtlnBridgeOut. */
  private dtlnDst: MediaStreamAudioDestinationNode | null = null
  /** DelayNode on the dry path: compensates for DTLN ring-buffer + bridge latency. */
  private dtlnDryDelay: DelayNode | null = null
  /** Gain for the dry (bypass) path inside the 16 kHz context. */
  private dtlnDryGain: GainNode | null = null
  /** Gain for the DTLN-processed wet path inside the 16 kHz context. */
  private dtlnWetGain: GainNode | null = null
  /** Mirror of ProcessingParams.dtlnLatencyMs, kept in sync by updateParams(). */
  private dtlnLatencyMs = 48
  /** The AudioWorkletNode created by @workadventure/noise-suppression. */
  private dtlnWorkletHandle: DtlnWorkletHandle | null = null
  /** True once the DTLN worklet has initialised and is connected. */
  private dtlnReady = false
  /** Last noise params applied so we can re-apply after DTLN finishes loading. */
  private _pendingNoiseParams: { enabled: boolean; amount: number } | null = null

  /** Input anchor of the hum-filter sub-chain. Feeds into the active filter array. */
  private humChainIn: GainNode | null = null
  /** Output anchor of the hum-filter sub-chain. Feeds into the EQ nodes. */
  private humChainOut: GainNode | null = null
  private humFilters: BiquadFilterNode[] = []
  private eqNodes: BiquadFilterNode[] = []
  private compressorStage1: DynamicsCompressorNode | null = null
  private compressorStage2: DynamicsCompressorNode | null = null
  private exciterWaveshaper: WaveShaperNode | null = null
  private makeupGain: GainNode | null = null
  private previewNormalizeGain: GainNode | null = null
  private limiterWorklet: AudioWorkletNode | null = null
  private limiterCompressor: DynamicsCompressorNode | null = null
  private desibilanceWorklet: AudioWorkletNode | null = null
  private desibilanceFallback: BiquadFilterNode | null = null
  private limiterGain: GainNode | null = null
  private inputNormalizeGain: GainNode | null = null
  private processedGain: GainNode | null = null
  private bypassGain: GainNode | null = null
  private bypassNormalizeGain: GainNode | null = null
  private masterOut: GainNode | null = null
  private keepAliveOsc: OscillatorNode | null = null

  private postEqTimeDomain: Float32Array | null = null

  private pinkNoiseSource: AudioBufferSourceNode | null = null
  private pinkNoiseGain: GainNode | null = null
  private pinkNoiseBuffer: AudioBuffer | null = null

  private startTime = 0
  private pausedAt = 0
  private playing = false
  private trimStart = 0
  private trimEnd: number | null = null

  private onTimeUpdate: ((t: number) => void) | null = null
  private onEnd: (() => void) | null = null
  private onMetering: ((m: AudioMetering) => void) | null = null
  private onFileLoadedCb: ((buffer: AudioBuffer) => void) | null = null
  private rafId: number | null = null
  private meterRafId: number | null = null

  private sourceLUFS = -20
  private limiterInterventionDb = 0
  private readonly lufsAnalyzer = new LUFSAnalyzer()

  /** Tracks the last makeup gain applied so previewNormalizeGain can compensate. */
  private _currentMakeupDb = 0
  /** Tracks the last limiterTarget so _applyPreviewNormalize() can be called from setStaticMakeupGainDb(). */
  private _lastLimiterTarget = -16

  get isPlaying() { return this.playing }
  get loadedLUFS(): number { return this.sourceLUFS }
  get loadedBuffer(): AudioBuffer | null { return this.buffer }
  setOnFileLoaded(cb: ((buffer: AudioBuffer) => void) | null): void { this.onFileLoadedCb = cb }

  setTrimStart(t: number): void { this.trimStart = t }
  setTrimEnd(t: number | null): void { this.trimEnd = t }

  get currentTime() {
    if (!this.ctx || !this.playing) return this.pausedAt
    return this.pausedAt + (this.ctx.currentTime - this.startTime)
  }

  async init(): Promise<void> {
    this.ctx = await audioContextManager.initOnUserGesture()
    this.buildGraph()
    this.startKeepAlive()
    // Initialise DTLN asynchronously — audio plays with dry bypass until ready.
    this.initDtln().catch((err) => {
      console.warn('[DTLN] worklet initialisation failed; noise slider will have no effect in preview:', err)
    })
  }

  private buildGraph(): void {
    if (!this.ctx) return
    const ctx = this.ctx

    // Pre-chain input normalisation: brings source to DYNAMICS_WORKING_LEVEL_LUFS
    // before EQ/compressors so that EQ boosts have adequate headroom and
    // compressor thresholds work on consistently-levelled material.
    this.inputNormalizeGain = ctx.createGain()
    this.inputNormalizeGain.gain.value = 1

    // Anchor gain nodes bracket the hum sub-chain so filters can be
    // swapped at runtime without restructuring the rest of the graph.
    this.humChainIn  = ctx.createGain()
    this.humChainOut = ctx.createGain()

    // Default: 4-band manual peaking filters (legacy / manual mode)
    this.humFilters = [50, 100, 150, 200].map((freq) => {
      const n = ctx.createBiquadFilter()
      n.type = 'peaking'
      n.frequency.value = freq
      n.Q.value = 12
      n.gain.value = 0
      return n
    })
    this._reconnectHumChain()

    // ---- DTLN MediaStream bridge ----
    // The DTLN neural denoiser operates at 16 kHz.  We bridge the 48 kHz
    // processed chain into a secondary 16 kHz AudioContext and back using
    // MediaStreamTrack routing.  The browser resamples automatically at each
    // hop.  While DTLN is loading the dry gain is 1 (full bypass) so audio
    // plays uninterrupted.
    this.dtlnBridgeIn = ctx.createMediaStreamDestination()

    this.dtlnContext = audioContextManager.createDtlnContext()
    if (this.dtlnContext.state === 'suspended') {
      this.dtlnContext.resume().catch(() => { /* best-effort */ })
    }

    this.dtlnSrc = this.dtlnContext.createMediaStreamSource(this.dtlnBridgeIn.stream)
    this.dtlnDst = this.dtlnContext.createMediaStreamDestination()

    this.dtlnDryGain = this.dtlnContext.createGain()
    this.dtlnDryGain.gain.value = 1   // full dry until DTLN ready
    this.dtlnWetGain = this.dtlnContext.createGain()
    this.dtlnWetGain.gain.value = 0   // silent until DTLN ready

    // Delay the dry path by dtlnLatencyMs to time-align it with the wet signal.
    // The DTLN AudioWorklet introduces latency from:
    //   • 4×128-sample ring buffer at 16 kHz  → 32 ms
    //   • Two MediaStream bridge hops          → ~10 ms
    // Total ≈ 48 ms.  The user can fine-tune via the ± control in the UI.
    this.dtlnDryDelay = this.dtlnContext.createDelay(0.5)
    this.dtlnDryDelay.delayTime.value = this.dtlnLatencyMs / 1000

    // Dry path: dtlnSrc → dtlnDryDelay → dtlnDryGain → dtlnDst
    this.dtlnSrc.connect(this.dtlnDryDelay)
    this.dtlnDryDelay.connect(this.dtlnDryGain)
    this.dtlnDryGain.connect(this.dtlnDst)
    // Wet path: dtlnSrc → worklet → dtlnWetGain → dtlnDst  (connected in initDtln())

    this.dtlnBridgeOut = ctx.createMediaStreamSource(this.dtlnDst.stream)

    this.eqNodes = Array.from({ length: 7 }, () => {
      const n = ctx.createBiquadFilter()
      n.type = 'peaking'
      return n
    })

    // Stage 1: fast peak catcher (1176-style)
    this.compressorStage1 = ctx.createDynamicsCompressor()
    this.compressorStage1.threshold.value = -10
    this.compressorStage1.knee.value = 0
    this.compressorStage1.ratio.value = 1
    this.compressorStage1.attack.value = 0.003
    this.compressorStage1.release.value = 0.05

    // Stage 2: slow LA2A-style (user slider)
    this.compressorStage2 = ctx.createDynamicsCompressor()
    this.compressorStage2.threshold.value = -24
    this.compressorStage2.knee.value = 6
    this.compressorStage2.ratio.value = 1
    this.compressorStage2.attack.value = 0.025
    this.compressorStage2.release.value = 0.35

    this.desibilanceWorklet = null
    this.desibilanceFallback = null
    try {
      this.desibilanceWorklet = new AudioWorkletNode(ctx, 'de-esser-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'max',
      })
    } catch {
      const f = ctx.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = 7000
      f.Q.value = 3
      f.gain.value = 0
      this.desibilanceFallback = f
    }

    this.exciterWaveshaper = ctx.createWaveShaper()
    this.exciterWaveshaper.curve = null
    this.exciterWaveshaper.oversample = '4x'

    this.makeupGain = ctx.createGain()
    this.makeupGain.gain.value = 1

    this.previewNormalizeGain = ctx.createGain()
    this.previewNormalizeGain.gain.value = 1

    try {
      this.limiterWorklet = new AudioWorkletNode(ctx, 'preview-limiter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'max',
      })
      this.limiterWorklet.port.onmessage = (ev) => {
        if (ev.data?.type === 'reduction') {
          this.limiterInterventionDb = ev.data.db ?? 0
        }
      }
    } catch {
      this.limiterCompressor = ctx.createDynamicsCompressor()
      this.limiterCompressor.threshold.value = -1
      this.limiterCompressor.knee.value = 0
      this.limiterCompressor.ratio.value = 20
      this.limiterCompressor.attack.value = 0.003
      this.limiterCompressor.release.value = 0.05
    }

    this.limiterGain = ctx.createGain()
    this.limiterGain.gain.value = 1

    this.processedGain = ctx.createGain()
    this.processedGain.gain.value = 1

    // Bypass path: source → bypassNormalizeGain → bypassGain → masterOut
    this.bypassNormalizeGain = ctx.createGain()
    this.bypassNormalizeGain.gain.value = 1
    this.bypassGain = ctx.createGain()
    this.bypassGain.gain.value = 0

    this.masterOut = ctx.createGain()
    this.masterOut.gain.value = 1

    this.pinkNoiseGain = ctx.createGain()
    this.pinkNoiseGain.gain.value = 0

    const deEsser = this.desibilanceWorklet ?? this.desibilanceFallback

    // Pre-bridge chain: inputNormalizeGain → humChainIn → [humFilters] → humChainOut → eqNodes → dtlnBridgeIn
    // EQ runs before DTLN so the denoiser receives a spectrally balanced signal —
    // the model was trained on typical speech and produces artefacts when fed
    // audio with an abnormal frequency response (e.g. extreme low-mid buildup).
    this.inputNormalizeGain.connect(this.humChainIn)
    // humChainIn → filters → humChainOut already wired by _reconnectHumChain()
    this.connectChain([this.humChainOut, ...this.eqNodes])
    this.eqNodes[this.eqNodes.length - 1].connect(this.dtlnBridgeIn)

    // Post-bridge chain: dtlnBridgeOut → compressors → de-esser → … → masterOut
    this.connectChain([
      this.dtlnBridgeOut,
      this.compressorStage1,
      this.compressorStage2,
      deEsser,
      this.exciterWaveshaper,
      this.makeupGain,
      this.previewNormalizeGain,
      this.limiterWorklet ?? this.limiterCompressor,
      this.limiterGain,
      this.processedGain,
      this.masterOut,
    ])

    // Static bypass chain (source end connected per-play; source changes each play)
    this.bypassNormalizeGain.connect(this.bypassGain)
    this.bypassGain.connect(this.masterOut)

    this.pinkNoiseGain.connect(this.masterOut)
    this.masterOut.connect(ctx.destination)
  }

  /**
   * Asynchronously loads the DTLN AudioWorklet into the 16 kHz context and
   * connects the wet signal path.  Audio plays with full dry bypass until this
   * resolves.  After completion any pending noise params are applied.
   */
  private async initDtln(): Promise<void> {
    if (!this.dtlnContext || !this.dtlnSrc || !this.dtlnDst || !this.dtlnWetGain) return

    // Lazy dynamic import keeps the main bundle free of the heavy DTLN package.
    const { createNoiseSuppressionAudioWorklet } = await import(
      '@workadventure/noise-suppression/audio-worklet'
    ) as { createNoiseSuppressionAudioWorklet: typeof CreateFn }

    const handle = await createNoiseSuppressionAudioWorklet(this.dtlnContext, {
      moduleUrl: '/noise-suppression/audio-worklet-processor.js',
      bypassUntilReady: true,
    })

    // Wait for LiteRT and the DTLN models to finish loading inside the worklet.
    await handle.ready

    // Wire the wet path: dtlnSrc → worklet.node → dtlnWetGain → dtlnDst
    this.dtlnSrc.connect(handle.node)
    handle.node.connect(this.dtlnWetGain)
    this.dtlnWetGain.connect(this.dtlnDst)

    this.dtlnWorkletHandle = handle
    this.dtlnReady = true

    // Apply any slider changes that arrived while we were loading.
    if (this._pendingNoiseParams) {
      this._applyDtlnGains(this._pendingNoiseParams.enabled, this._pendingNoiseParams.amount)
      this._pendingNoiseParams = null
    }
  }

  private _applyDtlnGains(enabled: boolean, amount: number): void {
    if (!this.dtlnContext || !this.dtlnDryGain || !this.dtlnWetGain) return
    const now = this.dtlnContext.currentTime
    const end = now + DTLN_RAMP_S

    // True dry/wet mix: the DelayNode on the dry path compensates for the
    // DTLN worklet's latency so both signals arrive at dtlnDst in phase.
    // amount = 0 → full bypass (dry=1, wet=0)
    // amount = 1 → full denoising (dry=0, wet=1)
    const targetDry = (enabled && amount > 0) ? 1 - amount : 1
    const targetWet = (enabled && amount > 0) ? amount      : 0

    this.dtlnDryGain.gain.cancelScheduledValues(now)
    this.dtlnDryGain.gain.setValueAtTime(this.dtlnDryGain.gain.value, now)
    this.dtlnDryGain.gain.linearRampToValueAtTime(targetDry, end)

    this.dtlnWetGain.gain.cancelScheduledValues(now)
    this.dtlnWetGain.gain.setValueAtTime(this.dtlnWetGain.gain.value, now)
    this.dtlnWetGain.gain.linearRampToValueAtTime(targetWet, end)
  }

  private connectChain(nodes: (AudioNode | null)[]): void {
    const valid = nodes.filter((n): n is AudioNode => n !== null)
    for (let i = 0; i < valid.length - 1; i++) {
      valid[i].connect(valid[i + 1])
    }
  }

  /**
   * (Re)wire the hum filter sub-chain between humChainIn and humChainOut.
   * Called after humFilters array is replaced.
   */
  private _reconnectHumChain(): void {
    if (!this.humChainIn || !this.humChainOut) return
    // Disconnect humChainIn from everything; disconnect each old filter
    try { this.humChainIn.disconnect() } catch { /* already disconnected */ }
    // If there are filters, wire them in series
    if (this.humFilters.length > 0) {
      this.connectChain([this.humChainIn, ...this.humFilters, this.humChainOut])
    } else {
      this.humChainIn.connect(this.humChainOut)
    }
  }

  /**
   * Replace the hum filter bank with dynamically-detected notch filters (auto mode).
   * Falls back to the 4-band manual peaking filters when peaks is empty.
   */
  updateHumFilters(peaks: import('@/types/processing.types').DetectedHumPeak[]): void {
    if (!this.ctx) return
    const ctx = this.ctx

    if (peaks.length === 0) {
      // Restore default 4-band manual filters
      this.humFilters = [50, 100, 150, 200].map((freq) => {
        const n = ctx.createBiquadFilter()
        n.type = 'peaking'
        n.frequency.value = freq
        n.Q.value = 12
        n.gain.value = 0
        return n
      })
    } else {
      // Auto mode: peaking filters with negative gain so the humAmount slider
      // can scale the cut depth continuously (notch type ignores gain).
      this.humFilters = peaks
        .filter((p) => p.enabled)
        .map((p) => {
          const n = ctx.createBiquadFilter()
          n.type = 'peaking'
          n.frequency.value = p.frequency
          n.Q.value = p.q
          n.gain.value = 0  // will be set by updateParams
          return n
        })
    }

    this._reconnectHumChain()
  }

  private startKeepAlive(): void {
    if (!this.ctx) return
    this.keepAliveOsc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    g.gain.value = 0.00001
    this.keepAliveOsc.connect(g)
    g.connect(this.ctx.destination)
    this.keepAliveOsc.start()
  }

  async loadFile(file: File): Promise<AudioBuffer> {
    if (!this.ctx) await this.init()
    const ctx = this.ctx!
    const arrayBuffer = await file.arrayBuffer()
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    this.buffer = decoded
    this.sourceLUFS = this.lufsAnalyzer.analyze(decoded)
    this.pausedAt = 0
    this.trimStart = 0
    this.trimEnd = null

    // Immediately set input normalisation so EQ/compressors receive properly-levelled
    // material before the first updateParams call.
    if (this.inputNormalizeGain && this.ctx) {
      const inputGainDb = DYNAMICS_WORKING_LEVEL_LUFS - this.sourceLUFS
      this.inputNormalizeGain.gain.setValueAtTime(
        dbToLinear(Math.max(-30, Math.min(30, inputGainDb))),
        this.ctx.currentTime,
      )
    }

    this.pinkNoiseBuffer = createPinkNoiseBuffer(ctx)
    const rmsDb = measureRmsDbfs(decoded)
    const pinkLinear = dbToLinear(rmsDb - 15)
    this._pinkNoiseMixLinear = pinkLinear

    this.onFileLoadedCb?.(decoded)
    return decoded
  }

  private _pinkNoiseMixLinear = 0

  getPinkNoiseMixLinear(): number {
    return this._pinkNoiseMixLinear
  }

  play(startFrom?: number): void {
    if (!this.ctx || !this.buffer) return
    this.stop()
    const ctx = this.ctx

    if (startFrom !== undefined) this.pausedAt = startFrom

    // Snap to trim region boundaries
    if (this.pausedAt < this.trimStart) this.pausedAt = this.trimStart
    const effectiveEnd = this.trimEnd ?? this.buffer.duration
    if (this.pausedAt >= effectiveEnd) this.pausedAt = this.trimStart

    this.source = ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.inputNormalizeGain ?? this.humFilters[0] ?? ctx.destination)

    if (this.bypassNormalizeGain) {
      this.source.connect(this.bypassNormalizeGain)
    }

    // Resume the 16 kHz DTLN context if it was suspended (e.g. after tab background).
    this.dtlnContext?.resume().catch(() => { /* best-effort */ })

    this.startPinkNoise()

    this.source.start(0, this.pausedAt)
    this.source.onended = () => {
      if (this.playing) {
        this.playing = false
        this.pausedAt = this.trimStart
        this.stopPinkNoise()
        this.onEnd?.()
      }
    }

    this.startTime = ctx.currentTime
    this.playing = true
    this.startRaf()
    this.startMetering()
  }

  private startPinkNoise(): void {
    if (!this.ctx || !this.pinkNoiseBuffer || !this.pinkNoiseGain) return
    this.stopPinkNoise()
    this.pinkNoiseSource = this.ctx.createBufferSource()
    this.pinkNoiseSource.buffer = this.pinkNoiseBuffer
    this.pinkNoiseSource.loop = true
    this.pinkNoiseSource.connect(this.pinkNoiseGain)
    this.pinkNoiseSource.start()
  }

  private stopPinkNoise(): void {
    try { this.pinkNoiseSource?.stop() } catch { /* */ }
    this.pinkNoiseSource = null
  }

  pause(): void {
    if (!this.playing) return
    this.pausedAt = this.currentTime
    this.source?.stop()
    this.stopPinkNoise()
    this.playing = false
    this.stopRaf()
    this.stopMetering()
  }

  stop(): void {
    try { this.source?.stop() } catch { /* */ }
    this.source = null
    this.stopPinkNoise()
    this.playing = false
    this.stopRaf()
    this.stopMetering()
  }

  seek(time: number): void {
    const wasPlaying = this.playing
    // Detach onended BEFORE stop() so the old source node's async ended-event
    // cannot fire after the new source is already playing (which would set
    // this.playing = false and call onEnd, breaking play/pause state).
    if (this.source) this.source.onended = null
    this.stop()
    const effectiveEnd = this.trimEnd ?? (this.buffer?.duration ?? Infinity)
    this.pausedAt = Math.max(this.trimStart, Math.min(effectiveEnd, time))
    if (wasPlaying) this.play()
  }

  setPinkNoiseEnabled(enabled: boolean, mixLinear: number): void {
    if (!this.pinkNoiseGain || !this.ctx) return
    const now = this.ctx.currentTime
    this.pinkNoiseGain.gain.setTargetAtTime(enabled ? mixLinear : 0, now, 0.05)
  }

  setABMode(mode: 'original' | 'processed'): void {
    if (!this.ctx || !this.processedGain || !this.bypassGain) return
    const now = this.ctx.currentTime
    const fade = 0.01
    if (mode === 'processed') {
      this.bypassGain.gain.linearRampToValueAtTime(0, now + fade)
      this.processedGain.gain.linearRampToValueAtTime(1, now + fade)
    } else {
      this.processedGain.gain.linearRampToValueAtTime(0, now + fade)
      this.bypassGain.gain.linearRampToValueAtTime(1, now + fade)
    }
  }

  updateParams(params: ProcessingParams): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime

    if (params.humAutoMode && params.humDetectedFreqs.length > 0) {
      // Auto mode: peaking filters — gain scaled by humAmount so the slider
      // controls cut depth exactly as in manual mode.
      const enabledPeaks = params.humDetectedFreqs.filter((p) => p.enabled)
      this.humFilters.forEach((f, i) => {
        const peak = enabledPeaks[i]
        if (!peak) return
        f.frequency.setTargetAtTime(peak.frequency, now, 0.05)
        f.Q.setTargetAtTime(peak.q, now, 0.05)
        // gainDb is stored as a negative value from the analyzer; scale by amount
        f.gain.setTargetAtTime(
          params.humEnabled ? peak.gainDb * params.humAmount : 0,
          now, 0.05,
        )
      })
    } else {
      // Manual mode: 4-band peaking filters with harmonic scaling (max -70 dB at fundamental)
      const HUM_HARMONIC_SCALE = [1, 0.7, 0.5, 0.3]
      this.humFilters.forEach((f, i) => {
        const scale = HUM_HARMONIC_SCALE[i] ?? 0.3
        f.Q.setTargetAtTime(params.humQ, now, 0.05)
        if (params.humEnabled) {
          f.gain.setTargetAtTime(-(params.humAmount * 70) * scale, now, 0.05)
        } else {
          f.gain.setTargetAtTime(0, now, 0.05)
        }
      })
    }

    // DTLN dry/wet control.
    // If the worklet is not yet ready we store the params and apply them once it is.
    if (this.dtlnReady) {
      this._applyDtlnGains(params.noiseEnabled, params.noiseAmount)
    } else {
      this._pendingNoiseParams = { enabled: params.noiseEnabled, amount: params.noiseAmount }
    }

    // Keep the dry-path delay node in sync with the user-adjusted latency value.
    if (this.dtlnDryDelay && this.dtlnContext && params.dtlnLatencyMs !== this.dtlnLatencyMs) {
      this.dtlnLatencyMs = params.dtlnLatencyMs
      this.dtlnDryDelay.delayTime.setTargetAtTime(
        params.dtlnLatencyMs / 1000,
        this.dtlnContext.currentTime,
        0.010,   // 10 ms time-constant — smooth but fast
      )
    }

    params.eqBands.forEach((band, i) => {
      const node = this.eqNodes[i]
      if (!node) return
      node.type = band.type
      node.frequency.setTargetAtTime(band.freq, now, 0.016)
      const gain = params.eqEnabled && band.enabled ? band.gain * params.eqIntensity : 0
      if (band.type !== 'highpass' && band.type !== 'lowpass') {
        node.gain.setTargetAtTime(gain, now, 0.016)
      }
      node.Q.setTargetAtTime(band.q, now, 0.016)
    })

    if (this.compressorStage1 && this.compressorStage2) {
      if (params.compressionEnabled) {
        const amount = params.compressionAmount
        const isMixed = params.contentType === 'mixed'

        // Stage 1: peak catcher.
        // Speech: ratio up to 12:1, threshold −8 dBFS.
        // Mixed: capped at 4:1, threshold raised to −4 dBFS to protect music transients.
        const s1ratio = isMixed ? 1 + amount * 3 : 1 + amount * 11
        const s1threshold = isMixed ? -4 : -8
        this.compressorStage1.threshold.setTargetAtTime(s1threshold, now, 0.05)
        this.compressorStage1.ratio.setTargetAtTime(s1ratio, now, 0.05)
        this.compressorStage1.attack.setTargetAtTime(0.003, now, 0.05)
        this.compressorStage1.release.setTargetAtTime(0.05, now, 0.05)

        // Stage 2: LA2A-style — ratio 2:1 … 5:1.
        // Mixed: threshold raised +6 dB so dense speech compression starts later.
        const ratio = 2 + amount * 3
        const threshold = -14 - amount * 18 + (isMixed ? 6 : 0)
        const release = 0.25 + amount * 0.55
        this.compressorStage2.threshold.setTargetAtTime(threshold, now, 0.05)
        this.compressorStage2.ratio.setTargetAtTime(ratio, now, 0.05)
        this.compressorStage2.attack.setTargetAtTime(0.025, now, 0.05)
        this.compressorStage2.release.setTargetAtTime(release, now, 0.05)
      } else {
        this.compressorStage1.ratio.setTargetAtTime(1, now, 0.05)
        this.compressorStage2.ratio.setTargetAtTime(1, now, 0.05)
      }
    }

    if (this.desibilanceWorklet) {
      this._updateWorkletDeEsser(params, now)
    } else if (this.desibilanceFallback) {
      this._updateFallbackDeEsser(params, now)
    }

    if (this.exciterWaveshaper) {
      if (params.exciterEnabled && params.exciterAmount > 0) {
        const curve = params.exciterMode === 'warmth'
          ? createWarmthCurve(params.exciterAmount * 0.5)
          : createSoftClipCurve(params.exciterAmount * 0.4)
        this.exciterWaveshaper.curve = curve as unknown as Float32Array<ArrayBuffer>
      } else {
        this.exciterWaveshaper.curve = null
      }
    }

    this._lastLimiterTarget = params.limiterTarget

    // Bypass path: no inputNormalizeGain — match limiterTarget directly from sourceLUFS.
    if (this.bypassNormalizeGain) {
      const gainDb = Math.max(-30, Math.min(30, params.limiterTarget - this.sourceLUFS))
      this.bypassNormalizeGain.gain.setTargetAtTime(dbToLinear(gainDb), now, 0.08)
    }

    this._applyPreviewNormalize(now)

    if (this.limiterWorklet) {
      const p = this.limiterWorklet.parameters
      p.get('ceiling')?.setTargetAtTime(dbToLinear(-1), now, 0.02)
      p.get('releaseMs')?.setTargetAtTime(50, now, 0.05)
    }
  }

  /** Apply a static makeup gain computed offline — call this when compression params change. */
  setStaticMakeupGainDb(db: number): void {
    if (!this.makeupGain || !this.ctx) return
    this._currentMakeupDb = db
    this.makeupGain.gain.setTargetAtTime(dbToLinear(db), this.ctx.currentTime, 0.1)
    // Recompute previewNormalizeGain so the total chain gain stays at (targetLUFS − sourceLUFS).
    this._applyPreviewNormalize(this.ctx.currentTime)
  }

  /**
   * Adjusts previewNormalizeGain so that the net gain through the full processed
   * chain (inputNormalize + makeupGain + previewNormalize) equals
   * (targetLUFS − sourceLUFS), matching the export's single-gain approach.
   */
  private _applyPreviewNormalize(now: number): void {
    if (!this.previewNormalizeGain) return
    const gainDb = Math.max(-30, Math.min(30,
      this._lastLimiterTarget - DYNAMICS_WORKING_LEVEL_LUFS - this._currentMakeupDb,
    ))
    this.previewNormalizeGain.gain.setTargetAtTime(dbToLinear(gainDb), now, 0.08)
  }

  private _updateWorkletDeEsser(params: ProcessingParams, now: number): void {
    const p = this.desibilanceWorklet!.parameters
    const freqParam = p.get('frequency')
    const threshParam = p.get('threshold')
    const maxRedParam = p.get('maxGainReductionDb')
    const enabledParam = p.get('enabled')
    if (!freqParam || !threshParam || !maxRedParam || !enabledParam) return

    freqParam.setTargetAtTime(params.desibilanceFreq, now, 0.05)
    if (params.desibilanceEnabled && params.desibilanceAmount > 0) {
      const threshDb = -12 - params.desibilanceAmount * 18
      const threshLinear = Math.pow(10, threshDb / 20)
      const maxReductionDb = params.desibilanceAmount * 12
      threshParam.setTargetAtTime(threshLinear, now, 0.05)
      maxRedParam.setTargetAtTime(maxReductionDb, now, 0.05)
      enabledParam.setTargetAtTime(1, now, 0.02)
    } else {
      enabledParam.setTargetAtTime(0, now, 0.02)
    }
  }

  private _updateFallbackDeEsser(params: ProcessingParams, now: number): void {
    const f = this.desibilanceFallback!
    f.frequency.setTargetAtTime(params.desibilanceFreq, now, 0.05)
    const gain = params.desibilanceEnabled && params.desibilanceAmount > 0
      ? -(params.desibilanceAmount * 12)
      : 0
    f.gain.setTargetAtTime(gain, now, 0.05)
  }

  setOnMetering(fn: (m: AudioMetering) => void) { this.onMetering = fn }

  private startMetering(): void {
    const tick = () => {
      if (!this.playing) return
      this.onMetering?.({ limiterInterventionDb: this.limiterInterventionDb })
      this.meterRafId = requestAnimationFrame(tick)
    }
    this.meterRafId = requestAnimationFrame(tick)
  }

  private stopMetering(): void {
    if (this.meterRafId !== null) cancelAnimationFrame(this.meterRafId)
    this.meterRafId = null
  }

  private startRaf(): void {
    const tick = () => {
      const t = this.currentTime
      if (this.trimEnd !== null && t >= this.trimEnd) {
        this.stop()
        this.pausedAt = this.trimStart
        this.onTimeUpdate?.(this.trimStart)
        this.onEnd?.()
        return
      }
      this.onTimeUpdate?.(t)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopRaf(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
  }

  setOnTimeUpdate(fn: (t: number) => void) { this.onTimeUpdate = fn }
  setOnEnd(fn: () => void) { this.onEnd = fn }

  destroy(): void {
    this.stop()
    this.keepAliveOsc?.stop()
    this.dtlnWorkletHandle?.dispose()
    this.dtlnContext?.close()
    this.ctx?.close()
  }
}

export const audioEngine = new AudioEngine()
