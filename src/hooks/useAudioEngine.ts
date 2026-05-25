import { useEffect, useRef } from 'react'
import { audioEngine } from '@/audio/AudioEngine'
import { useAudioStore } from '@/store/useAudioStore'
import { useFileStore } from '@/store/useFileStore'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useUIStore } from '@/store/useUIStore'
import { analyzeDynamics } from '@/audio/analysis/LUFSAnalyzer'
import {
  measureBufferDynamicsRangeDb,
  computeCompressedDynamicsDbSync,
  computeMakeupGainDb,
  DYNAMICS_WORKING_LEVEL_LUFS,
} from '@/audio/analysis/dynamicsMeter'
import { computeExportGainStaging } from '@/audio/analysis/previewGainMeter'
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
  if (bitrateKbps < 96) return 'low'
  if (bitrateKbps < 160) return 'medium'
  return 'high'
}

/** Reference to the last decoded buffer, used for offline compression simulation. */
let cachedBuffer: AudioBuffer | null = null
/** Pre-chain input gain (dB) matching AudioEngine.inputNormalizeGain. */
let cachedInputGainDb = 0
/** Cancels stale preview-gain runs when params change quickly. */
let previewGainGeneration = 0

async function refreshPreviewGainStaging(): Promise<void> {
  if (!cachedBuffer) return
  const gen = ++previewGainGeneration
  const state = useProcessingStore.getState()
  const params = state.getParams()
  const { makeupDb, gainDb, postCompTrimDb } = await computeExportGainStaging(
    cachedBuffer,
    cachedInputGainDb,
    params,
    state.limiterTarget,
  )
  if (gen !== previewGainGeneration) return
  audioEngine.setExportGainStaging(makeupDb, gainDb, postCompTrimDb)
}

export function useAudioEngine() {
  const { setIsPlaying, setCurrentTime, setDuration, setIsLoading, setAnalysis, setTrimStart, setTrimEnd } = useAudioStore()
  const activeFile = useFileStore((s) => s.getActiveFile())
  const updateFile = useFileStore((s) => s.updateFile)
  const initialized = useRef(false)
  const compressionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewGainDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    audioEngine.setOnTimeUpdate(setCurrentTime)
    audioEngine.setOnEnd(() => {
      setIsPlaying(false)
      // Reset to trimStart so playback restarts from the trim region
      const { trimStart } = useAudioStore.getState()
      setCurrentTime(trimStart)
    })
    // Only limiter intervention comes from real-time metering now.
    // Dynamics are computed offline for track-wide accuracy.
    audioEngine.setOnMetering((m) => {
      useProcessingStore.getState().setLimiterInterventionDb(m.limiterInterventionDb)
    })
  }, [setCurrentTime, setIsPlaying])

  // Sync processing params to the audio engine whenever the store changes.
  useEffect(() => {
    const applyParams = () => {
      const state = useProcessingStore.getState()
      audioEngine.updateParams(state.getParams())
      audioEngine.setPinkNoiseEnabled(state.pinkNoiseEnabled, state.pinkNoiseMixLinear)
    }
    return useProcessingStore.subscribe(applyParams)
  }, [])

  // Rebuild the hum filter graph when auto-mode peaks change (structural change).
  useEffect(() => {
    return useProcessingStore.subscribe((state, prev) => {
      const modeChanged = state.humAutoMode !== prev.humAutoMode
      const peaksChanged = state.humDetectedFreqs !== prev.humDetectedFreqs
      if (!modeChanged && !peaksChanged) return
      if (state.humAutoMode) {
        audioEngine.updateHumFilters(state.humDetectedFreqs)
      } else {
        // Reset to 4-band manual filter bank
        audioEngine.updateHumFilters([])
      }
    })
  }, [])

  // Debounced preview anchor LUFS — drives previewNormalizeGain (export gainDb parity).
  useEffect(() => {
    const schedule = () => {
      if (previewGainDebounceRef.current) clearTimeout(previewGainDebounceRef.current)
      previewGainDebounceRef.current = setTimeout(() => {
        refreshPreviewGainStaging().catch(() => {
          // Stale run or memory pressure — keep last valid staging.
        })
      }, 600)
    }

    const unsubscribe = useProcessingStore.subscribe((state, prev) => {
      if (
        state.compressionEnabled === prev.compressionEnabled &&
        state.compressionAmount === prev.compressionAmount &&
        state.contentType === prev.contentType &&
        state.eqEnabled === prev.eqEnabled &&
        state.eqIntensity === prev.eqIntensity &&
        state.eqBands === prev.eqBands &&
        state.humEnabled === prev.humEnabled &&
        state.humAmount === prev.humAmount &&
        state.humQ === prev.humQ &&
        state.humAutoMode === prev.humAutoMode &&
        state.humDetectedFreqs === prev.humDetectedFreqs &&
        state.exciterEnabled === prev.exciterEnabled &&
        state.exciterAmount === prev.exciterAmount &&
        state.exciterMode === prev.exciterMode &&
        state.desibilanceEnabled === prev.desibilanceEnabled &&
        state.desibilanceAmount === prev.desibilanceAmount &&
        state.limiterEnabled === prev.limiterEnabled &&
        state.limiterTarget === prev.limiterTarget
      ) return
      schedule()
    })

    return () => {
      unsubscribe()
      if (previewGainDebounceRef.current) clearTimeout(previewGainDebounceRef.current)
    }
  }, [])

  // Debounced offline computation — updates dynamics display.
  useEffect(() => {
    const unsubscribe = useProcessingStore.subscribe((state, prev) => {
      if (
        state.compressionEnabled === prev.compressionEnabled &&
        state.compressionAmount === prev.compressionAmount &&
        state.contentType === prev.contentType
      ) return

      if (compressionDebounceRef.current) clearTimeout(compressionDebounceRef.current)
      compressionDebounceRef.current = setTimeout(() => {
        if (!cachedBuffer) return
        const { compressionEnabled, compressionAmount, contentType } = state
        const db = computeCompressedDynamicsDbSync(cachedBuffer, compressionEnabled, compressionAmount, cachedInputGainDb, contentType)
        useProcessingStore.getState().setProcessedDynamicsDb(db)
        const makeupDb = computeMakeupGainDb(cachedBuffer, compressionEnabled, compressionAmount, cachedInputGainDb, contentType)
        audioEngine.setStaticMakeupGainDb(makeupDb)
      }, 300)
    })
    return () => {
      unsubscribe()
      if (compressionDebounceRef.current) clearTimeout(compressionDebounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (!activeFile) return

    let cancelled = false

    async function load() {
      if (!activeFile) return
      if (!initialized.current) initialized.current = true

      // ── Phase 1: decode audio ──────────────────────────────────────────────
      setIsLoading(true)
      useProcessingStore.setState({
        compressionUserAdjusted: false,
        processedDynamicsDb: 0,
        limiterInterventionDb: 0,
        pinkNoiseEnabled: false,
        dynamicsStatus: 'idle',
      })
      setTrimStart(0)
      setTrimEnd(null)

      let buffer: AudioBuffer
      try {
        buffer = await audioEngine.loadFile(activeFile.file)
      } catch (err) {
        console.error('Failed to load audio:', err)
        if (!cancelled) {
          setIsLoading(false)
          const msg = err instanceof Error ? err.message : String(err)
          const isTimeout = msg.includes('timed out')
          useUIStore.getState().addToast(
            isTimeout
              ? 'Track konnte nicht geladen werden. Die Datei ist möglicherweise zu groß oder das Format wird nicht unterstützt.'
              : `Fehler beim Laden: ${msg}`,
            'error',
          )
        }
        return
      }
      if (cancelled) return

      cachedBuffer = buffer
      cachedInputGainDb = DYNAMICS_WORKING_LEVEL_LUFS - audioEngine.loadedLUFS

      const pinkLinear = audioEngine.getPinkNoiseMixLinear()
      useProcessingStore.getState().setPinkNoiseMixLinear(pinkLinear)

      // Quick metadata (no heavy computation yet)
      setDuration(buffer.duration)
      const sr = buffer.sampleRate
      const sampleRate: SampleRate = sr >= 48000 ? 48000 : 44100
      updateFile(activeFile.id, { duration: buffer.duration, originalSampleRate: sr })

      const baseName = activeFile.name.replace(/\.[^.]+$/, '')
      const ext = activeFile.name.split('.').pop()?.toLowerCase() ?? ''
      const format: ExportFormat = FORMAT_MAP[ext] ?? 'mp3'
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
        normalizeToLUFS: useProcessingStore.getState().limiterTarget,
      })

      audioEngine.updateParams(useProcessingStore.getState().getParams())
      audioEngine.setPinkNoiseEnabled(useProcessingStore.getState().pinkNoiseEnabled, pinkLinear)

      // Phase 1 complete — release the "Track laden" spinner
      if (!cancelled) setIsLoading(false)

      // ── Phase 3: dynamics / makeup-gain (CPU-heavy, runs after the waveform appears) ──
      if (cancelled) return
      useProcessingStore.getState().setDynamicsStatus('running')
      // Yield so React can paint before the heavy sync work blocks the thread
      await Promise.resolve()
      if (cancelled) return

      try {
        const originalDynamicsDb = measureBufferDynamicsRangeDb(buffer)
        useProcessingStore.getState().setOriginalDynamicsDb(originalDynamicsDb)
        useProcessingStore.getState().applyCompressionAutoPreset(originalDynamicsDb)

        const { compressionEnabled, compressionAmount, contentType } = useProcessingStore.getState()
        const processedDynamicsDb = computeCompressedDynamicsDbSync(
          buffer, compressionEnabled, compressionAmount, cachedInputGainDb, contentType,
        )
        useProcessingStore.getState().setProcessedDynamicsDb(processedDynamicsDb)
        const makeupDb = computeMakeupGainDb(
          buffer, compressionEnabled, compressionAmount, cachedInputGainDb, contentType,
        )
        audioEngine.setStaticMakeupGainDb(makeupDb)

        await refreshPreviewGainStaging()

        const dynamics = analyzeDynamics(buffer)
        const lufs = audioEngine.loadedLUFS
        setAnalysis({
          ...dynamics,
          lufs,
          hasHum: false,
          hasNoise: dynamics.rms < -40,
        })
      } catch (err) {
        console.error('Dynamics computation failed:', err)
      } finally {
        if (!cancelled) useProcessingStore.getState().setDynamicsStatus('done')
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
