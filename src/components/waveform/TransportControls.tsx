import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'
import { useAudioStore } from '@/store/useAudioStore'
import { audioEngine } from '@/audio/AudioEngine'
import { formatTime } from '@/utils/audioMath'
import { cn } from '@/utils/cn'

export function TransportControls() {
  const { isPlaying, currentTime, duration, abMode, setAbMode } = useAudioStore()

  function togglePlay() {
    if (isPlaying) {
      audioEngine.pause()
      useAudioStore.getState().setIsPlaying(false)
    } else {
      audioEngine.play()
      useAudioStore.getState().setIsPlaying(true)
    }
  }

  function skip(delta: number) {
    const next = Math.max(0, Math.min(duration, currentTime + delta))
    audioEngine.seek(next)
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

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

      {/* Controls row: A/B compare left, then transport */}
      <div className="flex items-center gap-2 pl-1">
        {/* A/B Compare */}
        <div className="flex gap-1.5">
          {(['original', 'processed'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => { setAbMode(mode); audioEngine.setABMode(mode) }}
              className={cn(
                'px-2.5 py-1.5 rounded-pill text-xs font-medium transition-colors',
                abMode === mode
                  ? 'bg-accent text-white'
                  : 'bg-slider-track text-text-secondary hover:text-text-primary',
              )}
            >
              {mode === 'original' ? 'Original' : 'Bearbeitet'}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-card-border mx-1 shrink-0" />

        {/* Skip back */}
        <button
          onClick={() => skip(-10)}
          className="flex items-center justify-center w-10 h-10 rounded-full text-text-secondary hover:text-text-primary hover:bg-card transition-colors"
          aria-label="-10 Sekunden"
        >
          <SkipBack size={18} />
        </button>

        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          className={cn(
            'flex items-center justify-center w-12 h-12 rounded-full transition-all active:scale-95',
            'bg-accent hover:bg-accent-hover text-white',
          )}
          aria-label={isPlaying ? 'Pause' : 'Abspielen'}
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} className="translate-x-0.5" />}
        </button>

        {/* Skip forward */}
        <button
          onClick={() => skip(10)}
          className="flex items-center justify-center w-10 h-10 rounded-full text-text-secondary hover:text-text-primary hover:bg-card transition-colors"
          aria-label="+10 Sekunden"
        >
          <SkipForward size={18} />
        </button>
      </div>
    </div>
  )
}
