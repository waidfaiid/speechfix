export function linearToDb(linear: number): number {
  if (linear <= 0) return -Infinity
  return 20 * Math.log10(linear)
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function formatDb(db: number): string {
  if (!isFinite(db)) return '-∞ dB'
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

export function formatLufs(lufs: number): string {
  if (!isFinite(lufs)) return '--- LUFS'
  return `${lufs.toFixed(1)} LUFS`
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function estimateExportSize(
  durationSeconds: number,
  format: string,
  quality: string,
): number {
  const bitrateMap: Record<string, Record<string, number>> = {
    mp3:  { low: 96, medium: 192, high: 320, lossless: 320 },
    aac:  { low: 96, medium: 192, high: 256, lossless: 256 },
    ogg:  { low: 80, medium: 160, high: 240, lossless: 240 },
    flac: { low: 800, medium: 800, high: 800, lossless: 800 },
    wav:  { low: 1411, medium: 1411, high: 1411, lossless: 1411 },
    m4a:  { low: 96, medium: 192, high: 256, lossless: 256 },
  }
  const kbps = bitrateMap[format]?.[quality] ?? 192
  return (kbps * 1000 / 8) * durationSeconds
}

/**
 * WHY THE PREVIOUS CURVES CAUSED LOUDNESS / DISTORTION ARTIFACTS
 * ---------------------------------------------------------------
 * The old normalization was:  f(x) = tanh(x·drive) / tanh(drive)
 * This keeps the PEAK output at ±1, but the small-signal gain (slope at x=0)
 * equals drive / tanh(drive).  At intensity=0.1 that is already ×1.54 (+3.8 dB).
 * Every quiet passage was loudened before the saturation even kicked in.
 *
 * THE FIX — unity small-signal gain via dry/wet blend
 * ----------------------------------------------------
 * Normalise by `drive` (not `tanh(drive)`):
 *   sat(x) = tanh(x·drive) / drive
 *   slope at 0 = drive·sech²(0) / drive = 1   ← always unity
 *
 * Then blend with the dry signal:
 *   f(x) = x·(1−wet) + sat(x)·wet
 *   slope at 0 = (1−wet)·1 + wet·1 = 1   ← still unity for any wet value
 *
 * Peaks are gently compressed (not amplified), the average level stays the
 * same, and the wet amount controls how much harmonic character is added.
 *
 * PARAMETER CALIBRATION (approximate peak compression at typical speech levels):
 *   intensity 10 %  → ~0.1 dB  (barely perceptible — just a hint of character)
 *   intensity 30 %  → ~0.6 dB  (subtle warmth, clearly there when A/B'd)
 *   intensity 50 %  → ~1.5 dB  (distinct character, musical)
 *   intensity 100 % → ~5.8 dB  (strong, noticeable — but never harsh)
 *
 * The wet amount uses a power curve (intensity^1.3) so the first 20 % feel
 * gentle and the upper half of the knob delivers real saturation character.
 */

/**
 * Tube saturation — asymmetric biased tanh, unity small-signal gain.
 * Produces even-order harmonics (2nd, 4th) → warmth & body.
 * DC offset from the bias is removed by the HP filter downstream.
 */
export function createTubeCurve(intensity: number): Float32Array {
  const N    = 4096
  const curve = new Float32Array(N)
  const drive = 1 + intensity * 3.25                  // +30 %: 1.0 → 4.25
  const bias  = 0.08 * intensity
  const wet   = Math.pow(intensity, 1.3) * 0.88        // +30 %: max ~0.88
  const dc    = Math.tanh(bias * drive) / drive
  for (let i = 0; i < N; i++) {
    const x   = (i * 2) / N - 1
    const sat = Math.tanh((x + bias) * drive) / drive - dc
    curve[i]  = Math.max(-1, Math.min(1, x * (1 - wet) + sat * wet))
  }
  return curve
}

/**
 * Tape saturation — symmetric tanh, unity small-signal gain.
 * Produces odd-order harmonics (3rd, 5th) → presence & natural peak limiting.
 * Slightly higher drive than tube so odd-harmonic presence is clearly audible.
 */
export function createTapeCurve(intensity: number): Float32Array {
  const N    = 4096
  const curve = new Float32Array(N)
  const drive = 1 + intensity * 3.65                  // +30 %: 1.0 → 4.65
  const wet   = Math.pow(intensity, 1.3) * 0.80        // +30 %: max ~0.80
  for (let i = 0; i < N; i++) {
    const x   = (i * 2) / N - 1
    const sat = Math.tanh(x * drive) / drive
    curve[i]  = Math.max(-1, Math.min(1, x * (1 - wet) + sat * wet))
  }
  return curve
}

/**
 * Auto curve — blends tube and tape with unity gain throughout.
 *
 * 0 – 30 %  → tube only, wet follows power curve up to ~0.19 at 30 %
 * 30 – 40 % → crossfade region
 * 40 – 100% → tube stays full, tape fades in (up to 50 % of blend weight)
 */
export function createAutoCurve(intensity: number): Float32Array {
  const N    = 4096
  const curve = new Float32Array(N)

  // Tube ramps 0 → 1 over first 30 %
  const t = Math.min(1, intensity / 0.3)
  // Tape ramps 0 → 1 over 40 – 100 %
  const p = Math.max(0, (intensity - 0.4) / 0.6)

  if (t <= 0) {
    for (let i = 0; i < N; i++) curve[i] = (i * 2) / N - 1
    return curve
  }

  const tubeDrive = 1 + intensity * 3.25             // matches createTubeCurve
  const bias      = 0.08 * t
  const tubeWet   = Math.pow(intensity, 1.3) * 0.88
  const dc        = Math.tanh(bias * tubeDrive) / tubeDrive

  const tapeDrive = p > 0 ? 1 + p * 3.65 : 1
  const tapeWet   = p > 0 ? Math.pow(p, 1.3) * 0.80 : 0
  const tubeBlend = 1 - p * 0.5
  const tapeBlend = p * 0.5

  for (let i = 0; i < N; i++) {
    const x       = (i * 2) / N - 1
    const tubeSat = Math.tanh((x + bias) * tubeDrive) / tubeDrive - dc
    const tubeY   = x * (1 - tubeWet) + tubeSat * tubeWet

    if (p <= 0) {
      curve[i] = Math.max(-1, Math.min(1, tubeY))
    } else {
      const tapeSat = Math.tanh(x * tapeDrive) / tapeDrive
      const tapeY   = x * (1 - tapeWet) + tapeSat * tapeWet
      curve[i] = Math.max(-1, Math.min(1, tubeY * tubeBlend + tapeY * tapeBlend))
    }
  }
  return curve
}
