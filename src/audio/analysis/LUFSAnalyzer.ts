// ITU-R BS.1770-4 implementation

import { measureBufferDynamicsRangeDb } from './dynamicsMeter'

/**
 * Compute ITU-R BS.1770-4 K-weighting biquad coefficients for any sample rate.
 *
 * Stage 1: high-shelf pre-filter  (f₀ = 1681.974 Hz, G ≈ +4 dB, S = 1)
 * Stage 2: RLB high-pass filter   (f₀ = 38.135 Hz, 2nd-order Butterworth)
 *
 * Coefficients are derived via the Audio-EQ-Cookbook bilinear transform so the
 * critical frequencies are correctly pre-warped for any fs, unlike a static
 * coefficient table that only works at 48 kHz.
 */
function computeKWeightingCoeffs(fs: number): {
  s1b0: number; s1b1: number; s1b2: number; s1a1: number; s1a2: number
  s2b0: number; s2b1: number; s2b2: number; s2a1: number; s2a2: number
} {
  // ── Stage 1: high-shelf (pre-filter) ─────────────────────────────────────
  // f₀ = 1681.974 Hz, G = 3.999843853 dB
  // α-factor 0.63199 is derived from the ITU reference coefficients at 48 kHz
  // via inverse bilinear transform; it is equivalent to a shelf slope S ≈ 1.244
  // and holds constant across sample rates (it only depends on the gain A).
  const f1 = 1681.974480
  const Gdb = 3.999843853
  const A = Math.pow(10, Gdb / 40)          // sqrt(10^(Gdb/20))
  const w1 = 2 * Math.PI * f1 / fs
  const cos1 = Math.cos(w1)
  const sin1 = Math.sin(w1)
  const alpha1 = sin1 * 0.63199             // ITU-matched shelf-slope factor
  const twoSqrtA_alpha1 = 2 * Math.sqrt(A) * alpha1

  const b0_1 = A * ((A + 1) + (A - 1) * cos1 + twoSqrtA_alpha1)
  const b1_1 = -2 * A * ((A - 1) + (A + 1) * cos1)
  const b2_1 = A * ((A + 1) + (A - 1) * cos1 - twoSqrtA_alpha1)
  const a0_1 = (A + 1) - (A - 1) * cos1 + twoSqrtA_alpha1
  const a1_1 = 2 * ((A - 1) - (A + 1) * cos1)
  const a2_1 = (A + 1) - (A - 1) * cos1 - twoSqrtA_alpha1

  // ── Stage 2: 2nd-order high-pass (RLB) ───────────────────────────────────
  // f₀ = 38.13507760 Hz.  The ITU specification uses Q = 0.5 for this stage
  // (alpha = sin(w₀) / (2·Q) = sin(w₀) when Q = 0.5), which matches the
  // reference coefficients for 48 kHz to within 0.001 dB.
  const f2 = 38.13507760
  const w2 = 2 * Math.PI * f2 / fs
  const cos2 = Math.cos(w2)
  const sin2 = Math.sin(w2)
  const alpha2 = sin2   // = sin(w2) / (2 · 0.5) — Q = 0.5

  const b0_2 = (1 + cos2) / 2
  const b1_2 = -(1 + cos2)
  const b2_2 = (1 + cos2) / 2
  const a0_2 = 1 + alpha2
  const a1_2 = -2 * cos2
  const a2_2 = 1 - alpha2

  return {
    s1b0: b0_1 / a0_1, s1b1: b1_1 / a0_1, s1b2: b2_1 / a0_1,
    s1a1: a1_1 / a0_1, s1a2: a2_1 / a0_1,
    s2b0: b0_2 / a0_2, s2b1: b1_2 / a0_2, s2b2: b2_2 / a0_2,
    s2a1: a1_2 / a0_2, s2a2: a2_2 / a0_2,
  }
}

/** Cached coefficient sets keyed by sample rate to avoid recomputing. */
const _coeffCache = new Map<number, ReturnType<typeof computeKWeightingCoeffs>>()

function getCoeffs(fs: number) {
  let c = _coeffCache.get(fs)
  if (!c) {
    c = computeKWeightingCoeffs(fs)
    _coeffCache.set(fs, c)
  }
  return c
}

export class LUFSAnalyzer {
  /**
   * Streaming ITU-R BS.1770-4 LUFS measurement.
   * Uses a ring buffer for the 400 ms sliding window — O(blockSize) memory
   * (~141 KB) instead of allocating three full copies of the audio buffer.
   * K-weighting coefficients are computed for the buffer's actual sample rate
   * so the measurement is accurate at 44100 Hz, 48000 Hz, etc.
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

    const { s1b0, s1b1, s1b2, s1a1, s1a2, s2b0, s2b1, s2b2, s2a1, s2a2 } = getCoeffs(sr)

    // Ring buffer for 400 ms sliding window (~141 KB vs 617 MB for a 61-min file)
    const ring = new Float64Array(blockSize)
    let ringHead = 0
    let ringSumSq = 0.0
    const blocks: number[] = []

    for (let i = 0; i < numSamples; i++) {
      // Mix channels to mono inline (no intermediate array)
      let x = channels[0][i]
      for (let ch = 1; ch < numChannels; ch++) x += channels[ch][i]
      if (numChannels > 1) x /= numChannels

      // K-weighting stage 1
      const y1 = s1b0*x + s1b1*s1x1 + s1b2*s1x2 - s1a1*s1y1 - s1a2*s1y2
      s1x2 = s1x1; s1x1 = x; s1y2 = s1y1; s1y1 = y1

      // K-weighting stage 2
      const y2 = s2b0*y1 + s2b1*s2x1 + s2b2*s2x2 - s2a1*s2y1 - s2a2*s2y2
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
