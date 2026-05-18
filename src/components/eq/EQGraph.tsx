import { useEffect, useRef, useCallback } from 'react'
import type { EQBand } from '@/types/audio.types'
import { normalizeLTAS, freqToGridIndex } from '@/utils/speechReferenceLTAS'

interface EQGraphProps {
  bands: EQBand[]
  selectedBandId: string | null
  onBandSelect: (id: string) => void
  onBandChange: (id: string, freq: number, gain: number) => void
  onBandQChange: (id: string, q: number) => void
  /** Raw 512-point LTAS of the loaded file (from LTASAnalyzer) */
  measuredLTAS?: Float32Array | null
  /** Raw 512-point reference LTAS (SPEECH_REFERENCE_LTAS) */
  referenceLTAS?: Float32Array | null
}

const MIN_FREQ = 20
const MAX_FREQ = 20000
const MIN_GAIN = -18
const MAX_GAIN = 18
const GRID_POINTS = 512

// Horizontal padding (logical px) reserved for dB labels on each side
const PAD = 28

function freqToX(freq: number, width: number): number {
  return PAD + (Math.log10(freq / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * (width - PAD * 2)
}

function xToFreq(x: number, width: number): number {
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, (x - PAD) / (width - PAD * 2))
}

function gainToY(gain: number, height: number): number {
  return ((MAX_GAIN - gain) / (MAX_GAIN - MIN_GAIN)) * height
}

function yToGain(y: number, height: number): number {
  return MAX_GAIN - (y / height) * (MAX_GAIN - MIN_GAIN)
}

function computeFreqResponse(bands: EQBand[], sampleRate = 48000): Float32Array {
  const points = GRID_POINTS
  const response = new Float32Array(points).fill(0)

  for (const band of bands) {
    if (!band.enabled) continue
    const w0 = (2 * Math.PI * band.freq) / sampleRate
    const A = Math.pow(10, band.gain / 40)
    const alpha = Math.sin(w0) / (2 * band.q)

    let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0

    if (band.type === 'peaking') {
      b0 = 1 + alpha * A; b1 = -2 * Math.cos(w0); b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * Math.cos(w0); a2 = 1 - alpha / A
    } else if (band.type === 'highshelf') {
      b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha)
      b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0))
      b2 = A * ((A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha)
      a0 = (A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha
      a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0))
      a2 = (A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha
    } else if (band.type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha)
      b1 = 2 * A * ((A - 1) - (A + 1) * Math.cos(w0))
      b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha)
      a0 = (A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha
      a1 = -2 * ((A - 1) + (A + 1) * Math.cos(w0))
      a2 = (A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha
    } else if (band.type === 'highpass') {
      b0 = (1 + Math.cos(w0)) / 2; b1 = -(1 + Math.cos(w0)); b2 = (1 + Math.cos(w0)) / 2
      a0 = 1 + alpha; a1 = -2 * Math.cos(w0); a2 = 1 - alpha
    } else {
      continue
    }

    for (let i = 0; i < points; i++) {
      const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / points)
      const w = (2 * Math.PI * freq) / sampleRate
      const cos_w = Math.cos(w)
      const sin_w = Math.sin(w)
      const cos2w = 2 * cos_w * cos_w - 1
      const sin2w = 2 * sin_w * cos_w
      const re_num = b0 + b1 * cos_w + b2 * cos2w
      const im_num = -(b1 * sin_w + b2 * sin2w)
      const re_den = a0 + a1 * cos_w + a2 * cos2w
      const im_den = -(a1 * sin_w + a2 * sin2w)
      const magSq = (re_num ** 2 + im_num ** 2) / Math.max(re_den ** 2 + im_den ** 2, 1e-30)
      response[i] += 20 * Math.log10(Math.max(Math.sqrt(magSq), 1e-6))
    }
  }
  return response
}

const LTAS_DISPLAY_LIMIT = 14

function drawLTASCurvePair(
  ctx: CanvasRenderingContext2D,
  measuredRaw: Float32Array,
  referenceRaw: Float32Array,
  W: number,
  H: number
) {
  const measNorm = normalizeLTAS(measuredRaw)
  const refNorm  = normalizeLTAS(referenceRaw)

  const lo = freqToGridIndex(80)
  const hi = freqToGridIndex(16000)
  let maxAbs = 1
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(measNorm[i]) > maxAbs) maxAbs = Math.abs(measNorm[i])
    if (Math.abs(refNorm[i])  > maxAbs) maxAbs = Math.abs(refNorm[i])
  }
  const scale = maxAbs > LTAS_DISPLAY_LIMIT ? LTAS_DISPLAY_LIMIT / maxAbs : 1

  const drawOne = (norm: Float32Array, color: string, alpha: number) => {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    for (let i = 0; i < GRID_POINTS; i++) {
      const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / (GRID_POINTS - 1))
      const x = freqToX(freq, W)
      const db = Math.max(MIN_GAIN, Math.min(MAX_GAIN, norm[i] * scale))
      const y = gainToY(db, H)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.restore()
  }

  drawOne(refNorm,  '#2dd4bf', 0.45)
  drawOne(measNorm, '#f59e0b', 0.55)
}

export function EQGraph({
  bands,
  selectedBandId,
  onBandSelect,
  onBandChange,
  onBandQChange,
  measuredLTAS,
  referenceLTAS,
}: EQGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef<{
    id: string; startX: number; startY: number; startFreq: number; startGain: number
    isHP: boolean
  } | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    const dpr = window.devicePixelRatio || 1

    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // --- Frequency grid lines ---
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    ;[50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
      const x = freqToX(f, W)
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    })

    // --- Gain grid lines + dB labels ---
    const DB_LINES = [-12, -6, 0, 6, 12]
    DB_LINES.forEach((g) => {
      const y = gainToY(g, H)
      ctx.strokeStyle = g === 0 ? '#4b5563' : '#1f2937'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()

      const label = g === 0 ? '0' : (g > 0 ? `+${g}` : `${g}`)
      ctx.fillStyle = '#4b5563'
      ctx.font = '9px system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(label, PAD - 3, y + 3)
      ctx.textAlign = 'left'
      ctx.fillText(label, W - PAD + 3, y + 3)
    })

    // --- LTAS curves ---
    if (measuredLTAS && measuredLTAS.length === GRID_POINTS &&
        referenceLTAS && referenceLTAS.length === GRID_POINTS) {
      drawLTASCurvePair(ctx, measuredLTAS, referenceLTAS, W, H)
    } else if (referenceLTAS && referenceLTAS.length === GRID_POINTS) {
      const refNorm = normalizeLTAS(referenceLTAS)
      ctx.save(); ctx.globalAlpha = 0.45; ctx.beginPath()
      ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 1.5
      for (let i = 0; i < GRID_POINTS; i++) {
        const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / (GRID_POINTS - 1))
        const x = freqToX(freq, W)
        const y = gainToY(Math.max(MIN_GAIN, Math.min(MAX_GAIN, refNorm[i])), H)
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke(); ctx.restore()
    }

    // --- EQ filter response ---
    const response = computeFreqResponse(bands)
    ctx.beginPath()
    ctx.strokeStyle = '#6366f1'
    ctx.lineWidth = 2.5
    for (let i = 0; i < response.length; i++) {
      const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / response.length)
      const x = freqToX(freq, W)
      const y = gainToY(Math.max(MIN_GAIN, Math.min(MAX_GAIN, response[i])), H)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // --- Band handle dots (including HP band) ---
    bands.forEach((band) => {
      const isHP = band.type === 'highpass'
      // HP handle sits on the 0 dB line at its corner frequency
      const x = freqToX(band.freq, W)
      const y = isHP ? gainToY(0, H) : gainToY(band.gain, H)
      const isSelected = band.id === selectedBandId
      const r = isSelected ? 9 : 6

      ctx.beginPath()
      if (isHP) {
        // Diamond shape for highpass to visually distinguish it
        ctx.moveTo(x,     y - r)
        ctx.lineTo(x + r, y)
        ctx.lineTo(x,     y + r)
        ctx.lineTo(x - r, y)
        ctx.closePath()
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }
      ctx.fillStyle = band.enabled ? (isSelected ? '#6366f1' : '#818cf8') : '#374151'
      ctx.fill()
      if (isSelected) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Show gain dB next to the dot for the selected band (non-HP)
      if (isSelected && !isHP && Math.abs(band.gain) >= 0.5) {
        const label = `${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB`
        ctx.fillStyle = '#a5b4fc'
        ctx.font = 'bold 10px system-ui, sans-serif'
        ctx.textAlign = x > W * 0.75 ? 'right' : 'left'
        const tx = x > W * 0.75 ? x - r - 4 : x + r + 4
        ctx.fillText(label, tx, y - r - 3)
      }
    })
  }, [bands, selectedBandId, measuredLTAS, referenceLTAS])

  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => { draw() })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [draw])

  function getBandAtPoint(x: number, y: number, canvas: HTMLCanvasElement) {
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    return bands.find((band) => {
      const bx = freqToX(band.freq, W)
      const by = band.type === 'highpass' ? gainToY(0, H) : gainToY(band.gain, H)
      return Math.hypot(x - bx, y - by) < 16
    })
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const band = getBandAtPoint(x, y, canvas)
    if (band) {
      onBandSelect(band.id)
      dragging.current = {
        id: band.id,
        startX: x, startY: y,
        startFreq: band.freq, startGain: band.gain,
        isHP: band.type === 'highpass',
      }
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragging.current) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    const freq = Math.max(20, Math.min(MAX_FREQ, xToFreq(x, W)))

    if (dragging.current.isHP) {
      // HP band: only horizontal movement (frequency), clamp to 20–300 Hz
      onBandChange(dragging.current.id, Math.round(Math.min(300, freq)), 0)
    } else {
      const gain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, yToGain(y, H)))
      onBandChange(dragging.current.id, Math.round(freq), parseFloat(gain.toFixed(1)))
    }
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!selectedBandId) return
    const band = bands.find((b) => b.id === selectedBandId)
    if (!band || band.type === 'highpass') return
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    const newQ = Math.max(0.1, Math.min(10, band.q + delta))
    onBandQChange(selectedBandId, parseFloat(newQ.toFixed(2)))
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-44 cursor-crosshair"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={() => { dragging.current = null }}
      onMouseLeave={() => { dragging.current = null }}
      onWheel={onWheel}
    />
  )
}
