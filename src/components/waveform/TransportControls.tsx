import { Play, Pause, SkipBack, SkipForward, Scissors } from 'lucide-react'
import { useAudioStore } from '@/store/useAudioStore'
import { audioEngine } from '@/audio/AudioEngine'
import { formatTime } from '@/utils/audioMath'
import { cn } from '@/utils/cn'
import { RotaryKnob } from '@/components/ui/RotaryKnob'

export function TransportControls() {
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

  const maxTrim = duration > 0 ? duration / 2 : 3600

  // Desktop button classes
  const navBtnCls = 'flex items-center justify-center w-8 h-8 rounded-full text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:bg-card transition-colors tabular-nums'
  const edgeBtnCls = 'flex items-center justify-center w-7 h-7 rounded-full text-text-secondary hover:text-text-primary hover:bg-card transition-colors'

  // Mobile: ±3 s adjustment button
  const mobileAdjCls = 'flex items-center justify-center h-10 flex-1 rounded-xl text-[11px] font-semibold bg-slider-track text-text-secondary active:text-text-primary transition-colors tabular-nums'
  // Mobile: −30/−10/+10/+30 skip button
  const mobileNavCls = 'flex items-center justify-center h-11 flex-1 rounded-xl text-[11px] font-semibold text-text-secondary active:text-text-primary bg-slider-track transition-colors tabular-nums'
  // Mobile: skip-to-start / skip-to-end
  const mobileEdgeCls = 'flex items-center justify-center h-11 w-11 rounded-xl text-text-secondary active:text-text-primary bg-slider-track transition-colors shrink-0'

  return (
    <div className="px-4 pb-3 space-y-2">
      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary w-10 tabular-nums">{formatTime(currentTime)}</span>
        <div className="flex-1 h-1 bg-slider-track rounded-pill overflow-hidden">
          <div
            className="h-full bg-accent rounded-pill transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-xs text-text-secondary w-10 tabular-nums text-right">{formatTime(duration)}</span>
      </div>

      {/* ═══════════════════════════════════════════════
          MOBILE LAYOUT  (hidden on sm+)
          Row 1: transport  |  Row 2: trim controls
          ═══════════════════════════════════════════════ */}
      <div className="flex flex-col gap-2 sm:hidden">

        {/* — Row 1: Transport — */}
        <div className="flex items-center gap-1.5">
          <button onClick={skipToStart} className={mobileEdgeCls} aria-label="Zum Anfang">
            <SkipBack size={16} />
          </button>
          <button onClick={() => skip(-30)} className={mobileNavCls} aria-label="-30 s">−30</button>
          <button onClick={() => skip(-10)} className={mobileNavCls} aria-label="-10 s">−10</button>

          {/* Play / Pause — slightly larger in the centre */}
          <button
            onClick={togglePlay}
            className="flex items-center justify-center w-14 h-14 rounded-full bg-accent active:bg-accent-hover text-white active:scale-95 transition-all shrink-0 mx-0.5"
            aria-label={isPlaying ? 'Pause' : 'Abspielen'}
          >
            {isPlaying ? <Pause size={22} /> : <Play size={22} className="translate-x-0.5" />}
          </button>

          <button onClick={() => skip(10)} className={mobileNavCls} aria-label="+10 s">+10</button>
          <button onClick={() => skip(30)} className={mobileNavCls} aria-label="+30 s">+30</button>
          <button onClick={skipToEnd} className={mobileEdgeCls} aria-label="Zum Ende">
            <SkipForward size={16} />
          </button>
        </div>

        {/* — Row 2: Trim controls — flat single row each side — */}
        <div className="flex items-center gap-2">

          {/* Anfang (left): [Knob] [−3] [✂] [+3] */}
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <RotaryKnob
              value={trimStart}
              max={maxTrim}
              onChange={handleTrimStartChange}
              label="Anfang kürzen"
              large
            />
            <button onClick={() => adjustTrimStart(-3)} className={mobileAdjCls} aria-label="−3 s Anfang">−3</button>
            <button
              onClick={setTrimHereStart}
              className={cn(
                'flex items-center justify-center w-10 h-10 rounded-xl transition-colors shrink-0',
                trimStart > 0
                  ? 'bg-red-500/20 text-red-400 active:bg-red-500/30'
                  : 'bg-slider-track text-text-secondary active:text-text-primary',
              )}
              title="Anfang hier kürzen"
            >
              <Scissors size={14} />
            </button>
            <button onClick={() => adjustTrimStart(3)}  className={mobileAdjCls} aria-label="+3 s Anfang">+3</button>
          </div>

          {/* Divider */}
          <div className="w-px self-stretch bg-card-border shrink-0" />

          {/* Ende (right): [−3] [✂] [+3] [Knob] */}
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <button onClick={() => adjustTrimEnd(-3)} className={mobileAdjCls} aria-label="−3 s Ende">−3</button>
            <button
              onClick={setTrimHereEnd}
              className={cn(
                'flex items-center justify-center w-10 h-10 rounded-xl transition-colors shrink-0',
                trimEndCut > 0
                  ? 'bg-red-500/20 text-red-400 active:bg-red-500/30'
                  : 'bg-slider-track text-text-secondary active:text-text-primary',
              )}
              title="Ende hier kürzen"
            >
              <Scissors size={14} />
            </button>
            <button onClick={() => adjustTrimEnd(3)}  className={mobileAdjCls} aria-label="+3 s Ende">+3</button>
            <RotaryKnob
              value={trimEndCut}
              max={maxTrim}
              onChange={handleTrimEndChange}
              label="Ende kürzen"
              isEnd
              large
            />
          </div>

        </div>
      </div>

      {/* ═══════════════════════════════════════════════
          DESKTOP LAYOUT  (hidden below sm)
          3-column grid: [trim-start | transport] [play] [transport | trim-end]
          ═══════════════════════════════════════════════ */}
      <div className="hidden sm:grid grid-cols-[1fr_auto_1fr] items-center">

        {/* ── Left column: Trim-Start → left transport ── */}
        <div className="flex items-center gap-1 min-w-0">
          <div className="flex items-center gap-1 shrink-0">
            <RotaryKnob value={trimStart} max={maxTrim} onChange={handleTrimStartChange} label="Anfang kürzen" />
            <div className="flex flex-col items-stretch gap-0.5">
              <button
                onClick={setTrimHereStart}
                className={cn(
                  'flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-pill text-[10px] font-medium transition-colors whitespace-nowrap',
                  trimStart > 0
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-slider-track text-text-secondary hover:text-text-primary',
                )}
                title="Anfang hier kürzen"
              >
                <Scissors size={10} />
                <span>Hier kürzen</span>
              </button>
              <div className="flex gap-0.5">
                <button onClick={() => adjustTrimStart(-3)} className="flex-1 flex items-center justify-center py-1 rounded-pill text-[9px] font-semibold bg-slider-track text-text-secondary hover:text-text-primary transition-colors" title="−3 s" aria-label="-3 Sekunden Anfang">−3</button>
                <button onClick={() => adjustTrimStart(3)}  className="flex-1 flex items-center justify-center py-1 rounded-pill text-[9px] font-semibold bg-slider-track text-text-secondary hover:text-text-primary transition-colors" title="+3 s" aria-label="+3 Sekunden Anfang">+3</button>
              </div>
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={skipToStart} className={edgeBtnCls} aria-label="Zum Anfang springen"><SkipBack size={15} /></button>
            <button onClick={() => skip(-30)} className={navBtnCls} aria-label="-30 Sekunden">−30</button>
            <button onClick={() => skip(-10)} className={navBtnCls} aria-label="-10 Sekunden">−10</button>
          </div>
        </div>

        {/* ── Centre: Play / Pause ── */}
        <button
          onClick={togglePlay}
          className="flex items-center justify-center w-12 h-12 rounded-full bg-accent hover:bg-accent-hover text-white transition-all active:scale-95 mx-1"
          aria-label={isPlaying ? 'Pause' : 'Abspielen'}
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} className="translate-x-0.5" />}
        </button>

        {/* ── Right column: right transport → Trim-End ── */}
        <div className="flex items-center gap-1 min-w-0">
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => skip(10)}  className={navBtnCls} aria-label="+10 Sekunden">+10</button>
            <button onClick={() => skip(30)}  className={navBtnCls} aria-label="+30 Sekunden">+30</button>
            <button onClick={skipToEnd} className={edgeBtnCls} aria-label="Zum Ende springen"><SkipForward size={15} /></button>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1 shrink-0">
            <div className="flex flex-col items-stretch gap-0.5">
              <button
                onClick={setTrimHereEnd}
                className={cn(
                  'flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-pill text-[10px] font-medium transition-colors whitespace-nowrap',
                  trimEndCut > 0
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-slider-track text-text-secondary hover:text-text-primary',
                )}
                title="Ende hier kürzen"
              >
                <Scissors size={10} />
                <span>Hier kürzen</span>
              </button>
              <div className="flex gap-0.5">
                <button onClick={() => adjustTrimEnd(-3)} className="flex-1 flex items-center justify-center py-1 rounded-pill text-[9px] font-semibold bg-slider-track text-text-secondary hover:text-text-primary transition-colors" title="−3 s" aria-label="-3 Sekunden Ende">−3</button>
                <button onClick={() => adjustTrimEnd(3)}  className="flex-1 flex items-center justify-center py-1 rounded-pill text-[9px] font-semibold bg-slider-track text-text-secondary hover:text-text-primary transition-colors" title="+3 s" aria-label="+3 Sekunden Ende">+3</button>
              </div>
            </div>
            <RotaryKnob value={trimEndCut} max={maxTrim} onChange={handleTrimEndChange} label="Ende kürzen" isEnd />
          </div>
        </div>

      </div>
    </div>
  )
}
