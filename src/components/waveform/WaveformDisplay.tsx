import { useEffect, useRef, useCallback, useState } from 'react'
import { useAudioStore } from '@/store/useAudioStore'
import { useProcessingStore } from '@/store/useProcessingStore'
import { audioEngine } from '@/audio/AudioEngine'
import { cn } from '@/utils/cn'

interface WaveformDisplayProps {
  file: File
}

interface TrimMarkerProps {
  /** Canvas-space position (0–1) */
  position: number
  onDrag: (canvasFraction: number) => void
  side: 'start' | 'end'
  color?: 'red' | 'green'
}

function TrimMarker({ position, onDrag, side, color = 'red' }: TrimMarkerProps) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const waveformContainer = (e.currentTarget as HTMLElement).closest('[data-waveform-container]') as HTMLElement | null
    if (!waveformContainer) return
    const rect = waveformContainer.getBoundingClientRect()

    function onMouseMove(ev: MouseEvent) {
      const fraction = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      onDrag(fraction)
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [onDrag])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const waveformContainer = (e.currentTarget as HTMLElement).closest('[data-waveform-container]') as HTMLElement | null
    if (!waveformContainer) return
    const rect = waveformContainer.getBoundingClientRect()

    function onTouchMove(ev: TouchEvent) {
      if (ev.touches.length === 0) return
      ev.preventDefault()
      const fraction = Math.max(0, Math.min(1, (ev.touches[0].clientX - rect.left) / rect.width))
      onDrag(fraction)
    }
    function onTouchEnd() {
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
  }, [onDrag])

  // Hide marker when out of visible canvas range
  if (position < -0.02 || position > 1.02) return null

  const lineColor = color === 'green' ? '#22c55e' : '#ef4444'

  return (
    <div
      className="absolute top-0 bottom-0 z-20 flex flex-col items-center"
      style={{ left: `${position * 100}%`, transform: 'translateX(-50%)', cursor: 'ew-resize', width: '24px', touchAction: 'none' }}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      <div className="w-0.5 h-full opacity-90" style={{ backgroundColor: lineColor }} />
      <div
        className="absolute"
        style={{
          width: 0, height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: side === 'start' ? `7px solid ${lineColor}` : undefined,
          borderBottom: side === 'end' ? `7px solid ${lineColor}` : undefined,
          top: side === 'start' ? 0 : undefined,
          bottom: side === 'end' ? 0 : undefined,
          position: 'absolute',
        }}
      />
    </div>
  )
}

/** Render waveform bars for the given audio fraction window [viewStart, viewEnd]. */
function renderWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  viewStart = 0,
  viewEnd = 1,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.offsetWidth
  const h = canvas.offsetHeight
  if (w <= 0 || h <= 0) return

  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  ctx.scale(dpr, dpr)

  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, w, h)

  const data = buffer.getChannelData(0)
  const totalSamples = data.length
  const startSample = Math.floor(viewStart * totalSamples)
  const endSample   = Math.ceil(viewEnd * totalSamples)
  const visibleCount = Math.max(1, endSample - startSample)
  const samplesPerPx = visibleCount / w
  const mid = h / 2
  const scanStride = Math.max(1, Math.floor(visibleCount / Math.max(w * 16, 2048)))

  // Peak normalisation across visible window (strided for long recordings)
  let peak = 0.001
  for (let i = startSample; i < endSample; i += scanStride) {
    const abs = Math.abs(data[i])
    if (abs > peak) peak = abs
  }

  for (let x = 0; x < w; x++) {
    const s = startSample + Math.floor(x * samplesPerPx)
    const e = Math.min(endSample - 1, startSample + Math.ceil((x + 1) * samplesPerPx))
    const innerStride = Math.max(1, Math.floor((e - s + 1) / 128))
    let mn = 0, mx = 0
    for (let i = s; i <= e; i += innerStride) {
      const v = data[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    const normMx = mx / peak
    const normMn = mn / peak
    const barY = mid - normMx * mid
    const barH = Math.max(1, (normMx - normMn) * mid)
    ctx.fillStyle = '#6366f1'
    ctx.fillRect(x, barY, 1, barH)
  }
}

export function WaveformDisplay({ file }: WaveformDisplayProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const bufferRef    = useRef<AudioBuffer | null>(null)

  // Zoom state stored in a ref so event handlers always see current values,
  // plus a version counter to trigger React re-renders.
  const zoomRef = useRef({ zoom: 1, viewStart: 0 })
  const [zoomVersion, setZoomVersion] = useState(0)

  const setCurrentTime = useAudioStore((s) => s.setCurrentTime)
  const isLoading      = useAudioStore((s) => s.isLoading)
  const analysisStatus = useProcessingStore((s) => s.analysisStatus)
  const analysisProgress = useProcessingStore((s) => s.analysisProgress)
  const currentTime    = useAudioStore((s) => s.currentTime)
  const duration       = useAudioStore((s) => s.duration)
  const trimStart      = useAudioStore((s) => s.trimStart)
  const trimEnd        = useAudioStore((s) => s.trimEnd)
  const setTrimStart   = useAudioStore((s) => s.setTrimStart)
  const setTrimEnd     = useAudioStore((s) => s.setTrimEnd)

  // Noise profile region (hum auto mode)
  const humAutoMode           = useProcessingStore((s) => s.humAutoMode)
  const humNoiseProfileStart  = useProcessingStore((s) => s.humNoiseProfileStart)
  const humNoiseProfileEnd    = useProcessingStore((s) => s.humNoiseProfileEnd)
  const setHumNoiseProfileStart = useProcessingStore((s) => s.setHumNoiseProfileStart)
  const setHumNoiseProfileEnd   = useProcessingStore((s) => s.setHumNoiseProfileEnd)

  const isAnalyzing = isLoading || analysisStatus === 'running'
  const loadingProgress = isLoading
    ? 20
    : analysisStatus === 'running'
    ? Math.round(33 + analysisProgress * 67)
    : 100

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getView() {
    const { zoom, viewStart } = zoomRef.current
    const viewEnd = Math.min(1, viewStart + 1 / zoom)
    return { zoom, viewStart, viewEnd }
  }

  function redrawWaveform() {
    if (!bufferRef.current || !canvasRef.current) return
    const { viewStart, viewEnd } = getView()
    renderWaveform(canvasRef.current, bufferRef.current, viewStart, viewEnd)
  }

  /** Apply a new zoom level keeping `cursorFrac` (canvas 0-1) anchored in audio space. */
  function applyZoom(newZoom: number, cursorFrac: number) {
    newZoom = Math.max(1, Math.min(100, newZoom))
    const { zoom, viewStart } = zoomRef.current
    const audioCursorPos = viewStart + cursorFrac / zoom
    const newViewStart = Math.max(0, Math.min(1 - 1 / newZoom, audioCursorPos - cursorFrac / newZoom))
    zoomRef.current = { zoom: newZoom, viewStart: newViewStart }
    redrawWaveform()
    setZoomVersion(v => v + 1)
  }

  /** Pan the view by `deltaFrac` in audio-fraction units. */
  function panView(deltaFrac: number) {
    const { zoom, viewStart } = zoomRef.current
    const newViewStart = Math.max(0, Math.min(1 - 1 / zoom, viewStart + deltaFrac))
    zoomRef.current = { zoom, viewStart: newViewStart }
    redrawWaveform()
    setZoomVersion(v => v + 1)
  }

  // ── Seek (accounts for zoom) ──────────────────────────────────────────────

  function seek(clientX: number) {
    if (!canvasRef.current || duration <= 0) return
    const rect = canvasRef.current.getBoundingClientRect()
    const canvasFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const { viewStart, zoom } = zoomRef.current
    const audioFrac = viewStart + canvasFrac / zoom
    const t = Math.max(trimStart, Math.min(trimEnd ?? duration, audioFrac * duration))
    setCurrentTime(t)
    audioEngine.seek(t)
  }

  // ── Trim drag (converts canvas fraction → audio fraction) ──────────────

  function handleStartDrag(canvasFrac: number) {
    if (!duration) return
    const { viewStart, zoom } = zoomRef.current
    const audioFrac = viewStart + canvasFrac / zoom
    const t = Math.max(0, Math.min(trimEnd !== null ? trimEnd - 1 : duration - 1, audioFrac * duration))
    setTrimStart(t)
    audioEngine.setTrimStart(t)
  }

  function handleEndDrag(canvasFrac: number) {
    if (!duration) return
    const { viewStart, zoom } = zoomRef.current
    const audioFrac = viewStart + canvasFrac / zoom
    const t = Math.max(trimStart + 1, Math.min(duration, audioFrac * duration))
    const newVal = t >= duration ? null : t
    setTrimEnd(newVal)
    audioEngine.setTrimEnd(newVal)
  }

  // ── Noise-profile region drag ─────────────────────────────────────────────

  function handleNoiseProfileStartDrag(canvasFrac: number) {
    if (!duration) return
    const { viewStart, zoom } = zoomRef.current
    const audioFrac = viewStart + canvasFrac / zoom
    const profileEnd = humNoiseProfileEnd ?? duration
    const t = Math.max(0, Math.min(profileEnd - 0.5, audioFrac * duration))
    setHumNoiseProfileStart(t)
  }

  function handleNoiseProfileEndDrag(canvasFrac: number) {
    if (!duration) return
    const { viewStart, zoom } = zoomRef.current
    const audioFrac = viewStart + canvasFrac / zoom
    const profileStart = humNoiseProfileStart ?? 0
    const t = Math.max(profileStart + 0.5, Math.min(duration, audioFrac * duration))
    setHumNoiseProfileEnd(t)
  }

  // ── Canvas click / single-touch seek ─────────────────────────────────────

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    seek(e.clientX)
  }

  // ── Pinch-to-zoom + single-finger pan (mobile) ───────────────────────────

  const pinchRef    = useRef<{ dist: number; centerFrac: number } | null>(null)
  const swipeRef    = useRef<{ startX: number; lastX: number; moved: boolean } | null>(null)

  // non-passive touchmove — handles pinch zoom and horizontal swipe pan
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length >= 2 && pinchRef.current) {
        e.preventDefault()
        const newDist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY,
        )
        const factor = newDist / pinchRef.current.dist
        const { zoom } = zoomRef.current
        applyZoom(zoom * factor, pinchRef.current.centerFrac)
        pinchRef.current.dist = newDist
      } else if (e.touches.length === 1 && swipeRef.current && zoomRef.current.zoom > 1.01) {
        // Horizontal swipe to pan when zoomed in
        const dx = e.touches[0].clientX - swipeRef.current.lastX
        const rect = (canvas as HTMLCanvasElement).getBoundingClientRect()
        if (Math.abs(dx) > 2) {
          e.preventDefault()
          swipeRef.current.moved = true
          swipeRef.current.lastX = e.touches[0].clientX
          panView(-dx / (rect.width * zoomRef.current.zoom))
        }
      }
    }
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => canvas.removeEventListener('touchmove', onTouchMove)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleCanvasTouchStart(e: React.TouchEvent<HTMLCanvasElement>) {
    if (e.touches.length === 1) {
      pinchRef.current = null
      swipeRef.current = { startX: e.touches[0].clientX, lastX: e.touches[0].clientX, moved: false }
    } else if (e.touches.length === 2) {
      swipeRef.current = null
      const rect = canvasRef.current!.getBoundingClientRect()
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2
      pinchRef.current = {
        dist: Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY,
        ),
        centerFrac: Math.max(0, Math.min(1, (centerX - rect.left) / rect.width)),
      }
    }
  }

  function handleCanvasTouchEnd(e: React.TouchEvent<HTMLCanvasElement>) {
    if (pinchRef.current) pinchRef.current = null
    // Only seek if the finger didn't pan
    if (swipeRef.current && !swipeRef.current.moved) {
      const touch = e.changedTouches[0]
      if (touch) seek(touch.clientX)
    }
    swipeRef.current = null
  }

  // ── Scroll-wheel zoom + pan (desktop) ────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      if (duration <= 0) return
      const rect = canvas!.getBoundingClientRect()

      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Horizontal scroll → pan
        const { zoom } = zoomRef.current
        if (zoom <= 1) return
        panView(e.deltaX / (rect.width * zoom))
      } else {
        // Vertical scroll → zoom centred on cursor
        const cursorFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25
        applyZoom(zoomRef.current.zoom * factor, cursorFrac)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [duration]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Waveform rendering ────────────────────────────────────────────────────

  useEffect(() => {
    if (duration <= 0) return
    const buf = audioEngine.loadedBuffer
    if (!buf || !canvasRef.current) return
    bufferRef.current = buf
    // Reset zoom when a new file is loaded
    zoomRef.current = { zoom: 1, viewStart: 0 }
    setZoomVersion(0)
    renderWaveform(canvasRef.current, buf)
  }, [duration, file])

  useEffect(() => {
    if (!canvasRef.current || !bufferRef.current) return
    const obs = new ResizeObserver(() => redrawWaveform())
    obs.observe(canvasRef.current)
    return () => obs.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived overlay positions (canvas-space) ──────────────────────────────

  const { zoom, viewStart, viewEnd } = getView()
  const zoomedIn = zoom > 1.01

  const audioToCanvas = (audioFrac: number) =>
    zoomedIn ? (audioFrac - viewStart) * zoom : audioFrac

  const progressCanvas   = audioToCanvas(duration > 0 ? currentTime / duration : 0)
  const startFraction    = duration > 0 ? trimStart / duration : 0
  const endFraction      = duration > 0 ? (trimEnd ?? duration) / duration : 1
  const startFracCanvas  = audioToCanvas(startFraction)
  const endFracCanvas    = audioToCanvas(endFraction)
  const showStartMarker  = duration > 0 && trimStart > 0
  const showEndMarker    = duration > 0 && trimEnd !== null && trimEnd < duration

  // Trim overlays in canvas space (clamped)
  const trimStartWidth   = Math.max(0, Math.min(1, startFracCanvas))
  const trimEndLeft      = Math.max(0, Math.min(1, endFracCanvas))

  // Noise profile region in canvas space
  const showNoiseRegion  = humAutoMode && duration > 0 && humNoiseProfileStart !== null && humNoiseProfileEnd !== null
  const noiseStartFrac   = duration > 0 && humNoiseProfileStart !== null ? humNoiseProfileStart / duration : 0
  const noiseEndFrac     = duration > 0 && humNoiseProfileEnd   !== null ? humNoiseProfileEnd   / duration : 0
  const noiseStartCanvas = audioToCanvas(noiseStartFrac)
  const noiseEndCanvas   = audioToCanvas(noiseEndFrac)

  return (
    <div className="px-4 py-3">
      <div className="relative min-h-[72px]" data-waveform-container ref={containerRef}>

        <canvas
          ref={canvasRef}
          className={cn('w-full h-[72px] rounded-lg block', isAnalyzing && 'opacity-0')}
          onClick={handleCanvasClick}
          onTouchStart={handleCanvasTouchStart}
          onTouchEnd={handleCanvasTouchEnd}
          style={{ cursor: duration > 0 ? 'pointer' : 'default', touchAction: 'pan-y' }}
        />

        {!isAnalyzing && duration > 0 && (
          <>
            {/* Played-region tint */}
            <div
              className="absolute top-0 bottom-0 bg-accent/20 rounded-l-lg pointer-events-none"
              style={{ width: `${Math.max(0, Math.min(1, progressCanvas)) * 100}%` }}
            />
            {/* Playback cursor */}
            {progressCanvas >= 0 && progressCanvas <= 1 && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-accent pointer-events-none"
                style={{ left: `${progressCanvas * 100}%` }}
              />
            )}
          </>
        )}

        {/* Trimmed-region overlays */}
        {!isAnalyzing && duration > 0 && (
          <>
            {trimStart > 0 && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none z-10"
                style={{
                  left: 0,
                  width: `${trimStartWidth * 100}%`,
                  background: 'rgba(239,68,68,0.15)',
                  borderRight: '1px solid rgba(239,68,68,0.2)',
                }}
              />
            )}
            {trimEnd !== null && trimEnd < duration && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none z-10"
                style={{
                  left: `${trimEndLeft * 100}%`,
                  right: 0,
                  background: 'rgba(239,68,68,0.15)',
                  borderLeft: '1px solid rgba(239,68,68,0.2)',
                }}
              />
            )}
          </>
        )}

        {/* Trim markers */}
        {!isAnalyzing && (
          <>
            {showStartMarker && (
              <TrimMarker position={startFracCanvas} onDrag={handleStartDrag} side="start" />
            )}
            {showEndMarker && (
              <TrimMarker position={endFracCanvas} onDrag={handleEndDrag} side="end" />
            )}
          </>
        )}

        {/* Noise-profile region overlay (green) */}
        {!isAnalyzing && showNoiseRegion && (
          <>
            <div
              className="absolute top-0 bottom-0 pointer-events-none z-10"
              style={{
                left:  `${Math.max(0, Math.min(1, noiseStartCanvas)) * 100}%`,
                width: `${Math.max(0, Math.min(1, noiseEndCanvas) - Math.max(0, Math.min(1, noiseStartCanvas))) * 100}%`,
                background: 'rgba(34,197,94,0.15)',
                borderLeft:  '1px solid rgba(34,197,94,0.5)',
                borderRight: '1px solid rgba(34,197,94,0.5)',
              }}
            />
            <TrimMarker position={noiseStartCanvas} onDrag={handleNoiseProfileStartDrag} side="start" color="green" />
            <TrimMarker position={noiseEndCanvas}   onDrag={handleNoiseProfileEndDrag}   side="end"   color="green" />
            {/* Label */}
            {noiseEndCanvas > noiseStartCanvas + 0.05 && (
              <div
                className="absolute z-20 pointer-events-none"
                style={{
                  left: `${(Math.max(0, noiseStartCanvas) + Math.max(0, Math.min(1, noiseEndCanvas))) / 2 * 100}%`,
                  top: '4px',
                  transform: 'translateX(-50%)',
                }}
              >
                <span className="text-[9px] font-semibold text-green-400 bg-black/50 px-1 py-0.5 rounded whitespace-nowrap">
                  Rauschprofil
                </span>
              </div>
            )}
          </>
        )}

        {/* Zoom minimap — thin bar at bottom showing current view window */}
        {!isAnalyzing && zoomedIn && (
          <div className="absolute bottom-0 left-0 right-0 h-1 rounded-b-lg bg-card-border/60 pointer-events-none z-30">
            <div
              className="absolute top-0 bottom-0 bg-accent/70 rounded-full"
              style={{
                left:  `${viewStart * 100}%`,
                width: `${(viewEnd - viewStart) * 100}%`,
              }}
            />
          </div>
        )}

        {/* Zoom level badge */}
        {!isAnalyzing && zoomedIn && (
          <div className="absolute top-1 right-1.5 z-30 pointer-events-none">
            <span className="text-[9px] font-semibold text-accent/80 bg-black/40 px-1 py-0.5 rounded tabular-nums">
              {zoom.toFixed(1)}×
            </span>
          </div>
        )}

        {/* Loading overlay */}
        {isAnalyzing && (
          <div className="absolute inset-0 flex flex-col justify-center gap-2 rounded-lg bg-background/95 px-4">
            <p className="text-xs text-center text-text-secondary">
              {isLoading ? 'Track wird geladen …' : 'Wird analysiert und eingestellt …'}
            </p>
            <div className="w-full h-1.5 rounded-full bg-card-border overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full bg-accent transition-all duration-500',
                  isLoading && 'animate-pulse',
                )}
                style={{ width: `${loadingProgress}%` }}
              />
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
