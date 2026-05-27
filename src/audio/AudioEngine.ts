import { audioContextManager } from './AudioContextManager'
import type { ProcessingParams } from '@/types/processing.types'
import { createTubeCurve, createTapeCurve, createAutoCurve, dbToLinear } from '@/utils/audioMath'
import { LUFSAnalyzer } from './analysis/LUFSAnalyzer'
import { createPinkNoiseBuffer, measureRmsDbfs } from './analysis/pinkNoise'
import { DYNAMICS_WORKING_LEVEL_LUFS } from './analysis/dynamicsMeter'
import { decodeAudioFile, decodeChunk, releaseFfmpegInput } from './decodeAudioFile'
import { computeWaveformPeaks, computeWaveformPeaksFromBuffer, type WaveformPeakData } from './WaveformPeaks'
import {
  LUFS_ANALYSIS_MAX_SEC,
  CHUNK_DURATION_SEC,
  CHUNK_PREFETCH_SEC,
  needsChunkedPlayback,
} from '@/utils/mobileAudio'

/** Duration of the noise-gain crossfade ramp in seconds. */
const NOISE_RAMP_S = 0.020   // 20 ms

function analyzeIntegratedLoudness(analyzer: LUFSAnalyzer, buffer: AudioBuffer): number {
  if (buffer.duration <= LUFS_ANALYSIS_MAX_SEC) return analyzer.analyze(buffer)

  const sliceSamples = Math.min(
    buffer.length,
    Math.floor(buffer.sampleRate * LUFS_ANALYSIS_MAX_SEC),
  )
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, sliceSamples, buffer.sampleRate)
  const slice = ctx.createBuffer(buffer.numberOfChannels, sliceSamples, buffer.sampleRate)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    slice.copyToChannel(buffer.getChannelData(ch).subarray(0, sliceSamples), ch)
  }
  return analyzer.analyze(slice)
}

export interface AudioMetering {
  limiterInterventionDb: number
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null

  // ── RNNoise noise-reduction section ────────────────────────────────────────
  /** AudioWorkletNode wrapping the RNNoise WASM processor (48 kHz, mono). */
  private rnnoiseNode: AudioWorkletNode | null = null
  /** True once the RNNoise worklet and WASM have loaded. */
  private rnnoiseReady = false
  /**
   * Delay on the dry bypass path that compensates for RNNoise's internal
   * latency (480 samples / 48 kHz = 10 ms).  Without this the dry and wet
   * signals are ~10 ms apart at partial mix values, which sounds like an echo.
   * 10 ms is imperceptible for listening (well below the 40 ms AV-sync threshold).
   */
  private noiseBypassDelay: DelayNode | null = null
  /**
   * Dry path: carries the original EQ output directly to the compressor.
   * gain = 1 − noiseAmount (full signal when noise is off, fades out when on).
   */
  private noiseBypassGain: GainNode | null = null
  /**
   * Input gate: routes signal into the RNNoise node.
   * gain = 1 when noise is active, 0 otherwise (avoids unnecessary processing).
   */
  private noiseInputGain: GainNode | null = null
  /**
   * Wet output gain: blends the RNNoise output into the compressor.
   * gain = noiseAmount.
   */
  private noiseWetGain: GainNode | null = null
  /** Noise params received before RNNoise finished loading. */
  private _pendingNoiseParams: { enabled: boolean; amount: number } | null = null
  /** Prevents duplicate RNNoise init when init() is called concurrently. */
  private _rnnoiseInitPromise: Promise<void> | null = null

  /** Input anchor of the hum-filter sub-chain. Feeds into the active filter array. */
  private humChainIn: GainNode | null = null
  /** Output anchor of the hum-filter sub-chain. Feeds into the EQ nodes. */
  private humChainOut: GainNode | null = null
  private humFilters: BiquadFilterNode[] = []
  private eqNodes: BiquadFilterNode[] = []
  private compressorStage1: DynamicsCompressorNode | null = null
  private compressorStage2: DynamicsCompressorNode | null = null
  private exciterWaveshaper: WaveShaperNode | null = null
  /** DC-blocking highpass at 10 Hz — removes the tiny DC offset produced by
   *  asymmetric tube biasing. Inaudible on tape/auto-tape paths. */
  private exciterDcBlock: BiquadFilterNode | null = null
  /**
   * Undoes Chrome DynamicsCompressor auto-makeup so the post-compressor level
   * matches FFmpeg's un-makeup'd output (export `processedLUFS` reference).
   */
  private postCompTrim: GainNode | null = null
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
  /** True while a ctx.resume() initiated by play() is in-flight. Cleared by
   *  pause()/stop() so a Pause tap during the ~50 ms resume window cancels
   *  the pending start, and a second Play tap doesn't double-fire. */
  private _resumePending = false
  private trimStart = 0
  private trimEnd: number | null = null

  private onTimeUpdate: ((t: number) => void) | null = null
  private onEnd: (() => void) | null = null
  private onMetering: ((m: AudioMetering) => void) | null = null
  private onFileLoadedCb: ((buffer: AudioBuffer) => void) | null = null
  private rafId: number | null = null
  private meterRafId: number | null = null

  // ── Chunked playback (iOS) ──────────────────────────────────────────────
  private _chunkedMode = false
  private _chunkFile: File | null = null
  private _chunkStartSec = 0
  private _chunkEndSec = 0
  private _totalDuration = 0
  private _isChunkLoading = false
  private _chunkLoadPromise: Promise<void> | null = null
  private _prefetchingChunk = false
  private _waveformPeaks: WaveformPeakData | null = null
  private onChunkLoadingChange: ((loading: boolean) => void) | null = null

  private sourceLUFS = -20
  private limiterInterventionDb = 0
  private readonly lufsAnalyzer = new LUFSAnalyzer()

  /** Tracks the last limiterTarget so preview gain can be adjusted when it changes. */
  private _lastLimiterTarget = -16
  /** Pre-limiter normalisation gain in dB (export gainDb = target − postEq). */
  private _previewNormalizeDb = 0
  private _makeupDb = 0
  private _postCompTrimDb = 0
  /** Bypass (Original) gain in dB — computed by computeExportGainStaging. */
  private _bypassGainDb: number | null = null

  get isPlaying() { return this.playing }
  get loadedLUFS(): number { return this.sourceLUFS }
  get loadedBuffer(): AudioBuffer | null { return this.buffer }
  get isChunkedMode(): boolean { return this._chunkedMode }
  get waveformPeaks(): WaveformPeakData | null { return this._waveformPeaks }
  get isChunkLoading(): boolean { return this._isChunkLoading }
  get chunkStartSec(): number { return this._chunkStartSec }
  get chunkEndSec(): number { return this._chunkEndSec }
  setOnFileLoaded(cb: ((buffer: AudioBuffer) => void) | null): void { this.onFileLoadedCb = cb }
  setOnChunkLoading(cb: ((loading: boolean) => void) | null): void { this.onChunkLoadingChange = cb }

  setTrimStart(t: number): void { this.trimStart = t }
  setTrimEnd(t: number | null): void { this.trimEnd = t }

  get currentTime() {
    if (!this.ctx || !this.playing) return this.pausedAt
    const elapsed = this.ctx.currentTime - this.startTime
    return this.pausedAt + elapsed
  }

  async init(): Promise<void> {
    this.ctx = await audioContextManager.initOnUserGesture()
    this.buildGraph()
    this.startKeepAlive()
    // AudioContext now runs at 48 kHz on all platforms, so RNNoise always works.
    this.initRnnoise().catch((err) => {
      console.warn('[RNNoise] init failed; noise slider will have no effect in preview:', err)
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

    this.exciterDcBlock = ctx.createBiquadFilter()
    this.exciterDcBlock.type = 'highpass'
    this.exciterDcBlock.frequency.value = 10
    this.exciterDcBlock.Q.value = 0.707

    this.postCompTrim = ctx.createGain()
    this.postCompTrim.gain.value = 1

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

    // ── Noise-reduction routing ──────────────────────────────────────────────
    // RNNoise introduces ~10 ms of latency (480 samples at 48 kHz) before its
    // first output frame appears.  We delay the dry bypass path by the same
    // amount so both paths arrive at the compressor in phase; without this
    // a partial mix sounds like an echo.
    const RNNOISE_DELAY_S = 28.65 / 1000   // 28.65 ms (empirisch kalibriert)
    this.noiseBypassDelay = ctx.createDelay(0.1)
    this.noiseBypassDelay.delayTime.value = RNNOISE_DELAY_S

    // Path A (dry): EQ output → noiseBypassDelay → noiseBypassGain → compressor
    //   gain = 1 − noiseAmount; carries the full-quality original signal.
    this.noiseBypassGain = ctx.createGain()
    this.noiseBypassGain.gain.value = 1   // fully dry at startup (no noise reduction)

    // Always-open pass-through: RNNoise receives audio at all times so the
    // RNN hidden state never trains on silence.
    this.noiseInputGain = ctx.createGain()
    this.noiseInputGain.gain.value = 1

    // Path B (wet): EQ output → noiseInputGain → rnnoiseNode → noiseWetGain → compressor
    //   gain = noiseAmount; carries the denoised signal once RNNoise has loaded.
    this.noiseWetGain = ctx.createGain()
    this.noiseWetGain.gain.value = 0

    // Pre-noise chain: inputNormalizeGain → humChain → eqNodes
    this.inputNormalizeGain.connect(this.humChainIn)
    // humChainIn → filters → humChainOut already wired by _reconnectHumChain()
    this.connectChain([this.humChainOut, ...this.eqNodes])

    const lastEq = this.eqNodes[this.eqNodes.length - 1]

    // Dry path: lastEq → noiseBypassDelay → noiseBypassGain → compressorStage1
    lastEq.connect(this.noiseBypassDelay)
    this.noiseBypassDelay.connect(this.noiseBypassGain)
    this.noiseBypassGain.connect(this.compressorStage1!)

    // Wet path feed: lastEq → noiseInputGain (gain=1, fixed) → rnnoiseNode (connected in initRnnoise)
    lastEq.connect(this.noiseInputGain)

    // Wet path output: noiseWetGain → compressorStage1 (rnnoiseNode → noiseWetGain in initRnnoise)
    this.noiseWetGain.connect(this.compressorStage1!)

    // Shared post-noise chain: comp → trim → de-esser → exciter
    // → makeup → normalize → A/B switch → limiter → out
    this.connectChain([
      this.compressorStage1,
      this.compressorStage2,
      this.postCompTrim,
      deEsser,
      this.exciterWaveshaper,
      this.exciterDcBlock,
      this.makeupGain,
      this.previewNormalizeGain,
      this.processedGain,
      this.limiterWorklet ?? this.limiterCompressor,
      this.limiterGain,
      this.masterOut,
    ])

    // Bypass chain also routed through the shared limiter so the original
    // signal is peak-limited identically to the processed one.
    this.bypassNormalizeGain.connect(this.bypassGain)
    const limiterNode = this.limiterWorklet ?? this.limiterCompressor
    if (limiterNode) this.bypassGain.connect(limiterNode)
    else this.bypassGain.connect(this.masterOut!)

    this.pinkNoiseGain.connect(this.masterOut)

    // On iOS the master output is routed through a MediaStreamDestinationNode
    // wired to an <audio> element so that playback uses the media-playback
    // audio session (not the ringer bus).  On all other platforms this falls
    // back to ctx.destination.
    const dest = audioContextManager.outputDestination ?? ctx.destination
    this.masterOut.connect(dest)
  }

  /**
   * Asynchronously loads the RNNoise WASM and connects the wet signal path.
   * Audio plays with full dry bypass until this resolves.
   * After completion any pending noise params are applied.
   */
  /**
   * Load the RNNoise WASM module and connect the wet path in the graph.
   * Runs asynchronously after buildGraph() so audio is immediately available
   * on the fully-dry bypass path while the WASM loads.
   */
  private initRnnoise(): Promise<void> {
    if (this.rnnoiseReady) return Promise.resolve()
    if (this._rnnoiseInitPromise) return this._rnnoiseInitPromise
    this._rnnoiseInitPromise = this._initRnnoiseImpl().finally(() => {
      this._rnnoiseInitPromise = null
    })
    return this._rnnoiseInitPromise
  }

  private async _initRnnoiseImpl(): Promise<void> {
    if (!this.ctx || !this.noiseInputGain || !this.noiseWetGain || this.rnnoiseReady) return

    try {
      await this.ctx.audioWorklet.addModule('/rnnoise.worklet.js')
    } catch {
      // Already registered on this AudioContext — safe to continue.
    }

    const response = await fetch('/rnnoise.wasm')
    if (!response.ok) throw new Error(`Failed to fetch rnnoise.wasm: ${response.status}`)
    const module = await WebAssembly.compile(await response.arrayBuffer())

    if (this.rnnoiseNode) {
      try { this.noiseInputGain.disconnect(this.rnnoiseNode) } catch { /* */ }
      try { this.rnnoiseNode.disconnect() } catch { /* */ }
    }

    this.rnnoiseNode = new AudioWorkletNode(this.ctx, 'rnnoise', {
      channelCountMode: 'explicit',
      channelCount: 1,
      channelInterpretation: 'speakers',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { module },
    })

    // Complete the wet path: noiseInputGain → rnnoiseNode → noiseWetGain
    this.noiseInputGain.connect(this.rnnoiseNode)
    this.rnnoiseNode.connect(this.noiseWetGain)

    this.rnnoiseReady = true

    // Apply any slider changes that arrived while the WASM was loading.
    if (this._pendingNoiseParams) {
      this._applyNoiseGains(this._pendingNoiseParams.enabled, this._pendingNoiseParams.amount)
      this._pendingNoiseParams = null
    }
  }

  /**
   * Smoothly crossfade between the dry bypass path and the RNNoise wet path.
   *
   * Dry path (noiseBypassGain):  gain = 1 − amount  (original signal)
   * Wet path (noiseWetGain):     gain = amount       (RNNoise output)
   * Input gate (noiseInputGain): 1 when active, 0 otherwise
   */
  private _applyNoiseGains(enabled: boolean, amount: number): void {
    if (!this.ctx || !this.noiseBypassGain || !this.noiseWetGain) return

    const isActive = enabled && amount > 0 && this.rnnoiseReady

    const now = this.ctx.currentTime
    const end = now + NOISE_RAMP_S

    const bypassTarget = isActive ? 1 - amount : 1
    const wetTarget    = isActive ? amount      : 0

    const ramp = (node: GainNode, target: number) => {
      node.gain.cancelScheduledValues(now)
      node.gain.setValueAtTime(node.gain.value, now)
      node.gain.linearRampToValueAtTime(target, end)
    }

    ramp(this.noiseBypassGain, bypassTarget)
    ramp(this.noiseWetGain,    wetTarget)
    // noiseInputGain stays permanently at 1 — RNNoise always receives audio so
    // the RNN model never "trains on silence" and its hidden state stays valid.
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
    if (!this.ctx) {
      await this.init()
    }
    const ctx = this.ctx!

    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {})
    }

    // Decide whether to use chunked playback (iOS large files).
    const chunked = needsChunkedPlayback(file)
    this._chunkedMode = chunked
    this._chunkFile = chunked ? file : null
    this._waveformPeaks = null
    this._totalDuration = 0

    if (chunked) {
      return this._loadFileChunked(file, ctx)
    }

    const decoded = await decodeAudioFile(ctx, file, { sampleRate: ctx.sampleRate })
    this.buffer = decoded
    this._waveformPeaks = computeWaveformPeaksFromBuffer(decoded)
    this.sourceLUFS = analyzeIntegratedLoudness(this.lufsAnalyzer, decoded)
    this._resetGainState()

    this._applyInputNormalize()
    this._resetGainNodes()

    this.pinkNoiseBuffer = createPinkNoiseBuffer(ctx)
    const rmsDb = measureRmsDbfs(decoded)
    this._pinkNoiseMixLinear = dbToLinear(rmsDb - 15)

    this.onFileLoadedCb?.(decoded)
    return decoded
  }

  /**
   * Chunked loading: compute waveform peaks from the full file (low-rate),
   * then decode only the first 90 s at 48 kHz for playback.
   */
  private async _loadFileChunked(file: File, ctx: AudioContext): Promise<AudioBuffer> {
    this._setChunkLoading(true)

    // Step 1: compute waveform peaks (low-rate decode + peak extraction)
    const peaks = await computeWaveformPeaks(file)
    this._waveformPeaks = peaks
    this._totalDuration = peaks.duration

    // Step 2: decode first chunk at 48 kHz
    const chunkDur = Math.min(CHUNK_DURATION_SEC, peaks.duration)
    const chunk = await decodeChunk(file, 0, chunkDur)
    this.buffer = chunk
    this._chunkStartSec = 0
    this._chunkEndSec = chunk.duration

    this.sourceLUFS = analyzeIntegratedLoudness(this.lufsAnalyzer, chunk)
    this._resetGainState()

    this._applyInputNormalize()
    this._resetGainNodes()

    this.pinkNoiseBuffer = createPinkNoiseBuffer(ctx)
    const rmsDb = measureRmsDbfs(chunk)
    this._pinkNoiseMixLinear = dbToLinear(rmsDb - 15)

    this._setChunkLoading(false)
    this.onFileLoadedCb?.(chunk)
    return chunk
  }

  private _resetGainState(): void {
    this._previewNormalizeDb = 0
    this._makeupDb = 0
    this._postCompTrimDb = 0
    this._bypassGainDb = null
    this.pausedAt = 0
    this.trimStart = 0
    this.trimEnd = null
  }

  private _applyInputNormalize(): void {
    if (this.inputNormalizeGain && this.ctx) {
      const inputGainDb = DYNAMICS_WORKING_LEVEL_LUFS - this.sourceLUFS
      this.inputNormalizeGain.gain.setValueAtTime(
        dbToLinear(Math.max(-30, Math.min(30, inputGainDb))),
        this.ctx.currentTime,
      )
    }
  }

  private _resetGainNodes(): void {
    if (this.ctx) {
      const now = this.ctx.currentTime
      this.postCompTrim?.gain.setValueAtTime(1, now)
      this.makeupGain?.gain.setValueAtTime(1, now)
      this._applyPreviewNormalize(now)
    }
  }

  private _setChunkLoading(loading: boolean): void {
    this._isChunkLoading = loading
    this.onChunkLoadingChange?.(loading)
  }

  /**
   * Ensure the chunk covering `timeSec` is loaded.
   * Returns immediately if already covered; otherwise decodes a new chunk.
   */
  async ensureChunkAt(timeSec: number): Promise<void> {
    if (!this._chunkedMode || !this._chunkFile) return
    if (timeSec >= this._chunkStartSec && timeSec < this._chunkEndSec) return

    if (this._chunkLoadPromise) {
      await this._chunkLoadPromise
      if (timeSec >= this._chunkStartSec && timeSec < this._chunkEndSec) return
    }

    this._chunkLoadPromise = this._loadChunkAt(timeSec)
    await this._chunkLoadPromise
    this._chunkLoadPromise = null
  }

  private async _loadChunkAt(timeSec: number): Promise<void> {
    if (!this._chunkFile) return
    const wasPlaying = this.playing
    if (wasPlaying) this.pause()

    this._setChunkLoading(true)

    const start = Math.max(0, timeSec - 10)
    const maxDur = this._totalDuration - start
    const dur = Math.min(CHUNK_DURATION_SEC, maxDur)

    const chunk = await decodeChunk(this._chunkFile, start, dur)
    this.buffer = chunk
    this._chunkStartSec = start
    this._chunkEndSec = start + chunk.duration

    this._setChunkLoading(false)

    if (wasPlaying) {
      this.play(timeSec)
    }
  }

  /**
   * Pre-fetch the next chunk in the background when approaching the boundary.
   * Called from the RAF loop during playback.
   */
  private _maybePrefetchChunk(): void {
    if (!this._chunkedMode || !this._chunkFile || this._prefetchingChunk) return
    const t = this.currentTime
    const remaining = this._chunkEndSec - t
    if (remaining > CHUNK_PREFETCH_SEC || remaining < 0) return
    if (this._chunkEndSec >= this._totalDuration) return

    this._prefetchingChunk = true
    const nextStart = Math.max(0, this._chunkEndSec - 5)
    const maxDur = this._totalDuration - nextStart
    const dur = Math.min(CHUNK_DURATION_SEC, maxDur)

    decodeChunk(this._chunkFile, nextStart, dur)
      .then((chunk) => {
        this.buffer = chunk
        this._chunkStartSec = nextStart
        this._chunkEndSec = nextStart + chunk.duration

        if (this.playing) {
          const currentT = this.currentTime
          if (this.source) this.source.onended = null
          this.stop()
          this.play(currentT)
        }
      })
      .catch((err) => {
        console.warn('[AudioEngine] chunk prefetch failed:', err)
      })
      .finally(() => {
        this._prefetchingChunk = false
      })
  }

  /** Total duration in chunked mode (from waveform peaks), or buffer duration. */
  get totalDuration(): number {
    if (this._chunkedMode) return this._totalDuration
    return this.buffer?.duration ?? 0
  }

  private _pinkNoiseMixLinear = 0

  getPinkNoiseMixLinear(): number {
    return this._pinkNoiseMixLinear
  }

  play(startFrom?: number): void {
    if (!this.ctx || !this.buffer) return

    // The play button is a user gesture — restart the iOS <audio> element if
    // it was paused (e.g. the page was backgrounded while loading the file),
    // and also attempt the session unlock as a belt-and-suspenders fallback.
    audioContextManager.resumeIOSStreamOutput()
    audioContextManager.unlockAudioSession()

    // On iOS (and some Android browsers) the AudioContext is suspended whenever
    // the page is backgrounded — including while the native file-picker is open.
    // resume() must be initiated synchronously inside a user-gesture handler.
    // play() is always called from a button click or touch event, so calling
    // resume() here satisfies that constraint.  We wait for it to resolve, then
    // restart play() with the same position so audio starts cleanly.
    if (this.ctx.state === 'suspended') {
      if (this._resumePending) return   // already waiting on a resume
      this._resumePending = true

      // Guard against ctx.resume() hanging indefinitely on iOS (seen in the wild).
      // After 3 s, clear the flag so a subsequent tap can retry.
      const resumeTimer = setTimeout(() => {
        if (this._resumePending) {
          this._resumePending = false
          console.warn('[AudioEngine] ctx.resume() timed out in play(); tap play again')
        }
      }, 3000)

      this.ctx.resume().then(() => {
        clearTimeout(resumeTimer)
        if (this._resumePending && this.buffer) {
          this._resumePending = false
          this.play(startFrom)
        }
      }).catch((err) => {
        clearTimeout(resumeTimer)
        this._resumePending = false
        console.warn('[AudioEngine] ctx.resume() in play() failed:', err)
      })
      return
    }
    this._resumePending = false

    this.stop()
    const ctx = this.ctx

    if (startFrom !== undefined) this.pausedAt = startFrom

    // Snap to trim region boundaries
    if (this.pausedAt < this.trimStart) this.pausedAt = this.trimStart
    const effectiveDuration = this._chunkedMode ? this._totalDuration : this.buffer.duration
    const effectiveEnd = this.trimEnd ?? effectiveDuration
    if (this.pausedAt >= effectiveEnd) this.pausedAt = this.trimStart

    // In chunked mode, offset into the chunk buffer
    const bufferOffset = this._chunkedMode
      ? this.pausedAt - this._chunkStartSec
      : this.pausedAt

    if (bufferOffset < 0 || bufferOffset >= this.buffer.duration) {
      // Position outside loaded chunk — need to load a new chunk first
      if (this._chunkedMode) {
        this.ensureChunkAt(this.pausedAt).then(() => { this.play() })
        return
      }
    }

    this.source = ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.inputNormalizeGain ?? this.humFilters[0] ?? ctx.destination)

    if (this.bypassNormalizeGain) {
      this.source.connect(this.bypassNormalizeGain)
    }

    this.startPinkNoise()

    this.source.start(0, bufferOffset)
    this.source.onended = () => {
      if (this.playing) {
        // In chunked mode, reaching the chunk end doesn't mean the file ended
        if (this._chunkedMode && this.currentTime < effectiveDuration - 0.5) {
          this.ensureChunkAt(this.currentTime).catch(() => {})
          return
        }
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
    this._resumePending = false   // cancel any in-flight ctx.resume() → play() chain
    if (!this.playing) return
    this.pausedAt = this.currentTime
    this.source?.stop()
    this.stopPinkNoise()
    this.playing = false
    this.stopRaf()
    this.stopMetering()
  }

  stop(): void {
    this._resumePending = false
    try { this.source?.stop() } catch { /* */ }
    this.source = null
    this.stopPinkNoise()
    this.playing = false
    this.stopRaf()
    this.stopMetering()
  }

  seek(time: number): void {
    const wasPlaying = this.playing
    if (this.source) this.source.onended = null
    this.stop()
    const effectiveDuration = this._chunkedMode ? this._totalDuration : (this.buffer?.duration ?? Infinity)
    const effectiveEnd = this.trimEnd ?? effectiveDuration
    this.pausedAt = Math.max(this.trimStart, Math.min(effectiveEnd, time))

    // In chunked mode, check if we need a new chunk
    if (this._chunkedMode && (this.pausedAt < this._chunkStartSec || this.pausedAt >= this._chunkEndSec)) {
      this.onTimeUpdate?.(this.pausedAt)
      this.ensureChunkAt(this.pausedAt).then(() => {
        if (wasPlaying) this.play()
        else this.onTimeUpdate?.(this.pausedAt)
      })
      return
    }

    if (wasPlaying) {
      this.play()
    } else {
      this.onTimeUpdate?.(this.pausedAt)
    }
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

    // RNNoise dry/wet control.
    // If the WASM is not yet ready, store and apply once initRnnoise() completes.
    if (this.rnnoiseReady) {
      this._applyNoiseGains(params.noiseEnabled, params.noiseAmount)
    } else {
      this._pendingNoiseParams = { enabled: params.noiseEnabled, amount: params.noiseAmount }
    }

    // Keep the dry-path delay in sync with the user-adjusted latency value.
    if (this.noiseBypassDelay && this.ctx) {
      this.noiseBypassDelay.delayTime.setTargetAtTime(
        params.noiseLatencyMs / 1000,
        this.ctx.currentTime,
        0.010,
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
        let curve: Float32Array
        if (params.exciterMode === 'tube') {
          curve = createTubeCurve(params.exciterAmount)
        } else if (params.exciterMode === 'tape') {
          curve = createTapeCurve(params.exciterAmount)
        } else {
          curve = createAutoCurve(params.exciterAmount)
        }
        this.exciterWaveshaper.curve = curve as unknown as Float32Array<ArrayBuffer>
      } else {
        this.exciterWaveshaper.curve = null
      }
    }

    const prevTarget = this._lastLimiterTarget
    this._lastLimiterTarget = params.limiterTarget
    if (params.limiterTarget !== prevTarget) {
      this._previewNormalizeDb += params.limiterTarget - prevTarget
    }

    // Bypass path gain: use calibrated value from computeExportGainStaging when
    // available; otherwise approximate with the same ASC correction (−1.3 dB)
    // that the processed path applies so A/B is loudness-matched from the start.
    if (this.bypassNormalizeGain) {
      if (this._bypassGainDb !== null) {
        if (params.limiterTarget !== prevTarget) {
          this._bypassGainDb += params.limiterTarget - prevTarget
        }
        this._applyBypassGain(now)
      } else {
        const approxTarget = params.limiterTarget - 1.3
        const gainDb = Math.max(-30, Math.min(30, approxTarget - this.sourceLUFS))
        this.bypassNormalizeGain.gain.setTargetAtTime(dbToLinear(gainDb), now, 0.08)
      }
    }

    this._applyPreviewNormalize(now)

    if (this.limiterWorklet) {
      const p = this.limiterWorklet.parameters
      if (params.limiterEnabled) {
        p.get('ceiling')?.setTargetAtTime(dbToLinear(-1), now, 0.02)
        p.get('releaseMs')?.setTargetAtTime(50, now, 0.05)
      } else {
        p.get('ceiling')?.setTargetAtTime(1, now, 0.02)
      }
    } else if (this.limiterCompressor) {
      if (params.limiterEnabled) {
        this.limiterCompressor.threshold.setTargetAtTime(-1, now, 0.02)
        this.limiterCompressor.ratio.setTargetAtTime(20, now, 0.02)
      } else {
        this.limiterCompressor.ratio.setTargetAtTime(1, now, 0.02)
      }
    }
  }

  /**
   * Apply export-identical two-step gain staging:
   *   postCompTrim (measured) cancels Chrome compressor auto-makeup
   *   makeupGain (+makeupDb) restores to postEq after exciter
   *   previewNormalize (+gainDb) brings postEq to limiterTarget
   *   bypassGainDb — loudness-matched gain for the Original A/B path
   */
  setExportGainStaging(makeupDb: number, gainDb: number, postCompTrimDb?: number, bypassGainDb?: number): void {
    if (!this.ctx || !this.postCompTrim || !this.makeupGain) return
    this._makeupDb = makeupDb
    this._previewNormalizeDb = gainDb
    this._postCompTrimDb = postCompTrimDb ?? (makeupDb > 0 ? -makeupDb : 0)
    const now = this.ctx.currentTime
    if (this.postCompTrim) {
      this.postCompTrim.gain.setTargetAtTime(dbToLinear(this._postCompTrimDb), now, 0.1)
    }
    if (this.makeupGain) {
      this.makeupGain.gain.setTargetAtTime(dbToLinear(makeupDb), now, 0.1)
    }
    this._applyPreviewNormalize(now)

    if (bypassGainDb !== undefined) {
      this._bypassGainDb = bypassGainDb
      this._applyBypassGain(now)
    }
  }

  /** @deprecated Use setExportGainStaging — kept for dynamics UI hook. */
  setStaticMakeupGainDb(_db: number): void { /* no-op */ }

  /** @deprecated Use setExportGainStaging. */
  setPreviewNormalizeDb(db: number): void {
    this.setExportGainStaging(this._makeupDb, db)
  }

  /** Applies the offline-measured normalisation gain before the limiter. */
  private _applyPreviewNormalize(now: number): void {
    if (!this.previewNormalizeGain) return
    const gainDb = Math.max(-30, Math.min(30, this._previewNormalizeDb))
    this.previewNormalizeGain.gain.setTargetAtTime(dbToLinear(gainDb), now, 0.08)
  }

  /** Applies the offline-computed bypass gain (loudness-matched to processed). */
  private _applyBypassGain(now: number): void {
    if (!this.bypassNormalizeGain || this._bypassGainDb === null) return
    const gainDb = Math.max(-30, Math.min(30, this._bypassGainDb))
    this.bypassNormalizeGain.gain.setTargetAtTime(dbToLinear(gainDb), now, 0.08)
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
      // Pre-fetch next chunk when approaching boundary
      if (this._chunkedMode) this._maybePrefetchChunk()
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
    this.ctx?.close()
    if (this._chunkedMode) releaseFfmpegInput()
  }
}

export const audioEngine = new AudioEngine()
