import { audioContextManager } from './AudioContextManager'
import type { ProcessingParams } from '@/types/processing.types'
import { createSoftClipCurve, createWarmthCurve } from '@/utils/audioMath'

export class AudioEngine {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null

  // Processing nodes
  private humFilters: BiquadFilterNode[] = []
  private noiseGate: DynamicsCompressorNode | null = null
  private noiseHP: BiquadFilterNode | null = null
  private eqNodes: BiquadFilterNode[] = []
  private compressor: DynamicsCompressorNode | null = null
  private exciterWaveshaper: WaveShaperNode | null = null
  private exciterGain: GainNode | null = null
  private limiterGain: GainNode | null = null
  private processedGain: GainNode | null = null
  private bypassGain: GainNode | null = null
  private masterOut: GainNode | null = null
  private keepAliveOsc: OscillatorNode | null = null

  private startTime = 0
  private pausedAt = 0
  private playing = false

  private onTimeUpdate: ((t: number) => void) | null = null
  private onEnd: (() => void) | null = null
  private rafId: number | null = null

  get isPlaying() { return this.playing }
  get currentTime() {
    if (!this.ctx || !this.playing) return this.pausedAt
    return this.pausedAt + (this.ctx.currentTime - this.startTime)
  }

  async init(): Promise<void> {
    this.ctx = await audioContextManager.initOnUserGesture()
    this.buildGraph()
    this.startKeepAlive()
  }

  private buildGraph(): void {
    if (!this.ctx) return
    const ctx = this.ctx

    // Hum removal: 4 notch filters, start with gain=0 (no effect)
    this.humFilters = [50, 100, 150, 200].map((freq) => {
      const n = ctx.createBiquadFilter()
      n.type = 'notch'
      n.frequency.value = freq
      n.Q.value = 30
      return n
    })

    // High-pass for LF cleanup (always on, fixed at 80Hz)
    this.noiseHP = ctx.createBiquadFilter()
    this.noiseHP.type = 'highpass'
    this.noiseHP.frequency.value = 80
    this.noiseHP.Q.value = 0.7

    // Noise "gate" preview: a gentle high-shelf cut to simulate noise floor reduction.
    // Real denoising happens in FFmpeg on export. ratio=1 = transparent bypass.
    this.noiseGate = ctx.createDynamicsCompressor()
    this.noiseGate.threshold.value = -100
    this.noiseGate.knee.value = 30
    this.noiseGate.ratio.value = 1   // 1:1 = bypass until explicitly enabled
    this.noiseGate.attack.value = 0.02
    this.noiseGate.release.value = 0.3

    // EQ (7 bands)
    this.eqNodes = Array.from({ length: 7 }, () => {
      const n = ctx.createBiquadFilter()
      n.type = 'peaking'
      return n
    })

    // Compressor — starts bypassed (ratio=1)
    this.compressor = ctx.createDynamicsCompressor()
    this.compressor.threshold.value = -24
    this.compressor.knee.value = 8
    this.compressor.ratio.value = 1
    this.compressor.attack.value = 0.015
    this.compressor.release.value = 0.15

    // Exciter waveshaper — null curve = transparent passthrough
    this.exciterWaveshaper = ctx.createWaveShaper()
    this.exciterWaveshaper.curve = null
    this.exciterWaveshaper.oversample = '4x'
    this.exciterGain = ctx.createGain()
    this.exciterGain.gain.value = 1

    // Safety true-peak limiter: fixed at -0.5dBTP, never changes.
    // LUFS normalization is for export only, not the preview.
    this.limiterGain = ctx.createGain()
    this.limiterGain.gain.value = 0.94

    // A/B gains
    this.processedGain = ctx.createGain()
    this.processedGain.gain.value = 1
    this.bypassGain = ctx.createGain()
    this.bypassGain.gain.value = 0

    this.masterOut = ctx.createGain()
    this.masterOut.gain.value = 1

    this.connectChain([
      ...this.humFilters,
      this.noiseHP,
      this.noiseGate,
      ...this.eqNodes,
      this.compressor,
      this.exciterWaveshaper,
      this.limiterGain,
      this.processedGain,
      this.masterOut,
    ])

    this.masterOut.connect(ctx.destination)
  }

  private connectChain(nodes: AudioNode[]): void {
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].connect(nodes[i + 1])
    }
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
    this.pausedAt = 0
    return decoded
  }

  play(startFrom?: number): void {
    if (!this.ctx || !this.buffer) return
    this.stop()
    const ctx = this.ctx

    if (startFrom !== undefined) this.pausedAt = startFrom

    this.source = ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.humFilters[0] ?? ctx.destination)
    this.source.start(0, this.pausedAt)
    this.source.onended = () => {
      if (this.playing) {
        this.playing = false
        this.pausedAt = 0
        this.onEnd?.()
      }
    }

    // Bypass connection
    if (this.bypassGain && this.masterOut) {
      this.source.connect(this.bypassGain)
      this.bypassGain.connect(this.masterOut)
    }

    this.startTime = ctx.currentTime
    this.playing = true
    this.startRaf()
  }

  pause(): void {
    if (!this.playing) return
    this.pausedAt = this.currentTime
    this.source?.stop()
    this.playing = false
    this.stopRaf()
  }

  stop(): void {
    try { this.source?.stop() } catch { /* already stopped */ }
    this.source = null
    this.playing = false
    this.stopRaf()
  }

  seek(time: number): void {
    const wasPlaying = this.playing
    this.stop()
    this.pausedAt = time
    if (wasPlaying) this.play()
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

    // Hum: notch filters only reduce when enabled — gain stays at 0 when off
    // BiquadFilter 'notch' type doesn't use gain, so no-op. Bypass by setting Q
    // very low (flat response) when disabled.
    this.humFilters.forEach((f) => {
      f.Q.setTargetAtTime(
        params.humEnabled ? 10 + params.humAmount * 20 : 0.01,
        now, 0.05,
      )
    })

    // Noise gate preview: when disabled keep ratio=1 (transparent).
    // When enabled, apply a very gentle gate — real denoising is FFmpeg export only.
    if (this.noiseGate) {
      if (params.noiseEnabled) {
        const threshold = -70 + params.noiseAmount * 30  // -70 to -40 dBFS
        this.noiseGate.threshold.setTargetAtTime(threshold, now, 0.05)
        this.noiseGate.ratio.setTargetAtTime(1 + params.noiseAmount * 2, now, 0.05) // 1:1 to 3:1
      } else {
        // ratio=1 is a true bypass for DynamicsCompressor
        this.noiseGate.ratio.setTargetAtTime(1, now, 0.05)
      }
    }

    // EQ
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

    // Compressor: ratio=1 = full bypass. Threshold range -12dB (gentle) to -36dB (heavy).
    if (this.compressor) {
      if (params.compressionEnabled) {
        const threshold = -12 - params.compressionAmount * 24  // -12 to -36 dB
        this.compressor.threshold.setTargetAtTime(threshold, now, 0.05)
        this.compressor.ratio.setTargetAtTime(1 + params.compressionAmount * 5, now, 0.05) // 1:1 to 6:1
      } else {
        this.compressor.ratio.setTargetAtTime(1, now, 0.05)
      }
    }

    // Exciter: null curve = transparent passthrough when disabled
    if (this.exciterWaveshaper) {
      if (params.exciterEnabled && params.exciterAmount > 0) {
        const curve = params.exciterMode === 'warmth'
          ? createWarmthCurve(params.exciterAmount * 0.5)   // half-strength to avoid distortion
          : createSoftClipCurve(params.exciterAmount * 0.4)
        this.exciterWaveshaper.curve = curve as unknown as Float32Array<ArrayBuffer>
      } else {
        this.exciterWaveshaper.curve = null
      }
    }

    // limiterGain stays fixed at 0.94 — LUFS normalization is export-only
  }

  private startRaf(): void {
    const tick = () => {
      this.onTimeUpdate?.(this.currentTime)
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
  }
}

export const audioEngine = new AudioEngine()
