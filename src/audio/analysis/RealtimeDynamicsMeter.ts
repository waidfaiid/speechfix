import { DYNAMICS_SILENCE_DBFS, DYNAMICS_WINDOW_SEC } from './dynamicsMeter'

function spreadDb(sorted: number[]): number {
  if (sorted.length < 2) return 0
  const p = (q: number) => {
    const idx = (sorted.length - 1) * q
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    if (lo === hi) return sorted[lo]
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }
  return Math.max(0, p(0.8) - p(0.2))
}

/**
 * Accumulates 300 ms RMS windows from live analyser samples (same rules as offline).
 */
export class RealtimeDynamicsMeter {
  private windowSamples: number
  private ring: number[] = []
  private readonly maxWindows: number
  private accumSq = 0
  private accumCount = 0

  constructor(sampleRate: number, historySec = 6) {
    this.windowSamples = Math.max(1, Math.round(sampleRate * DYNAMICS_WINDOW_SEC))
    const windowsPerSec = 1 / 0.15
    this.maxWindows = Math.ceil(historySec * windowsPerSec)
  }

  reset(sampleRate?: number): void {
    if (sampleRate) {
      this.windowSamples = Math.max(1, Math.round(sampleRate * DYNAMICS_WINDOW_SEC))
    }
    this.ring = []
    this.accumSq = 0
    this.accumCount = 0
  }

  /** Feed mono float samples from AnalyserNode.getFloatTimeDomainData. */
  pushSamples(samples: Float32Array<ArrayBufferLike>): number {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]
      this.accumSq += s * s
      this.accumCount++

      if (this.accumCount >= this.windowSamples) {
        const rms = Math.sqrt(this.accumSq / this.accumCount)
        const db = 20 * Math.log10(rms || 1e-12)
        if (db > DYNAMICS_SILENCE_DBFS) {
          this.ring.push(db)
          while (this.ring.length > this.maxWindows) this.ring.shift()
        }
        this.accumSq = 0
        this.accumCount = 0
      }
    }
    return this.getDynamicsDb()
  }

  getDynamicsDb(): number {
    if (this.ring.length < 2) return 0
    return spreadDb([...this.ring].sort((a, b) => a - b))
  }
}
