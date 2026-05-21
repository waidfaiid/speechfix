/**
 * Long-Term Average Spectrum (LTAS) reference for professional speech recordings.
 *
 * Based on Byrne et al. (1994) international LTAS study and EBU broadcast standards,
 * adjusted toward professionally processed speech (podcast/broadcast):
 * - Reduced low-end buildup (proximity effect removed)
 * - Enhanced presence at 2–5 kHz for clarity and intelligibility
 * - Natural roll-off above 8 kHz
 *
 * Values are relative dB, normalized so the mean over 250–4000 Hz ≈ 0 dB.
 * Stored on the same 512-point log grid (20–20000 Hz) as the EQ graph.
 */

const ANCHOR_POINTS: [number, number][] = [
  [20,    -70],
  [40,    -48],
  [80,    -26],
  [100,   -14],
  [150,    -7],
  [200,    -3],
  [300,    -1],
  [400,     0],
  [500,     0],
  [700,    -1],
  [1000,   -2],
  [1500,   -2],
  [2000,   -1],  // presence boost for broadcast speech
  [2500,   -2],
  [3000,   -3],
  [4000,   -6],
  [5000,   -9],
  [6300,  -13],
  [8000,  -17],
  [10000, -22],
  [12500, -28],
  [16000, -36],
  [20000, -46],
]

const GRID_POINTS = 512
const MIN_FREQ = 20
const MAX_FREQ = 20000

/** Log-linear interpolation between anchor points */
function interpolateAnchors(freq: number): number {
  const pts = ANCHOR_POINTS
  if (freq <= pts[0][0]) return pts[0][1]
  if (freq >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]

  for (let i = 0; i < pts.length - 1; i++) {
    const [f0, g0] = pts[i]
    const [f1, g1] = pts[i + 1]
    if (freq >= f0 && freq <= f1) {
      const t = (Math.log(freq / f0)) / (Math.log(f1 / f0))
      return g0 + t * (g1 - g0)
    }
  }
  return 0
}

function buildReferenceLTAS(): Float32Array {
  const curve = new Float32Array(GRID_POINTS)
  for (let i = 0; i < GRID_POINTS; i++) {
    const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / (GRID_POINTS - 1))
    curve[i] = interpolateAnchors(freq)
  }
  return curve
}

export const SPEECH_REFERENCE_LTAS: Float32Array = buildReferenceLTAS()

/** Flat reference (all-zero relative dB) — no spectral shaping applied. Used for mixed content. */
export const FLAT_REFERENCE_LTAS: Float32Array = new Float32Array(512)

/** Frequency in Hz for grid index i */
export function gridFreq(i: number): number {
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / (GRID_POINTS - 1))
}

/** Grid index for a given frequency */
export function freqToGridIndex(freq: number): number {
  return Math.round(
    ((Math.log(freq / MIN_FREQ)) / (Math.log(MAX_FREQ / MIN_FREQ))) * (GRID_POINTS - 1)
  )
}

/**
 * Normalize a 512-point LTAS curve so its mean over the 250–4000 Hz band = 0 dB.
 * Both measured and reference must be normalized the same way before comparison.
 */
export function normalizeLTAS(ltas: Float32Array): Float32Array {
  const lo = freqToGridIndex(250)
  const hi = freqToGridIndex(4000)
  let sum = 0
  let count = 0
  for (let i = lo; i <= hi; i++) {
    sum += ltas[i]
    count++
  }
  const mean = sum / count
  const out = new Float32Array(GRID_POINTS)
  for (let i = 0; i < GRID_POINTS; i++) {
    out[i] = ltas[i] - mean
  }
  return out
}
