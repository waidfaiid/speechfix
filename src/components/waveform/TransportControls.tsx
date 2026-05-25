import { Play, Pause, SkipBack, SkipForward, Scissors } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { useAudioStore } from '@/store/useAudioStore'
import { audioEngine } from '@/audio/AudioEngine'
import { formatTime, lerp } from '@/utils/audioMath'
import { cn } from '@/utils/cn'

interface TransportControlsProps {
  collapseProgress?: number
}

export function TransportControls({ collapseProgress = 0 }: TransportControlsProps) {
  const {
    isPlaying, currentTime, duration,
    trimStart, trimEnd, setTrimStart, setTrimEnd,
  } = useAudioStore()

  function togglePlay() {
    if (isPlaying) {
      audioEngine.pause()
      useAudioStore.getState().setIsPlaying(false)
    } else {
      audioEngine.play()
      useAudioStore.getState().setIsPlaying(true)
    }
  }

  // Prefer the engine's buffer duration over the store value — the store value
  // can be 0 briefly before WaveSurfer fires its 'ready' event, which would
  // clamp all seeks to 0.
  function effectiveDuration() {
    return duration > 0 ? duration : (audioEngine.loadedBuffer?.duration ?? 0)
  }

  function skip(delta: number) {
    const lo = trimStart
    const hi = trimEnd ?? effectiveDuration()
    const next = Math.max(lo, Math.min(hi, currentTime + delta))
    audioEngine.seek(next)
  }

  function skipToStart() {
    audioEngine.seek(trimStart)
  }

  function skipToEnd() {
    // Land 1 s before the effective end so -30 / -10 can be used right away
    const end = trimEnd ?? effectiveDuration()
    audioEngine.seek(Math.max(trimStart, end - 1))
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  function handleTrimStartChange(v: number) {
    const clamped = Math.max(0, Math.min(trimEnd !== null ? trimEnd - 1 : duration - 1, v))
    setTrimStart(clamped)
    audioEngine.setTrimStart(clamped)
    if (currentTime < clamped) audioEngine.seek(clamped)
  }

  const trimEndCut = duration > 0 ? duration - (trimEnd ?? duration) : 0
  function handleTrimEndChange(v: number) {
    const newTrimEnd = duration - v
    const clamped = Math.max(trimStart + 1, Math.min(duration, newTrimEnd))
    const newVal = v <= 0 ? null : clamped
    setTrimEnd(newVal)
    audioEngine.setTrimEnd(newVal)
    if (newVal !== null && currentTime > newVal) audioEngine.seek(newVal)
  }

  function setTrimHereStart() {
    handleTrimStartChange(Math.max(0, currentTime))
  }

  function setTrimHereEnd() {
    handleTrimEndChange(duration - Math.min(duration, currentTime))
  }


  /** Fine-tune trimStart by delta seconds (negative = earlier, positive = later). */
  function adjustTrimStart(delta: number) {
    handleTrimStartChange(trimStart + delta)
  }

  /** Fine-tune trimEnd by delta seconds (negative = earlier / cut more, positive = later / cut less). */
  function adjustTrimEnd(delta: number) {
    const currentEnd = trimEnd ?? duration
    handleTrimEndChange(duration - Math.max(0, currentEnd + delta))
  }

  /** Vertical drag on time displays: drag up = increase, drag down = decrease.
   *  Movement is proportional to total track duration. */
  const dragStartY = useRef<number | null>(null)
  const dragLastTime = useRef(0)

  const DRAG_FULL_PX = 1000

  const makeTimeDragHandlers = useCallback((setAbsolute: (time: number) => void, getBase: () => number, direction = 1) => {
    function onMove(clientY: number) {
      if (dragStartY.current === null) return
      const dy = dragStartY.current - clientY
      const fraction = dy / DRAG_FULL_PX * direction
      const dur = useAudioStore.getState().duration
      const newTime = dragLastTime.current + fraction * dur
      setAbsolute(newTime)
    }

    function onMouseDown(e: React.MouseEvent) {
      e.preventDefault()
      dragStartY.current = e.clientY
      dragLastTime.current = getBase()

      function handleMouseMove(ev: MouseEvent) { onMove(ev.clientY) }
      function handleMouseUp() {
        dragStartY.current = null
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }

    function onTouchStart(e: React.TouchEvent) {
      e.preventDefault()
      dragStartY.current = e.touches[0].clientY
      dragLastTime.current = getBase()

      function handleTouchMove(ev: TouchEvent) {
        if (ev.touches.length > 0) onMove(ev.touches[0].clientY)
      }
      function handleTouchEnd() {
        dragStartY.current = null
        window.removeEventListener('touchmove', handleTouchMove)
        window.removeEventListener('touchend', handleTouchEnd)
      }
      window.addEventListener('touchmove', handleTouchMove, { passive: false })
      window.addEventListener('touchend', handleTouchEnd)
    }

    return { onMouseDown, onTouchStart }
  }, [])

  const trimStartDragHandlers = makeTimeDragHandlers(
    (t) => handleTrimStartChange(t),
    () => useAudioStore.getState().trimStart,
    -1,
  )
  const trimEndDragHandlers = makeTimeDragHandlers(
    (t) => {
      const dur = useAudioStore.getState().duration
      const clamped = Math.max(trimStart + 1, Math.min(dur, t))
      const newVal = clamped >= dur ? null : clamped
      setTrimEnd(newVal)
      audioEngine.setTrimEnd(newVal)
    },
    () => useAudioStore.getState().trimEnd ?? useAudioStore.getState().duration,
  )

  const cp = collapseProgress
  const btnH = Math.round(lerp(44, 28, cp))
  const playH = Math.round(lerp(48, 32, cp))
  const skipW = Math.round(lerp(36, 26, cp))
  const fontSize = lerp(13, 10, cp)
  const playIcon = Math.round(lerp(22, 14, cp))
  const skipIcon = Math.round(lerp(16, 12, cp))
  const gapPx = Math.round(lerp(4, 2, cp))
  const transportMb = Math.round(lerp(16, 4, cp))
  const containerPt = Math.round(lerp(0, 8, cp))
  const containerPb = Math.round(lerp(12, 4, cp))
  const borderR = Math.round(lerp(12, 8, cp))

  const timeOpacity = Math.max(0, 1 - cp * 3)
  const timeMaxH = Math.round(lerp(28, 0, Math.min(1, cp * 2)))
  const trimOpacity = Math.max(0, 1 - cp * 2)
  const trimMaxH = Math.round(lerp(48, 0, Math.min(1, cp * 2)))

  const navBtnCls = 'flex-1 min-w-0 rounded-xl font-tech font-medium transition text-text-secondary hover:text-text-primary hover:bg-card active:bg-card-elevated'
  const edgeBtnCls = 'shrink-0 rounded-xl flex justify-center items-center transition text-text-secondary hover:text-text-primary hover:bg-card active:bg-card-elevated'

  return (
    <div style={{ padding: `${containerPt}px 12px ${containerPb}px` }}>
      {/* Time display — fades out first */}
      <div style={{ maxHeight: `${timeMaxH}px`, opacity: timeOpacity, overflow: 'hidden' }}>
        <div className="flex justify-between font-tech text-xs text-text-secondary mb-2 px-1">
          <span className="text-accent">{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Transport buttons */}
      <div
        className="flex items-center"
        style={{ gap: `${gapPx}px`, marginBottom: `${transportMb}px` }}
      >
        <button
          onClick={skipToStart}
          className={edgeBtnCls}
          style={{ height: `${btnH}px`, width: `${skipW}px`, borderRadius: `${borderR}px` }}
          aria-label="Zum Anfang"
        >
          <SkipBack size={skipIcon} />
        </button>

        <button
          onClick={() => skip(-30)}
          className={navBtnCls}
          style={{ height: `${btnH}px`, fontSize: `${fontSize}px`, borderRadius: `${borderR}px` }}
          aria-label="-30 s"
        >−30</button>

        <button
          onClick={() => skip(-10)}
          className={navBtnCls}
          style={{ height: `${btnH}px`, fontSize: `${fontSize}px`, borderRadius: `${borderR}px` }}
          aria-label="-10 s"
        >−10</button>

        <button
          onClick={togglePlay}
          className="bg-accent text-background flex-[1.3] min-w-0 shrink-0 flex justify-center items-center shadow-[0_4px_12px_rgba(245,158,11,0.3)] hover:scale-105 transition active:scale-95"
          style={{ height: `${playH}px`, borderRadius: `${borderR}px` }}
          aria-label={isPlaying ? 'Pause' : 'Abspielen'}
        >
          {isPlaying
            ? <Pause size={playIcon} className="fill-current" />
            : <Play size={playIcon} className="ml-0.5 fill-current" />
          }
        </button>

        <button
          onClick={() => skip(10)}
          className={navBtnCls}
          style={{ height: `${btnH}px`, fontSize: `${fontSize}px`, borderRadius: `${borderR}px` }}
          aria-label="+10 s"
        >+10</button>

        <button
          onClick={() => skip(30)}
          className={navBtnCls}
          style={{ height: `${btnH}px`, fontSize: `${fontSize}px`, borderRadius: `${borderR}px` }}
          aria-label="+30 s"
        >+30</button>

        <button
          onClick={skipToEnd}
          className={edgeBtnCls}
          style={{ height: `${btnH}px`, width: `${skipW}px`, borderRadius: `${borderR}px` }}
          aria-label="Zum Ende"
        >
          <SkipForward size={skipIcon} />
        </button>
      </div>

      {/* Trim section — fades out */}
      <div style={{ maxHeight: `${trimMaxH}px`, opacity: trimOpacity, overflow: 'hidden' }}>
        <div className="bg-background rounded-lg p-1 flex justify-between items-center gap-0.5 border border-card-border overflow-hidden">
          <button
            className="px-1.5 py-2 rounded-md font-tech text-[10px] text-text-secondary hover:text-white transition whitespace-nowrap shrink-0 cursor-ns-resize select-none touch-none"
            onMouseDown={trimStartDragHandlers.onMouseDown}
            onTouchStart={trimStartDragHandlers.onTouchStart}
          >{trimStart > 0 ? formatTime(trimStart) : '0:00'}</button>
          <button onClick={() => adjustTrimStart(-3)} className="flex-1 min-w-0 py-2 rounded-md font-tech text-[10px] text-text-secondary hover:text-white transition bg-card hover:bg-card-elevated">−3</button>
          <button
            onClick={setTrimHereStart}
            className={cn("flex-1 min-w-0 py-2 rounded-md flex justify-center transition", trimStart > 0 ? "text-accent bg-accent/20" : "text-text-secondary bg-accent/10 hover:text-accent")}
            title="Anfang hier kürzen"
          >
            <Scissors size={11} />
          </button>
          <button onClick={() => adjustTrimStart(3)} className="flex-1 min-w-0 py-2 rounded-md font-tech text-[10px] text-text-secondary hover:text-white transition bg-card hover:bg-card-elevated">+3</button>

          <div className="w-[1px] h-4 bg-card-border mx-0.5 shrink-0"></div>

          <button onClick={() => adjustTrimEnd(-3)} className="flex-1 min-w-0 py-2 rounded-md font-tech text-[10px] text-text-secondary hover:text-white transition bg-card hover:bg-card-elevated">−3</button>
          <button
            onClick={setTrimHereEnd}
            className={cn("flex-1 min-w-0 py-2 rounded-md flex justify-center transition", trimEndCut > 0 ? "text-accent bg-accent/20" : "text-text-secondary bg-accent/10 hover:text-accent")}
            title="Ende hier kürzen"
          >
            <Scissors size={11} />
          </button>
          <button onClick={() => adjustTrimEnd(3)} className="flex-1 min-w-0 py-2 rounded-md font-tech text-[10px] text-text-secondary hover:text-white transition bg-card hover:bg-card-elevated">+3</button>
          <button
            className="px-1.5 py-2 rounded-md font-tech text-[10px] text-text-secondary hover:text-white transition whitespace-nowrap shrink-0 cursor-ns-resize select-none touch-none"
            onMouseDown={trimEndDragHandlers.onMouseDown}
            onTouchStart={trimEndDragHandlers.onTouchStart}
          >{trimEnd !== null ? formatTime(trimEnd) : '0:00'}</button>
        </div>
      </div>
    </div>
  )
}
