import { useRef, useState, useEffect } from 'react'
import { Play, Pause, SkipBack, SkipForward, Plus } from 'lucide-react'
import { Layout } from '@/components/layout/Layout'
import { DropZone } from '@/components/import/DropZone'
import { FileList } from '@/components/import/FileList'
import { WaveformDisplay } from '@/components/waveform/WaveformDisplay'
import { TransportControls } from '@/components/waveform/TransportControls'
import { ProcessingPanel } from '@/components/processing/ProcessingPanel'
import { EQProPanel } from '@/components/eq/EQProPanel'
import { ExportPanel } from '@/components/export/ExportPanel'
import { ExportProgress } from '@/components/export/ExportProgress'
import { ToastContainer } from '@/components/ui/Toast'
import { InstallPrompt } from '@/components/ui/InstallPrompt'
import { useFileStore } from '@/store/useFileStore'
import { useAudioStore } from '@/store/useAudioStore'
import { audioEngine } from '@/audio/AudioEngine'
import { useAudioEngine } from '@/hooks/useAudioEngine'
import { useFFmpegLoader } from '@/hooks/useFFmpegLoader'
import { useLTASAnalysis } from '@/hooks/useLTASAnalysis'
import { formatTime } from '@/utils/audioMath'
import { cn } from '@/utils/cn'

interface StickyPlaybarProps {
  visible: boolean
}

function StickyPlaybar({ visible }: StickyPlaybarProps) {
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

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    if (duration === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audioEngine.seek(pct * duration)
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      className={cn(
        'sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b border-card-border',
        'px-3 py-2 flex items-center gap-2',
        !visible && 'hidden',
      )}
    >
      {/* Transport */}
      <button onClick={() => skip(-10)} className="text-text-secondary hover:text-text-primary transition-colors shrink-0" aria-label="-10s">
        <SkipBack size={16} />
      </button>
      <button
        onClick={togglePlay}
        className="w-8 h-8 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center transition-colors shrink-0"
        aria-label={isPlaying ? 'Pause' : 'Abspielen'}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
      </button>
      <button onClick={() => skip(10)} className="text-text-secondary hover:text-text-primary transition-colors shrink-0" aria-label="+10s">
        <SkipForward size={16} />
      </button>

      {/* Progress */}
      <span className="text-xs text-text-secondary tabular-nums shrink-0 w-9">{formatTime(currentTime)}</span>
      <div
        className="flex-1 h-1.5 bg-slider-track rounded-pill overflow-hidden cursor-pointer"
        onClick={seek}
        role="slider"
        aria-label="Abspielen-Position"
      >
        <div className="h-full bg-accent rounded-pill transition-none" style={{ width: `${progress}%` }} />
      </div>
      <span className="text-xs text-text-secondary tabular-nums shrink-0 w-9 text-right">{formatTime(duration)}</span>

      {/* A/B Compare */}
      <div className="flex gap-1 shrink-0">
        {(['original', 'processed'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => { setAbMode(mode); audioEngine.setABMode(mode) }}
            className={cn(
              'px-2 py-1 rounded-pill text-xs font-medium transition-colors',
              abMode === mode
                ? 'bg-accent text-white'
                : 'bg-slider-track text-text-secondary hover:text-text-primary',
            )}
          >
            {mode === 'original' ? 'Orig.' : 'Bear.'}
          </button>
        ))}
      </div>
    </div>
  )
}

function WorkspaceView() {
  const activeFile = useFileStore((s) => s.getActiveFile())
  const files = useFileStore((s) => s.files)
  const addFiles = useFileStore((s) => s.addFiles)
  const inputRef = useRef<HTMLInputElement>(null)

  // Observe the player section; show sticky bar when it's out of view
  const playerRef = useRef<HTMLDivElement>(null)
  const [showStickyBar, setShowStickyBar] = useState(false)

  useEffect(() => {
    const el = playerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => setShowStickyBar(!entry.isIntersecting),
      { threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useAudioEngine()
  useLTASAnalysis()

  if (!activeFile) return <DropZone />

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">

      {/* Compact sticky playbar — shown only when the player scrolls out of view */}
      <StickyPlaybar visible={showStickyBar} />

      {/* File name + add more */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-card-border">
        <div className="min-w-0 flex-1">
          <p className="text-text-primary text-sm font-medium truncate">{activeFile.name}</p>
          <p className="text-text-secondary text-xs">
            {files.length > 1 ? `${files.length} Dateien geladen` : 'Datei geladen'}
          </p>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1.5 text-xs text-accent border border-accent/40 rounded-pill px-2.5 py-1 hover:bg-accent/10 transition-colors ml-4 shrink-0"
        >
          <Plus size={12} />
          Dateien
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.aiff,.flac,.aac,.m4a,.ogg"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && addFiles(Array.from(e.target.files))}
        />
      </div>

      {/* Player section — observed for visibility to toggle sticky bar */}
      <div ref={playerRef}>
        <WaveformDisplay file={activeFile.file} />
        <TransportControls />
      </div>

      <div className="h-px bg-card-border mx-4 my-1" />

      {/* Processing */}
      <ProcessingPanel />

      <div className="h-px bg-card-border mx-4 my-1" />

      {/* Export */}
      <ExportPanel />

      {/* Batch file list */}
      <FileList />
    </div>
  )
}

export default function App() {
  useFFmpegLoader()

  const hasFiles = useFileStore((s) => s.files.length > 0)

  return (
    <Layout>
      {hasFiles ? <WorkspaceView /> : <DropZone />}
      <EQProPanel />
      <ExportProgress />
      <ToastContainer />
      <InstallPrompt />
    </Layout>
  )
}
