// ITU-R BS.1770-4 implementation

import { measureBufferDynamicsRangeDb } from './dynamicsMeter'

export class LUFSAnalyzer {
  // K-weighting stage 1 (pre-filter, 48kHz)
  private static readonly S1_B0 = 1.53512485958697
  private static readonly S1_B1 = -2.69169618940638
  private static readonly S1_B2 = 1.19839281085285
  private static readonly S1_A1 = -1.69065929318241
  private static readonly S1_A2 = 0.73248077421585
  // K-weighting stage 2 (RLB, 48kHz)
  private static readonly S2_B0 = 1.0
  private static readonly S2_B1 = -2.0
  private static readonly S2_B2 = 1.0
  private static readonly S2_A1 = -1.99004745483398
  private static readonly S2_A2 = 0.99007225036621

  /**
   * Streaming ITU-R BS.1770-4 LUFS measurement.
   * Uses a ring buffer for the 400 ms sliding window — O(blockSize) memory
   * (~141 KB) instead of allocating three full copies of the audio buffer.
   */
  analyze(buffer: AudioBuffer): number {
    const sr = buffer.sampleRate
    const blockSize = Math.floor(sr * 0.4)
    const hopSize  = Math.floor(sr * 0.1)
    const numSamples  = buffer.length
    const numChannels = buffer.numberOfChannels

    // Channel data refs — no copy
    const channels: Float32Array[] = []
    for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch))

    // K-weighting IIR states (flat scalars — faster than object property access in hot loop)
    let s1x1 = 0, s1x2 = 0, s1y1 = 0, s1y2 = 0
    let s2x1 = 0, s2x2 = 0, s2y1 = 0, s2y2 = 0

    // Ring buffer for 400 ms sliding window (~141 KB vs 617 MB for a 61-min file)
    const ring = new Float64Array(blockSize)
    let ringHead = 0
    let ringSumSq = 0.0
    const blocks: number[] = []

    const { S1_B0, S1_B1, S1_B2, S1_A1, S1_A2 } = LUFSAnalyzer
    const { S2_B0, S2_B1, S2_B2, S2_A1, S2_A2 } = LUFSAnalyzer

    for (let i = 0; i < numSamples; i++) {
      // Mix channels to mono inline (no intermediate array)
      let x = channels[0][i]
      for (let ch = 1; ch < numChannels; ch++) x += channels[ch][i]
      if (numChannels > 1) x /= numChannels

      // K-weighting stage 1
      const y1 = S1_B0*x + S1_B1*s1x1 + S1_B2*s1x2 - S1_A1*s1y1 - S1_A2*s1y2
      s1x2 = s1x1; s1x1 = x; s1y2 = s1y1; s1y1 = y1

      // K-weighting stage 2
      const y2 = S2_B0*y1 + S2_B1*s2x1 + S2_B2*s2x2 - S2_A1*s2y1 - S2_A2*s2y2
      s2x2 = s2x1; s2x1 = y1; s2y2 = s2y1; s2y1 = y2

      // Update ring buffer — subtract outgoing, add incoming
      const old = ring[ringHead]
      ring[ringHead] = y2
      ringSumSq -= old * old
      ringSumSq += y2 * y2
      ringHead = (ringHead + 1) % blockSize

      // Emit a 400 ms block every 100 ms once the ring is full
      if (i >= blockSize - 1 && (i - blockSize + 1) % hopSize === 0) {
        blocks.push(ringSumSq / blockSize)
      }
    }

    if (blocks.length === 0) return -70

    const absGate = Math.pow(10, -70 / 10)
    const gated1 = blocks.filter((b) => b > absGate)
    if (gated1.length === 0) return -70

    const ungated = gated1.reduce((a, b) => a + b, 0) / gated1.length
    const relGate = ungated * Math.pow(10, -10 / 10)
    const gated2 = gated1.filter((b) => b > relGate)
    if (gated2.length === 0) return -70

    const mean = gated2.reduce((a, b) => a + b, 0) / gated2.length
    return -0.691 + 10 * Math.log10(mean)
  }
}

export function analyzeDynamics(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0)
  let sumSq = 0
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    sumSq += data[i] * data[i]
    if (Math.abs(data[i]) > peak) peak = Math.abs(data[i])
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / data.length) || 1e-9)
  const peakDb = 20 * Math.log10(peak || 1e-9)
  const crestFactor = peakDb - rmsDb
  const dynamicsRangeDb = measureBufferDynamicsRangeDb(buffer)

  const category =
    dynamicsRangeDb > 14 ? 'very_dynamic' :
    dynamicsRangeDb > 8 ? 'normal' :
    dynamicsRangeDb > 4 ? 'compressed' : 'clipped'

  return {
    rms: rmsDb,
    peak: peakDb,
    crestFactor,
    dynamicsRangeDb,
    dynamicsCategory: category as 'very_dynamic' | 'normal' | 'compressed' | 'clipped',
    suggestedThreshold: rmsDb + crestFactor * 0.25,
    suggestedRatio: category === 'very_dynamic' ? 6 : category === 'normal' ? 4 : category === 'compressed' ? 2 : 8,
    hasHum: false,
    hasNoise: false,
  }
}
