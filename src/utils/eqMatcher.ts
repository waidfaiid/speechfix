/**
 * EQ Matching via zone-constrained Weighted Least-Squares fitting with Q refinement.
 *
 * Algorithm:
 *  1. Divide the spectrum into 6 fixed speech zones (Schall, Körper, Klarheit,
 *     Präsenz, Brillanz, Luft). Each zone owns exactly one adjustable EQ band.
 *     This prevents bands clustering in the sub-bass.
 *  2. Within each zone, find the frequency with the largest |ref − measured|.
 *  3. Solve optimal gains with Weighted Least-Squares (WLS).
 *     Weights: 3× in the 500 Hz–4 kHz presence range (most important for speech),
 *              1.5× in 100–500 Hz and 4–12 kHz, 0.1× below 80 Hz (HP already there).
 *  4. Refine Q per band: grid-search 8 Q values, re-solve gains, keep best residual.
 *  5. Final WLS solve with optimised (freq, Q) → final gains clamped to ±12 dB.
 */

import type { EQBand } from '@/types/audio.types'
import { gridFreq, freqToGridIndex, normalizeLTAS } from '@/utils/speechReferenceLTAS'

const GRID_POINTS = 512
const SAMPLE_RATE = 48000

const HP_ID = 'hp'
const ADJUSTABLE_IDS = ['mud', 'body', 'presence1', 'presence2', 'articulation', 'air']

// ---------------------------------------------------------------------------
// Speech zones – each adjustable band is locked to one perceptual zone.
// Zones may slightly overlap so the algorithm can find the peak inside either edge.
// ---------------------------------------------------------------------------

interface Zone {
  id:    string
  label: string
  loHz:  number
  hiHz:  number
  type:  BiquadFilterType
  defQ:  number
}

const SPEECH_ZONES: Zone[] = [
  { id: 'mud',          label: 'Bass',     loHz: 80,    hiHz: 300,   type: 'lowshelf', defQ: 0.7 },
  { id: 'body',         label: 'Körper',   loHz: 200,   hiHz: 700,   type: 'peaking',  defQ: 2.0 },
  { id: 'presence1',    label: 'Mitten',   loHz: 600,   hiHz: 1500,  type: 'peaking',  defQ: 2.0 },
  { id: 'presence2',    label: 'Präsenz',  loHz: 1200,  hiHz: 4000,  type: 'peaking',  defQ: 2.0 },
  { id: 'articulation', label: 'Zwischen', loHz: 3500,  hiHz: 9000,  type: 'peaking',  defQ: 2.0 },
  { id: 'air',          label: 'Klarheit', loHz: 7000,  hiHz: 16000, type: 'highshelf',defQ: 0.7 },
]

const Q_CANDIDATES_PEAKING: number[] = [0.4, 0.6, 0.8, 1.0, 1.4, 2.0, 3.0, 5.0]
const Q_CANDIDATES_SHELF:   number[] = [0.5, 0.7, 1.0]

// ---------------------------------------------------------------------------
// Perceptual weights for WLS (emphasis on speech presence range)
// ---------------------------------------------------------------------------

function buildWeights(): Float32Array {
  const w = new Float32Array(GRID_POINTS)
  for (let i = 0; i < GRID_POINTS; i++) {
    const f = gridFreq(i)
    if      (f < 80)                  w[i] = 0.05  // below HP – nearly ignore
    else if (f < 200)                 w[i] = 0.8
    else if (f < 500)                 w[i] = 1.5
    else if (f <= 4000)               w[i] = 3.0   // presence range – most important
    else if (f <= 12000)              w[i] = 1.5
    else                              w[i] = 0.5
  }
  return w
}

const WEIGHTS = buildWeights()

// ---------------------------------------------------------------------------
// Biquad frequency response – same formula as EQGraph.tsx for consistency
// ---------------------------------------------------------------------------

function biquadResponseDB(
  type: BiquadFilterType,
  freq: number,
  q: number,
  gainDB: number,
  evalFreq: number
): number {
  const w0 = (2 * Math.PI * freq) / SAMPLE_RATE
  const A  = Math.pow(10, gainDB / 40)
  const alpha = Math.sin(w0) / (2 * q)
  const w = (2 * Math.PI * evalFreq) / SAMPLE_RATE

  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0

  if (type === 'peaking') {
    b0 = 1 + alpha * A;  b1 = -2 * Math.cos(w0); b2 = 1 - alpha * A
    a0 = 1 + alpha / A;  a1 = b1;                 a2 = 1 - alpha / A
  } else if (type === 'highshelf') {
    b0 = A * ((A+1) + (A-1)*Math.cos(w0) + 2*Math.sqrt(A)*alpha)
    b1 = -2*A * ((A-1) + (A+1)*Math.cos(w0))
    b2 = A * ((A+1) + (A-1)*Math.cos(w0) - 2*Math.sqrt(A)*alpha)
    a0 = (A+1) - (A-1)*Math.cos(w0) + 2*Math.sqrt(A)*alpha
    a1 = 2 * ((A-1) - (A+1)*Math.cos(w0))
    a2 = (A+1) - (A-1)*Math.cos(w0) - 2*Math.sqrt(A)*alpha
  } else if (type === 'lowshelf') {
    b0 = A * ((A+1) - (A-1)*Math.cos(w0) + 2*Math.sqrt(A)*alpha)
    b1 = 2*A * ((A-1) - (A+1)*Math.cos(w0))
    b2 = A * ((A+1) - (A-1)*Math.cos(w0) - 2*Math.sqrt(A)*alpha)
    a0 = (A+1) + (A-1)*Math.cos(w0) + 2*Math.sqrt(A)*alpha
    a1 = -2 * ((A-1) + (A+1)*Math.cos(w0))
    a2 = (A+1) + (A-1)*Math.cos(w0) - 2*Math.sqrt(A)*alpha
  } else {
    return 0
  }

  const cosW = Math.cos(w)
  const sinW = Math.sin(w)
  const cos2w = 2 * cosW * cosW - 1
  const sin2w = 2 * sinW * cosW
  const reN = b0 + b1 * cosW + b2 * cos2w
  const imN = -(b1 * sinW + b2 * sin2w)
  const reD = a0 + a1 * cosW + a2 * cos2w
  const imD = -(a1 * sinW + a2 * sin2w)
  const magSq = (reN*reN + imN*imN) / Math.max(reD*reD + imD*imD, 1e-30)
  return 10 * Math.log10(Math.max(magSq, 1e-20))
}

// ---------------------------------------------------------------------------
// 6×6 matrix operations for normal equations
// ---------------------------------------------------------------------------

type Matrix6 = number[][]

function solveLinear6(A: Matrix6, b: number[]): number[] {
  const M = A.map((row, i) => [...row, b[i]])
  const n = 6
  for (let col = 0; col < n; col++) {
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    ;[M[col], M[maxRow]] = [M[maxRow], M[col]]
    if (Math.abs(M[col][col]) < 1e-12) continue
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col]
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n]
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j]
    x[i] /= M[i][i] || 1
  }
  return x
}

// ---------------------------------------------------------------------------
// Weighted Least-Squares: build A matrix and solve for band gains
// ---------------------------------------------------------------------------

/** A[i][j] = response of band j (with gainDB=1) at grid point i */
function buildResponseMatrix(adjBands: EQBand[]): number[][] {
  return Array.from({ length: GRID_POINTS }, (_, i) => {
    const f = gridFreq(i)
    return adjBands.map(b => biquadResponseDB(b.type, b.freq, b.q, 1, f))
  })
}

function solveGains(diff: Float32Array, adjBands: EQBand[]): number[] {
  const A = buildResponseMatrix(adjBands)
  // Weighted normal equations: AtWA · x = AtWb
  const AtA: Matrix6 = Array.from({ length: 6 }, () => new Array(6).fill(0))
  const Atb = new Array<number>(6).fill(0)
  for (let i = 0; i < GRID_POINTS; i++) {
    const wi = WEIGHTS[i]
    const bi = diff[i] * wi
    for (let j = 0; j < 6; j++) {
      Atb[j] += A[i][j] * bi
      for (let k = 0; k < 6; k++) AtA[j][k] += A[i][j] * A[i][k] * wi
    }
  }
  return solveLinear6(AtA, Atb)
}

// ---------------------------------------------------------------------------
// Weighted residual norm (for Q optimisation comparison)
// ---------------------------------------------------------------------------

function weightedResidualNorm(diff: Float32Array, adjBands: EQBand[]): number {
  let norm = 0
  for (let i = 0; i < GRID_POINTS; i++) {
    let res = diff[i]
    for (const b of adjBands) {
      res -= biquadResponseDB(b.type, b.freq, b.q, b.gain, gridFreq(i))
    }
    norm += WEIGHTS[i] * res * res
  }
  return norm
}

// ---------------------------------------------------------------------------
// Zone-based frequency selection
// ---------------------------------------------------------------------------

function findBestFreqInZone(diff: Float32Array, loHz: number, hiHz: number): number {
  const lo = Math.max(0, freqToGridIndex(loHz))
  const hi = Math.min(GRID_POINTS - 1, freqToGridIndex(hiHz))
  let bestIdx = Math.round((lo + hi) / 2)
  let bestAbs = 0
  for (let i = lo; i <= hi; i++) {
    // Weight the diff by the perceptual weight so important deviations win
    const score = Math.abs(diff[i]) * WEIGHTS[i]
    if (score > bestAbs) { bestAbs = score; bestIdx = i }
  }
  return gridFreq(bestIdx)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampGain(g: number): number {
  if (!isFinite(g)) return 0
  return Math.max(-12, Math.min(12, g))
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute optimal EQ bands to match measuredLTAS → referenceLTAS.
 *
 * Returns a new EQBand[] where the HP band is unchanged and the 6 adjustable
 * bands have updated label, freq, type, q, and gain.
 */
export function computeEQCorrection(
  measuredLTAS: Float32Array,
  referenceLTAS: Float32Array,
  currentBands: EQBand[]
): EQBand[] {
  const measured  = normalizeLTAS(measuredLTAS)
  const reference = normalizeLTAS(referenceLTAS)

  const diff = new Float32Array(GRID_POINTS)
  for (let i = 0; i < GRID_POINTS; i++) diff[i] = reference[i] - measured[i]

  // --- Step 1: Zone-based frequency placement ---
  const adjBands: EQBand[] = SPEECH_ZONES.map(zone => ({
    id:      zone.id,
    label:   zone.label,
    freq:    Math.round(findBestFreqInZone(diff, zone.loHz, zone.hiHz)),
    type:    zone.type,
    q:       zone.defQ,
    gain:    0,
    enabled: true,
  }))

  // --- Step 2: Initial WLS solve ---
  const gains0 = solveGains(diff, adjBands)
  adjBands.forEach((b, j) => { b.gain = clampGain(gains0[j]) })

  // --- Step 3: Q refinement – grid-search per band ---
  for (let j = 0; j < adjBands.length; j++) {
    const band = adjBands[j]
    const candidates = band.type === 'peaking' ? Q_CANDIDATES_PEAKING : Q_CANDIDATES_SHELF
    let bestQ    = band.q
    let bestNorm = weightedResidualNorm(diff, adjBands)

    for (const q of candidates) {
      const testBands = adjBands.map((b, i) => i === j ? { ...b, q } : b)
      const testGains = solveGains(diff, testBands)
      const testFinal = testBands.map((b, i) => ({ ...b, gain: clampGain(testGains[i]) }))
      const norm = weightedResidualNorm(diff, testFinal)
      if (norm < bestNorm) { bestNorm = norm; bestQ = q }
    }

    adjBands[j] = { ...band, q: bestQ }
  }

  // --- Step 4: Final WLS solve with optimised Q ---
  const gainsFinal = solveGains(diff, adjBands)
  adjBands.forEach((b, j) => {
    b.gain = clampGain(gainsFinal[j])
    // Bands not meaningfully used default to Q=2 (neutral bandwidth)
    if (b.type === 'peaking' && Math.abs(b.gain) < 0.5) {
      b.q = 2.0
    }
  })

  // Merge back: keep HP band untouched, replace all adjustable bands
  const adjMap = new Map(adjBands.map(b => [b.id, b]))
  return currentBands.map(b => b.id === HP_ID ? b : (adjMap.get(b.id) ?? b))
}
