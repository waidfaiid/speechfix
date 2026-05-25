import { useRef, useState, useEffect } from 'react'
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
import { lerp } from '@/utils/audioMath'

function WorkspaceView() {
  const activeFile = useFileStore((s) => s.getActiveFile())
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [collapseProgress, setCollapseProgress] = useState(0)
  const [stickyTop, setStickyTop] = useState(0)

  useAudioEngine()
  useLTASAnalysis()

  useEffect(() => {
    const header = document.querySelector('header')
    if (header) setStickyTop(header.getBoundingClientRect().height)

    let rafId = 0
    const COLLAPSE_DISTANCE = 140

    function update() {
      rafId = 0
      const sentinel = sentinelRef.current
      if (!sentinel) return
      const hdr = document.querySelector('header')
      const hdrH = hdr ? hdr.getBoundingClientRect().height : 0
      const sentinelTop = sentinel.getBoundingClientRect().top
      const scrollPast = hdrH - sentinelTop
      setCollapseProgress(Math.max(0, Math.min(1, scrollPast / COLLAPSE_DISTANCE)))
    }

    function onScroll() {
      if (!rafId) rafId = requestAnimationFrame(update)
    }

    function onResize() {
      const hdr = document.querySelector('header')
      if (hdr) setStickyTop(hdr.getBoundingClientRect().height)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    update()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  if (!activeFile) return <DropZone />

  const p = collapseProgress
  const nameMaxH = Math.round(lerp(60, 0, Math.min(1, p * 2.5)))
  const nameOpacity = Math.max(0, 1 - p * 2.5)

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Sentinel marks original player position */}
      <div ref={sentinelRef} className="h-4 shrink-0" />

      {/* Sticky collapsing player */}
      <div
        className="sticky z-30 bg-background"
        style={{
          top: `${stickyTop}px`,
          boxShadow: p > 0.05
            ? `0 1px 0 rgba(51,48,45,${Math.min(0.8, p * 2)})`
            : 'none',
        }}
      >
        {/* File name — collapses first */}
        <div
          style={{
            maxHeight: `${nameMaxH}px`,
            opacity: nameOpacity,
            overflow: 'hidden',
          }}
        >
          <div className="px-3 flex justify-between items-center mb-3 gap-2 pt-2">
            <div className="font-medium text-sm text-white truncate min-w-0">
              {activeFile.name}
            </div>
            <div className="text-[10px] text-text-secondary bg-background border border-card-border px-2 py-1 rounded-md shrink-0">
              Geladen
            </div>
          </div>
        </div>

        <WaveformDisplay file={activeFile.file} collapseProgress={p} />
        <TransportControls collapseProgress={p} />
      </div>

      <ProcessingPanel />
      <ExportPanel />
      <FileList />
    </div>
  )
}

export default function App() {
  useFFmpegLoader()

  const hasFiles = useFileStore((s) => s.files.length > 0)

  // Global keyboard shortcuts: Space = play/pause, ← = −10 s, → = +10 s
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return

      if (e.code === 'Space') {
        e.preventDefault()
        const { isPlaying } = useAudioStore.getState()
        if (isPlaying) {
          audioEngine.pause()
          useAudioStore.getState().setIsPlaying(false)
        } else {
          audioEngine.play()
          useAudioStore.getState().setIsPlaying(true)
        }
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        const { currentTime, duration, trimStart } = useAudioStore.getState()
        const next = Math.max(trimStart, currentTime - 10)
        audioEngine.seek(next)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        const { currentTime, duration, trimEnd } = useAudioStore.getState()
        const hi = trimEnd ?? duration
        const next = Math.min(hi, currentTime + 10)
        audioEngine.seek(next)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
