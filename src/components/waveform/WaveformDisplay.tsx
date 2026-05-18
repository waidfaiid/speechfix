import { useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { useAudioStore } from '@/store/useAudioStore'
import { useProcessingStore } from '@/store/useProcessingStore'
import { audioEngine } from '@/audio/AudioEngine'

interface WaveformDisplayProps {
  file: File
}

export function WaveformDisplay({ file }: WaveformDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const setDuration = useAudioStore((s) => s.setDuration)
  const setCurrentTime = useAudioStore((s) => s.setCurrentTime)
  const isLoading = useAudioStore((s) => s.isLoading)
  const analysisStatus = useProcessingStore((s) => s.analysisStatus)
  const analysisProgress = useProcessingStore((s) => s.analysisProgress)

  const isAnalyzing = isLoading || analysisStatus === 'running'

  // Phase 1 (audio decode) shows a small initial value; phase 2 (LTAS FFT) drives the real progress.
  const progress = analysisStatus === 'running'
    ? Math.round(analysisProgress * 100)
    : isLoading
    ? 5
    : 100

  const label = analysisStatus === 'running'
    ? 'Frequenzkurve wird analysiert…'
    : 'Track wird geladen…'

  useEffect(() => {
    if (!containerRef.current) return

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#1e293b',
      progressColor: '#6366f1',
      cursorColor: '#6366f1',
      cursorWidth: 2,
      height: 72,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      interact: true,
      backend: 'WebAudio',
    })

    ws.on('ready', (dur: number) => {
      setDuration(dur)
    })

    ws.on('interaction', () => {
      const time = ws.getCurrentTime()
      setCurrentTime(time)
      audioEngine.seek(time)
    })

    ws.on('timeupdate', (time: number) => {
      setCurrentTime(time)
    })

    ws.loadBlob(file)

    return () => {
      ws.destroy()
    }
  }, [file, setDuration, setCurrentTime])

  return (
    <div className="px-4 py-3">
      <div className="relative">
        {/* Loading / analysis progress bar */}
        {isAnalyzing && (
          <div className="absolute inset-x-0 top-0 h-[72px] flex flex-col justify-center gap-2.5 px-1">
            <div className="flex justify-between items-center text-xs">
              <span className="text-text-secondary">{label}</span>
              <span className="text-text-secondary tabular-nums font-medium">{progress}%</span>
            </div>
            <div className="w-full h-1.5 bg-card-border rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
        {/* Waveform — always mounted so WaveSurfer renders in the background; revealed when ready */}
        <div
          ref={containerRef}
          className={`w-full rounded-lg overflow-hidden ${isAnalyzing ? 'invisible' : 'visible'}`}
        />
      </div>
    </div>
  )
}
