import type { ProcessingParams } from '@/types/processing.types'
import { createAutoCurve, createTapeCurve, createTubeCurve } from '@/utils/audioMath'
import { compressBufferTwoStage } from './dynamicsMeter'
import { LUFSAnalyzer } from './LUFSAnalyzer'

const PREVIEW_SAMPLE_RATE = 48000
const HUM_HARMONIC_SCALE = [1, 0.7, 0.5, 0.3]
/** Matches preview-limiter-processor.js and FFmpeg alimiter ceiling (−1 dBTP). */
const LIMITER_CEILING_LINEAR = Math.pow(10, -1 / 20)
const LIMITER_RELEASE_SEC = 0.05
/**
 * FFmpeg alimiter asc=1 lowers final integrated LU-I below the pre-limiter target.
 * Preview peak limiter does not replicate this — measured gap ≈ 1.3 dB on speech.
 */
const FFMPEG_ALIMITER_ASC_LUFS_DROP = 1.3
/** LUFS analysis window — full-track render is unnecessary and OOMs on long sermons. */
const ANALYSIS_SEGMENT_SEC = 45

export interface ExportGainStaging {
  /** Restores compressed level to postEq (applied after exciter in export). */
  makeupDb: number
  /** Brings postEq to limiterTarget (export gainDb). */
  gainDb: number
  /** Cancels Chrome DynamicsCompressor auto-makeup to FFmpeg processed level. */
  postCompTrimDb: number
}

async function resampleToPreviewRate(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.sampleRate === PREVIEW_SAMPLE_RATE) return buffer
  const length = Math.ceil(buffer.length * PREVIEW_SAMPLE_RATE / buffer.sampleRate)
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, length, PREVIEW_SAMPLE_RATE)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start(0)
  return ctx.startRendering()
}

/** Representative slice for offline metering — avoids multi-minute OfflineAudioContext renders. */
function sliceForAnalysis(buffer: AudioBuffer): AudioBuffer {
  const maxSamples = Math.min(
    buffer.length,
    Math.floor(buffer.sampleRate * ANALYSIS_SEGMENT_SEC),
  )
  if (maxSamples === buffer.length) return buffer

  const start = Math.min(
    Math.floor(buffer.length * 0.25),
    Math.max(0, buffer.length - maxSamples),
  )
  const { numberOfChannels, sampleRate } = buffer
  const ctx = new OfflineAudioContext(numberOfChannels, maxSamples, sampleRate)
  const out = ctx.createBuffer(numberOfChannels, maxSamples, sampleRate)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    out.copyToChannel(buffer.getChannelData(ch).subarray(start, start + maxSamples), ch)
  }
  return out
}

function connectChain(nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].connect(nodes[i + 1])
  }
}

function buildHumEqChain(
  ctx: BaseAudioContext,
  params: ProcessingParams,
): AudioNode[] {
  const humFilters: BiquadFilterNode[] = []
  if (params.humAutoMode && params.humDetectedFreqs.length > 0) {
    for (const peak of params.humDetectedFreqs) {
      if (!peak.enabled) continue
      const f = ctx.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = peak.frequency
      f.Q.value = peak.q
      f.gain.value = params.humEnabled ? peak.gainDb * params.humAmount : 0
      humFilters.push(f)
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const f = ctx.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = [50, 100, 150, 200][i]
      f.Q.value = params.humQ
      const scale = HUM_HARMONIC_SCALE[i] ?? 0.3
      f.gain.value = params.humEnabled
        ? -(params.humAmount * 70) * scale
        : 0
      humFilters.push(f)
    }
  }

  const eqNodes = params.eqBands.map((band) => {
    const n = ctx.createBiquadFilter()
    n.type = band.type
    n.frequency.value = band.freq
    n.Q.value = band.q
    const gain = params.eqEnabled && band.enabled ? band.gain * params.eqIntensity : 0
    if (band.type !== 'highpass' && band.type !== 'lowpass') {
      n.gain.value = gain
    }
    return n
  })

  return [...humFilters, ...eqNodes]
}

function buildCompressorPair(
  ctx: BaseAudioContext,
  params: ProcessingParams,
): [DynamicsCompressorNode, DynamicsCompressorNode] {
  const comp1 = ctx.createDynamicsCompressor()
  const comp2 = ctx.createDynamicsCompressor()
  if (params.compressionEnabled && params.compressionAmount > 0) {
    const amount = params.compressionAmount
    const isMixed = params.contentType === 'mixed'
    comp1.threshold.value = isMixed ? -4 : -8
    comp1.ratio.value = isMixed ? 1 + amount * 3 : 1 + amount * 11
    comp1.knee.value = 0
    comp1.attack.value = 0.003
    comp1.release.value = 0.05
    comp2.threshold.value = -14 - amount * 18 + (isMixed ? 6 : 0)
    comp2.ratio.value = 2 + amount * 3
    comp2.knee.value = 6
    comp2.attack.value = 0.025
    comp2.release.value = 0.25 + amount * 0.55
  } else {
    comp1.ratio.value = 1
    comp2.ratio.value = 1
  }
  return [comp1, comp2]
}

async function renderPostEqBuffer(
  buffer: AudioBuffer,
  inputGainDb: number,
  params: ProcessingParams,
): Promise<AudioBuffer> {
  const { numberOfChannels, length, sampleRate } = buffer
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const inputGain = ctx.createGain()
  inputGain.gain.value = Math.pow(10, inputGainDb / 20)

  const chain: AudioNode[] = [inputGain, ...buildHumEqChain(ctx, params)]
  source.connect(chain[0])
  connectChain(chain)
  chain[chain.length - 1].connect(ctx.destination)

  source.start(0)
  return ctx.startRendering()
}

async function measureChromeCompLUFS(
  postEqBuffer: AudioBuffer,
  params: ProcessingParams,
): Promise<number> {
  const { numberOfChannels, length, sampleRate } = postEqBuffer
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)

  const source = ctx.createBufferSource()
  source.buffer = postEqBuffer
  const [comp1, comp2] = buildCompressorPair(ctx, params)
  source.connect(comp1)
  comp1.connect(comp2)
  comp2.connect(ctx.destination)
  source.start(0)

  const rendered = await ctx.startRendering()
  return new LUFSAnalyzer().analyze(rendered)
}

function buildExciterNode(ctx: BaseAudioContext, params: ProcessingParams): WaveShaperNode {
  const exciter = ctx.createWaveShaper()
  exciter.oversample = '4x'
  if (params.exciterEnabled && params.exciterAmount > 0) {
    let curve: Float32Array
    if (params.exciterMode === 'tube') {
      curve = createTubeCurve(params.exciterAmount)
    } else if (params.exciterMode === 'tape') {
      curve = createTapeCurve(params.exciterAmount)
    } else {
      curve = createAutoCurve(params.exciterAmount)
    }
    exciter.curve = curve as unknown as Float32Array<ArrayBuffer>
  }
  return exciter
}

async function renderPreLimiterBuffer(
  postEqBuffer: AudioBuffer,
  params: ProcessingParams,
  postCompTrimDb: number,
  makeupDb: number,
): Promise<AudioBuffer> {
  const { numberOfChannels, length, sampleRate } = postEqBuffer
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)

  const source = ctx.createBufferSource()
  source.buffer = postEqBuffer

  const [comp1, comp2] = buildCompressorPair(ctx, params)
  const chain: AudioNode[] = [comp1, comp2]

  if (postCompTrimDb !== 0) {
    const trim = ctx.createGain()
    trim.gain.value = Math.pow(10, postCompTrimDb / 20)
    chain.push(trim)
  }

  chain.push(buildExciterNode(ctx, params))

  const dcBlock = ctx.createBiquadFilter()
  dcBlock.type = 'highpass'
  dcBlock.frequency.value = 10
  dcBlock.Q.value = 0.707
  chain.push(dcBlock)

  if (makeupDb !== 0) {
    const makeup = ctx.createGain()
    makeup.gain.value = Math.pow(10, makeupDb / 20)
    chain.push(makeup)
  }

  source.connect(chain[0])
  connectChain(chain)
  chain[chain.length - 1].connect(ctx.destination)
  source.start(0)

  return ctx.startRendering()
}

function bufferFromChannels(
  channels: Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const ctx = new OfflineAudioContext(channels.length, channels[0].length, sampleRate)
  const out = ctx.createBuffer(channels.length, channels[0].length, sampleRate)
  for (let ch = 0; ch < channels.length; ch++) {
    out.copyToChannel(new Float32Array(channels[ch]), ch)
  }
  return out
}

function applyGainInPlace(channels: Float32Array[], gainDb: number): void {
  const linear = Math.pow(10, gainDb / 20)
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= linear
  }
}

/** Peak limiter on channel arrays (no extra AudioBuffer allocations). */
function limitChannelsInPlace(channels: Float32Array[], sampleRate: number): void {
  const numCh = channels.length
  const channelLen = channels[0].length
  const lookahead = Math.max(1, Math.round(sampleRate * 0.005))
  const releaseCoef = Math.exp(-1 / (sampleRate * LIMITER_RELEASE_SEC))
  const delays = channels.map(() => new Float32Array(lookahead))
  const writeIndices = channels.map(() => 0)
  let gain = 1

  for (let i = 0; i < channelLen; i++) {
    let peak = 0
    for (let ch = 0; ch < numCh; ch++) {
      const sample = channels[ch][i]
      delays[ch][writeIndices[ch]] = sample
      const abs = Math.abs(sample)
      if (abs > peak) peak = abs
    }

    const neededGain = peak > LIMITER_CEILING_LINEAR ? LIMITER_CEILING_LINEAR / peak : 1
    gain = neededGain < gain
      ? neededGain
      : releaseCoef * gain + (1 - releaseCoef)

    for (let ch = 0; ch < numCh; ch++) {
      const readIndex = (writeIndices[ch] + 1) % lookahead
      const limited = delays[ch][readIndex] * gain
      channels[ch][i] = Math.max(-LIMITER_CEILING_LINEAR, Math.min(LIMITER_CEILING_LINEAR, limited))
      writeIndices[ch] = readIndex
    }
  }
}

function measureLimitedLUFS(preLimiterBuffer: AudioBuffer, gainDb: number): number {
  const channels = Array.from(
    { length: preLimiterBuffer.numberOfChannels },
    (_, ch) => new Float32Array(preLimiterBuffer.getChannelData(ch)),
  )
  applyGainInPlace(channels, gainDb)
  limitChannelsInPlace(channels, preLimiterBuffer.sampleRate)
  return new LUFSAnalyzer().analyze(
    bufferFromChannels(channels, preLimiterBuffer.sampleRate),
  )
}

/**
 * Mirrors Transcoder pass-1 loudness references for export-identical gain staging.
 * Uses a short analysis segment so long recordings stay responsive.
 */
export async function computeExportGainStaging(
  buffer: AudioBuffer,
  inputGainDb: number,
  params: ProcessingParams,
  limiterTarget: number,
): Promise<ExportGainStaging> {
  // IMPORTANT: slice BEFORE resampling.
  // Resampling the full buffer first would create a huge OfflineAudioContext
  // (e.g. ~700 MB for a 30-min file at 48 kHz) and crash the iOS tab.
  // Slicing to 45 s first keeps the OfflineAudioContext under ~20 MB.
  const segment = sliceForAnalysis(buffer)
  const resampled = await resampleToPreviewRate(segment)
  const analyzer = new LUFSAnalyzer()

  const postEqBuffer = await renderPostEqBuffer(segment, inputGainDb, params)
  const postEq = analyzer.analyze(postEqBuffer)

  let makeupDb = 0
  let postCompTrimDb = 0

  if (params.compressionEnabled && params.compressionAmount > 0) {
    const compressed = compressBufferTwoStage(
      postEqBuffer,
      params.compressionAmount,
      params.contentType,
    )
    const processed = analyzer.analyze(compressed)
    makeupDb = Math.max(-12, Math.min(12, postEq - processed))

    const chromeComp = await measureChromeCompLUFS(postEqBuffer, params)
    postCompTrimDb = Math.max(-18, Math.min(0, processed - chromeComp))
  }

  const preLimiterBuffer = await renderPreLimiterBuffer(
    postEqBuffer,
    params,
    postCompTrimDb,
    makeupDb,
  )

  let gainDb = Math.max(-30, Math.min(30, limiterTarget - postEq))
  const exportFinalTarget = limiterTarget - FFMPEG_ALIMITER_ASC_LUFS_DROP
  const postLimiter = measureLimitedLUFS(preLimiterBuffer, gainDb)
  gainDb = Math.max(-30, Math.min(30, gainDb - (postLimiter - exportFinalTarget)))

  return { makeupDb, gainDb, postCompTrimDb }
}
