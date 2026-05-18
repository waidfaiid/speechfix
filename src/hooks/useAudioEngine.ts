import { useEffect, useRef } from 'react'
import { audioEngine } from '@/audio/AudioEngine'
import { useAudioStore } from '@/store/useAudioStore'
import { useFileStore } from '@/store/useFileStore'
import { useProcessingStore } from '@/store/useProcessingStore'
import { LUFSAnalyzer, analyzeDynamics } from '@/audio/analysis/LUFSAnalyzer'
import type { ExportFormat, ExportQuality, SampleRate } from '@/types/processing.types'

const LOSSLESS_EXTS = new Set(['wav', 'flac', 'aiff', 'aif'])
const FORMAT_MAP: Record<string, ExportFormat> = {
  mp3: 'mp3', wav: 'wav', flac: 'flac', aac: 'aac', m4a: 'm4a', ogg: 'ogg', aiff: 'wav',
}
const QUALITY_ORDER: ExportQuality[] = ['low', 'medium', 'high', 'lossless']

function getQualityCeiling(fileName: string, fileSize: number, duration: number): ExportQuality {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (LOSSLESS_EXTS.has(ext)) return 'lossless'
  if (duration <= 0) return 'high'
  const bitrateKbps = (fileSize * 8) / duration / 1000
  if (bitrateKbps < 96)  return 'low'
  if (bitrateKbps < 160) return 'medium'
  return 'high'
}

const lufsAnalyzer = new LUFSAnalyzer()

export function useAudioEngine() {
  const { setIsPlaying, setCurrentTime, setDuration, setIsLoading, setAnalysis } = useAudioStore()
  const activeFile = useFileStore((s) => s.getActiveFile())
  const updateFile = useFileStore((s) => s.updateFile)
  const initialized = useRef(false)

  useEffect(() => {
    audioEngine.setOnTimeUpdate(setCurrentTime)
    audioEngine.setOnEnd(() => {
      setIsPlaying(false)
      setCurrentTime(0)
    })
  }, [setCurrentTime, setIsPlaying])

  // Sync processing params to the audio engine in real-time.
  // Zustand's subscribe fires synchronously on every store change, so slider
  // moves are heard immediately without going through the React render cycle.
  useEffect(() => {
    const applyParams = () =>
      audioEngine.updateParams(useProcessingStore.getState().getParams())
    return useProcessingStore.subscribe(applyParams)
  }, [])

  useEffect(() => {
    if (!activeFile) return

    let cancelled = false

    async function load() {
      if (!activeFile) return
      setIsLoading(true)
      try {
        if (!initialized.current) {
          initialized.current = true
        }
        const buffer = await audioEngine.loadFile(activeFile.file)
        if (cancelled) return

        // Apply the current processing params to the freshly-built audio graph.
        audioEngine.updateParams(useProcessingStore.getState().getParams())

        setDuration(buffer.duration)
        const sr = buffer.sampleRate
        const sampleRate: SampleRate = sr >= 48000 ? 48000 : 44100
        updateFile(activeFile.id, { duration: buffer.duration, originalSampleRate: sr })

        // Update export defaults to match the loaded file
        const baseName = activeFile.name.replace(/\.[^.]+$/, '')
        const ext = activeFile.name.split('.').pop()?.toLowerCase() ?? ''
        const format: ExportFormat = FORMAT_MAP[ext] ?? 'mp3'

        // Cap quality to what makes sense given the source bitrate
        const ceiling = getQualityCeiling(activeFile.name, activeFile.file.size, buffer.duration)
        const currentQuality = useProcessingStore.getState().exportOptions.quality
        const quality: ExportQuality =
          QUALITY_ORDER.indexOf(currentQuality) > QUALITY_ORDER.indexOf(ceiling)
            ? ceiling
            : currentQuality

        useProcessingStore.getState().setExportOptions({
          filename: baseName,
          sampleRate,
          format,
          quality,
        })

        const dynamics = analyzeDynamics(buffer)
        const lufs = lufsAnalyzer.analyze(buffer)
        setAnalysis({
          ...dynamics,
          lufs,
          hasHum: false,
          hasNoise: dynamics.rms < -40,
        })
      } catch (err) {
        console.error('Failed to load audio:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [activeFile?.id])

  function initAndPlay() {
    if (!activeFile) return
    if (useAudioStore.getState().isPlaying) {
      audioEngine.pause()
      setIsPlaying(false)
    } else {
      audioEngine.play()
      setIsPlaying(true)
    }
  }

  return { initAndPlay }
}
