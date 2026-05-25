import { useEffect, useRef, useCallback, useState } from 'react'
import { useAudioStore } from '@/store/useAudioStore'
import { useProcessingStore } from '@/store/useProcessingStore'
import { audioEngine } from '@/audio/AudioEngine'
import { lerp } from '@/utils/audioMath'
import { cn } from '@/utils/cn'
import type { WaveformPeakData } from '@/audio/WaveformPeaks'

interface WaveformDisplayProps {
  file: File
  collapseProgress?: number
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

/**
 * Render waveform from pre-computed peak data.
 * Peaks are interleaved min/max pairs at a fixed rate (peaksPerSec).
 */
function renderWaveformFromPeaks(
  canvas: HTMLCanvasElement,
  peakData: WaveformPeakData,
  viewStart = 0,
  viewEnd = 1,
  chunkStartFrac?: number,
  chunkEndFrac?: number,
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

  ctx.fillStyle = '#0f0e0d'
  ctx.fillRect(0, 0, w, h)

  const { peaks, peakCount } = peakData
  const startPeak = Math.floor(viewStart * peakCount)
  const endPeak = Math.ceil(viewEnd * peakCount)
  const visibleCount = Math.max(1, endPeak - startPeak)
  const peaksPerPx = visibleCount / w
  const mid = h / 2

  let globalPeak = 0.001
  const stride = Math.max(1, Math.floor(visibleCount / Math.max(w * 8, 1024)))
  for (let i = startPeak; i < endPeak; i += stride) {
    const mn = Math.abs(peaks[i * 2])
    const mx = Math.abs(peaks[i * 2 + 1])
    if (mn > globalPeak) globalPeak = mn
    if (mx > globalPeak) globalPeak = mx
  }

  for (let x = 0; x < w; x++) {
    const s = startPeak + Math.floor(x * peaksPerPx)
    const e = Math.min(endPeak - 1, startPeak + Math.ceil((x + 1) * peaksPerPx))
    let mn = 0, mx = 0
    for (let i = s; i <= e; i++) {
      if (i < 0 || i >= peakCount) continue
      const lo = peaks[i * 2]
      const hi = peaks[i * 2 + 1]
      if (lo < mn) mn = lo
      if (hi > mx) mx = hi
    }
    const normMx = mx / globalPeak
    const normMn = mn / globalPeak
    const barY = mid - normMx * mid
    const barH = Math.max(1, (normMx - normMn) * mid)

    const audioFrac = viewStart + (x / w) * (viewEnd - viewStart)
    const inChunk = chunkStartFrac === undefined || chunkEndFrac === undefined ||
      (audioFrac >= chunkStartFrac && audioFrac < chunkEndFrac)
    ctx.fillStyle = inChunk ? '#f59e0b' : '#b47a0a'
    ctx.fillRect(x, barY, 1, barH)
  }
}

export function WaveformDisplay({ file, collapseProgress = 0 }: WaveformDisplayProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Zoom state stored in a ref so event handlers always see current values,
  // plus a version counter to trigger React re-renders.
  const zoomRef = useRef({ zoom: 1, viewStart: 0 })
  const [zoomVersion, setZoomVersion] = useState(0)

  const setCurrentTime = useAudioStore((s) => s.setCurrentTime)
  const isLoading      = useAudioStore((s) => s.isLoading)
  const isChunkLoading = useAudioStore((s) => s.isChunkLoading)
  const analysisStatus = useProcessingStore((s) => s.analysisStatus)
  const analysisProgress = useProcessingStore((s) => s.analysisProgress)
  const currentTime    = useAudioStore((s) => s.currentTime)
  const duration       = useAudioStore((s) => s.duration)
  const trimStart      = useAudioStore((s) => s.trimStart)
  const trimEnd        = useAudioStore((s) => s.trimEnd)
  const setTrimStart   = useAudioStore((s) => s.setTrimStart)
  const setTrimEnd     = useAudioStore((s) => s.setTrimEnd)

  const peaksRef = useRef<WaveformPeakData | null>(null)

  // Noise profile region (hum auto mode)
  const humAutoMode           = useProcessingStore((s) => s.humAutoMode)
  const humNoiseProfileStart  = useProcessingStore((s) => s.humNoiseProfileStart)
  const humNoiseProfileEnd    = useProcessingStore((s) => s.humNoiseProfileEnd)
  const setHumNoiseProfileStart = useProcessingStore((s) => s.setHumNoiseProfileStart)
  const setHumNoiseProfileEnd   = useProcessingStore((s) => s.setHumNoiseProfileEnd)

  const isAnalyzing = isLoading || analysisStatus === 'running'

  // Smooth fake progress: ramps up quickly at first, then slows down (never reaches 50%).
  // Resets when loading starts, then blends into the real analysis progress.
  const [fakeProgress, setFakeProgress] = useState(0)
  useEffect(() => {
    if (!isLoading) { setFakeProgress(0); return }
    setFakeProgress(5)
    let raf: number
    const start = performance.now()
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000
      // Asymptotic curve: approaches 45% but never reaches it
      setFakeProgress(Math.round(45 * (1 - Math.exp(-elapsed / 3))))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isLoading])

  const loadingProgress = isLoading
    ? fakeProgress
    : analysisStatus === 'running'
    ? Math.round(50 + analysisProgress * 50)
    : 100

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getView() {
    const { zoom, viewStart } = zoomRef.current
    const viewEnd = Math.min(1, viewStart + 1 / zoom)
    return { zoom, viewStart, viewEnd }
  }

  function redrawWaveform() {
    if (!canvasRef.current || !peaksRef.current) return
    const { viewStart, viewEnd } = getView()
    if (audioEngine.isChunkedMode) {
      const dur = peaksRef.current.duration
      const chunkStart = dur > 0 ? audioEngine.chunkStartSec / dur : 0
      const chunkEnd = dur > 0 ? audioEngine.chunkEndSec / dur : 0
      renderWaveformFromPeaks(canvasRef.current, peaksRef.current, viewStart, viewEnd, chunkStart, chunkEnd)
    } else {
      renderWaveformFromPeaks(canvasRef.current, peaksRef.current, viewStart, viewEnd)
    }
  }

  /** Apply a new zoom level, always centering the view on the playhead. */
  function applyZoom(newZoom: number) {
    newZoom = Math.max(1, Math.min(100, newZoom))
    const { currentTime: ct, duration: dur } = useAudioStore.getState()
    const playheadFrac = dur > 0 ? ct / dur : 0.5
    const newViewStart = Math.max(0, Math.min(1 - 1 / newZoom, playheadFrac - 0.5 / newZoom))
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

  const pinchRef    = useRef<{ dist: number } | null>(null)
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
        applyZoom(zoom * factor)
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
      pinchRef.current = {
        dist: Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY,
        ),
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
        // Vertical scroll → zoom centred on playhead
        const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25
        applyZoom(zoomRef.current.zoom * factor)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [duration]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Waveform rendering ────────────────────────────────────────────────────

  useEffect(() => {
    if (duration <= 0) return
    if (!canvasRef.current) return

    zoomRef.current = { zoom: 1, viewStart: 0 }
    setZoomVersion(0)

    const peaks = audioEngine.waveformPeaks
    if (!peaks) return
    peaksRef.current = peaks

    if (audioEngine.isChunkedMode) {
      const dur = peaks.duration
      const chunkStart = dur > 0 ? audioEngine.chunkStartSec / dur : 0
      const chunkEnd = dur > 0 ? audioEngine.chunkEndSec / dur : 0
      renderWaveformFromPeaks(canvasRef.current, peaks, 0, 1, chunkStart, chunkEnd)
    } else {
      renderWaveformFromPeaks(canvasRef.current, peaks)
    }
  }, [duration, file])

  useEffect(() => {
    if (!canvasRef.current) return
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

  const cp = collapseProgress
  const waveH = Math.round(lerp(96, 12, cp))
  const showDetails = cp < 0.7
  const padX = Math.round(lerp(12, 4, cp))
  const padB = Math.round(lerp(8, 2, cp))
  const borderR = Math.round(lerp(8, 3, cp))

  return (
    <div style={{ padding: `0 ${padX}px ${padB}px` }}>
      <div
        className="relative overflow-hidden bg-background"
        style={{
          minHeight: `${waveH}px`,
          borderRadius: `${borderR}px`,
          border: cp < 0.9 ? '1px solid #464240' : '1px solid rgba(70,66,64,0.3)',
        }}
        data-waveform-container
        ref={containerRef}
      >
        <canvas
          ref={canvasRef}
          className={cn('w-full block', isAnalyzing && 'opacity-0')}
          onClick={handleCanvasClick}
          onTouchStart={handleCanvasTouchStart}
          onTouchEnd={handleCanvasTouchEnd}
          style={{
            height: `${waveH}px`,
            cursor: duration > 0 ? 'pointer' : 'default',
            touchAction: 'pan-y',
          }}
        />

        {/* Progress tint + playback cursor — always visible */}
        {!isAnalyzing && duration > 0 && (
          <>
            <div
              className="absolute top-0 bottom-0 bg-accent-glow pointer-events-none"
              style={{ width: `${Math.max(0, Math.min(1, progressCanvas)) * 100}%` }}
            />
            {progressCanvas >= 0 && progressCanvas <= 1 && (
              <div
                className="absolute top-0 bottom-0 w-[1px] bg-accent shadow-[0_0_8px_rgba(245,158,11,1)] z-10 pointer-events-none"
                style={{ left: `${progressCanvas * 100}%` }}
              />
            )}
          </>
        )}

        {/* Trimmed-region overlays — hidden when collapsed */}
        {!isAnalyzing && duration > 0 && showDetails && (
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

        {/* Trim markers — hidden when collapsed */}
        {!isAnalyzing && showDetails && (
          <>
            {showStartMarker && (
              <TrimMarker position={startFracCanvas} onDrag={handleStartDrag} side="start" />
            )}
            {showEndMarker && (
              <TrimMarker position={endFracCanvas} onDrag={handleEndDrag} side="end" />
            )}
          </>
        )}

        {/* Noise-profile region — hidden when collapsed */}
        {!isAnalyzing && showNoiseRegion && showDetails && (
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

        {/* Zoom minimap */}
        {!isAnalyzing && zoomedIn && showDetails && (
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
        {!isAnalyzing && zoomedIn && showDetails && (
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
              {isLoading ? 'Track wird geladen …' : 'Wird eingestellt …'}
            </p>
            <div className="w-full h-1.5 rounded-full bg-card-border overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${loadingProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Chunk loading overlay (shown when seeking in chunked mode) */}
        {!isAnalyzing && isChunkLoading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 z-30 pointer-events-none">
            <div className="flex items-center gap-2 bg-card/90 px-3 py-1.5 rounded-full shadow-lg">
              <svg className="animate-spin h-3.5 w-3.5 text-accent" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-[10px] font-medium text-text-secondary whitespace-nowrap">
                Audio wird geladen …
              </span>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
