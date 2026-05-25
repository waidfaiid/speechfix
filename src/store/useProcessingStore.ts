import { create } from 'zustand'
import type { ProcessingParams, ExportOptions, ContentType, DetectedHumPeak } from '@/types/processing.types'
import { suggestCompressionAmount, DYNAMICS_AUTO_TARGET_DB, DYNAMICS_AUTO_TARGET_DB_MIXED } from '@/audio/analysis/dynamicsMeter'
import { SPEECH_EQ_CURVE } from '@/utils/eqCurves'
import { SPEECH_REFERENCE_LTAS, FLAT_REFERENCE_LTAS } from '@/utils/speechReferenceLTAS'
import type { EQBand } from '@/types/audio.types'

export type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'
export type DynamicsStatus = 'idle' | 'running' | 'done'
export type HumAnalysisState = 'idle' | 'analyzing' | 'done' | 'error'

interface ProcessingStore extends ProcessingParams {
  exportOptions: ExportOptions

  // LTAS analysis state
  measuredLTAS: Float32Array | null
  referenceLTAS: Float32Array
  analysisStatus: AnalysisStatus
  analysisProgress: number

  // Dynamics / makeup-gain computation state (Phase 3 of loading)
  dynamicsStatus: DynamicsStatus

  // Hum noise-profile state (store-only, not passed to engine/export directly)
  humNoiseProfileStart: number | null
  humNoiseProfileEnd: number | null
  humNoiseProfile: Float32Array | null
  humAnalysisState: HumAnalysisState

  setHumEnabled: (v: boolean) => void
  setHumAmount: (v: number) => void
  setHumQ: (v: number) => void
  setHumAutoMode: (v: boolean) => void
  setHumDetectedFreqs: (peaks: DetectedHumPeak[]) => void
  setHumPeakEnabled: (index: number, enabled: boolean) => void
  setHumSpectralSubtraction: (v: boolean) => void
  setHumSubtractionAlpha: (v: number) => void
  setHumNoiseProfileStart: (v: number | null) => void
  setHumNoiseProfileEnd: (v: number | null) => void
  setHumNoiseProfile: (profile: Float32Array | null) => void
  setHumAnalysisState: (s: HumAnalysisState) => void
  setNoiseEnabled: (v: boolean) => void
  setNoiseAmount: (v: number) => void
  setNoiseLatencyMs: (v: number) => void
  setEqEnabled: (v: boolean) => void
  setEqIntensity: (v: number) => void
  setEqBands: (bands: EQBand[]) => void
  setEqBand: (id: string, changes: Partial<EQBand>) => void
  originalDynamicsDb: number
  processedDynamicsDb: number
  limiterInterventionDb: number
  pinkNoiseMixLinear: number

  setCompressionEnabled: (v: boolean) => void
  setCompressionAmount: (v: number) => void
  setCompressionUserAdjusted: (v: boolean) => void
  setOriginalDynamicsDb: (v: number) => void
  setProcessedDynamicsDb: (v: number) => void
  setLimiterInterventionDb: (v: number) => void
  setPinkNoiseEnabled: (v: boolean) => void
  setPinkNoiseMixLinear: (v: number) => void
  applyCompressionAutoPreset: (originalDynamicsDb: number) => void
  setExciterEnabled: (v: boolean) => void
  setExciterAmount: (v: number) => void
  setExciterMode: (v: 'auto' | 'tube' | 'tape') => void
  setDesibilanceEnabled: (v: boolean) => void
  setDesibilanceAmount: (v: number) => void
  setDesibilanceFreq: (v: number) => void
  setLimiterEnabled: (v: boolean) => void
  setLimiterTarget: (v: number) => void
  setContentType: (v: ContentType) => void
  setExportOptions: (opts: Partial<ExportOptions>) => void
  getParams: () => ProcessingParams

  setMeasuredLTAS: (ltas: Float32Array | null) => void
  setAnalysisStatus: (s: AnalysisStatus) => void
  setAnalysisProgress: (p: number) => void
  setDynamicsStatus: (s: DynamicsStatus) => void
}

export const useProcessingStore = create<ProcessingStore>((set, get) => ({
  humEnabled: false,
  humAmount: 0.5,
  humQ: 12,
  humAutoMode: false,
  humDetectedFreqs: [],
  humSpectralSubtraction: false,
  humSubtractionAlpha: 1.0,
  humNoiseProfileStart: null,
  humNoiseProfileEnd: null,
  humNoiseProfile: null,
  humAnalysisState: 'idle' as HumAnalysisState,
  noiseEnabled: false,
  noiseAmount: 0.4,
  noiseLatencyMs: 28.65,
  eqEnabled: true,
  eqIntensity: 0.5,
  eqBands: SPEECH_EQ_CURVE,
  compressionEnabled: true,
  compressionAmount: 0.35,
  compressionUserAdjusted: false,
  originalDynamicsDb: 0,
  processedDynamicsDb: 0,
  limiterInterventionDb: 0,
  pinkNoiseEnabled: false,
  pinkNoiseMixLinear: 0,
  exciterEnabled: false,
  exciterAmount: 0.2,
  exciterMode: 'auto',
  desibilanceEnabled: false,
  desibilanceAmount: 0,
  desibilanceFreq: 7000,
  limiterEnabled: true,
  limiterTarget: -16,
  contentType: 'speech' as ContentType,

  measuredLTAS: null,
  referenceLTAS: SPEECH_REFERENCE_LTAS,
  analysisStatus: 'idle',
  analysisProgress: 0,
  dynamicsStatus: 'idle',

  exportOptions: {
    format: 'mp3',
    quality: 'high',
    sampleRate: 44100,
    channels: 2,
    normalizeToLUFS: -16,
    filename: '',
    filenameSuffix: '_fixed',
  },

  setHumEnabled: (v) => set({ humEnabled: v }),
  setHumAmount: (v) => set({ humAmount: v }),
  setHumQ: (v) => set({ humQ: v }),
  setHumAutoMode: (v) => set({ humAutoMode: v }),
  setHumDetectedFreqs: (peaks) => set({ humDetectedFreqs: peaks }),
  setHumPeakEnabled: (index, enabled) =>
    set((s) => ({
      humDetectedFreqs: s.humDetectedFreqs.map((p, i) =>
        i === index ? { ...p, enabled } : p,
      ),
    })),
  setHumSpectralSubtraction: (v) => set({ humSpectralSubtraction: v }),
  setHumSubtractionAlpha: (v) => set({ humSubtractionAlpha: v }),
  setHumNoiseProfileStart: (v) => set({ humNoiseProfileStart: v }),
  setHumNoiseProfileEnd: (v) => set({ humNoiseProfileEnd: v }),
  setHumNoiseProfile: (profile) => set({ humNoiseProfile: profile }),
  setHumAnalysisState: (s) => set({ humAnalysisState: s }),
  setNoiseEnabled: (v) => set({ noiseEnabled: v }),
  setNoiseAmount: (v) => set({ noiseAmount: v }),
  setNoiseLatencyMs: (v) => set({ noiseLatencyMs: Math.round(Math.max(0, Math.min(50, v)) * 100) / 100 }),
  setEqEnabled: (v) => set({ eqEnabled: v }),
  setEqIntensity: (v) => set({ eqIntensity: v }),
  setEqBands: (bands) => set({ eqBands: bands }),
  setEqBand: (id, changes) =>
    set((s) => ({
      eqBands: s.eqBands.map((b) => (b.id === id ? { ...b, ...changes } : b)),
    })),
  setCompressionEnabled: (v) => set({ compressionEnabled: v }),
  setCompressionAmount: (v) => {
    set({ compressionAmount: v, compressionUserAdjusted: true })
  },
  setCompressionUserAdjusted: (v) => set({ compressionUserAdjusted: v }),
  setOriginalDynamicsDb: (v) => set({ originalDynamicsDb: v }),
  setProcessedDynamicsDb: (v) => set({ processedDynamicsDb: v }),
  setLimiterInterventionDb: (v) => set({ limiterInterventionDb: v }),
  setPinkNoiseEnabled: (v) => set({ pinkNoiseEnabled: v }),
  setPinkNoiseMixLinear: (v) => set({ pinkNoiseMixLinear: v }),
  applyCompressionAutoPreset: (originalDynamicsDb) => {
    const { compressionUserAdjusted, contentType } = get()
    if (compressionUserAdjusted) return
    const autoTarget = contentType === 'mixed' ? DYNAMICS_AUTO_TARGET_DB_MIXED : DYNAMICS_AUTO_TARGET_DB
    const needsCompression = originalDynamicsDb > autoTarget
    const suggestedAmount = needsCompression ? suggestCompressionAmount(originalDynamicsDb) : 0
    const cappedAmount = contentType === 'mixed' ? Math.min(suggestedAmount, 0.25) : suggestedAmount
    set({
      originalDynamicsDb,
      compressionEnabled: needsCompression,
      ...(needsCompression && { compressionAmount: cappedAmount }),
    })
  },
  setExciterEnabled: (v) => set({ exciterEnabled: v }),
  setExciterAmount: (v) => set({ exciterAmount: v }),
  setExciterMode: (v) => set({ exciterMode: v }),
  setDesibilanceEnabled: (v) => set({ desibilanceEnabled: v }),
  setDesibilanceAmount: (v) => set({ desibilanceAmount: v }),
  setDesibilanceFreq: (v) => set({ desibilanceFreq: v }),
  setLimiterEnabled: (v) => set({ limiterEnabled: v }),
  setLimiterTarget: (v) => set({ limiterTarget: v }),
  setContentType: (v) => {
    const referenceLTAS = v === 'mixed' ? FLAT_REFERENCE_LTAS : SPEECH_REFERENCE_LTAS
    set({ contentType: v, referenceLTAS })
    // Re-apply compression auto-preset with the new content type's target threshold
    const { originalDynamicsDb } = get()
    if (originalDynamicsDb > 0) {
      get().applyCompressionAutoPreset(originalDynamicsDb)
    }
  },
  setExportOptions: (opts) =>
    set((s) => ({ exportOptions: { ...s.exportOptions, ...opts } })),

  setMeasuredLTAS: (ltas) => set({ measuredLTAS: ltas }),
  setAnalysisStatus: (s) => set({ analysisStatus: s }),
  setAnalysisProgress: (p) => set({ analysisProgress: p }),
  setDynamicsStatus: (s) => set({ dynamicsStatus: s }),

  getParams: (): ProcessingParams => {
    const s = get()
    return {
      humEnabled: s.humEnabled,
      humAmount: s.humAmount,
      humQ: s.humQ,
      humAutoMode: s.humAutoMode,
      humDetectedFreqs: s.humDetectedFreqs,
      humSpectralSubtraction: s.humSpectralSubtraction,
      humSubtractionAlpha: s.humSubtractionAlpha,
      noiseEnabled: s.noiseEnabled,
      noiseAmount: s.noiseAmount,
      noiseLatencyMs: s.noiseLatencyMs,
      eqEnabled: s.eqEnabled,
      eqIntensity: s.eqIntensity,
      eqBands: s.eqBands,
      compressionEnabled: s.compressionEnabled,
      compressionAmount: s.compressionAmount,
      compressionUserAdjusted: s.compressionUserAdjusted,
      pinkNoiseEnabled: s.pinkNoiseEnabled,
      exciterEnabled: s.exciterEnabled,
      exciterAmount: s.exciterAmount,
      exciterMode: s.exciterMode,
      desibilanceEnabled: s.desibilanceEnabled,
      desibilanceAmount: s.desibilanceAmount,
      desibilanceFreq: s.desibilanceFreq,
      limiterEnabled: s.limiterEnabled,
      limiterTarget: s.limiterTarget,
      contentType: s.contentType,
    }
  },
}))
