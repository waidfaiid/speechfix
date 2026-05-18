import { create } from 'zustand'
import type { ProcessingParams, ExportOptions } from '@/types/processing.types'
import { SPEECH_EQ_CURVE } from '@/utils/eqCurves'
import { SPEECH_REFERENCE_LTAS } from '@/utils/speechReferenceLTAS'
import type { EQBand } from '@/types/audio.types'

export type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'

interface ProcessingStore extends ProcessingParams {
  exportOptions: ExportOptions

  // LTAS analysis state
  measuredLTAS: Float32Array | null
  referenceLTAS: Float32Array
  analysisStatus: AnalysisStatus
  analysisProgress: number

  setHumEnabled: (v: boolean) => void
  setHumAmount: (v: number) => void
  setHumQ: (v: number) => void
  setNoiseEnabled: (v: boolean) => void
  setNoiseAmount: (v: number) => void
  setEqEnabled: (v: boolean) => void
  setEqIntensity: (v: number) => void
  setEqBands: (bands: EQBand[]) => void
  setEqBand: (id: string, changes: Partial<EQBand>) => void
  setCompressionEnabled: (v: boolean) => void
  setCompressionAmount: (v: number) => void
  setExciterEnabled: (v: boolean) => void
  setExciterAmount: (v: number) => void
  setExciterMode: (v: 'brilliance' | 'warmth') => void
  setDesibilanceEnabled: (v: boolean) => void
  setDesibilanceAmount: (v: number) => void
  setDesibilanceFreq: (v: number) => void
  setLimiterTarget: (v: number) => void
  setExportOptions: (opts: Partial<ExportOptions>) => void
  getParams: () => ProcessingParams

  setMeasuredLTAS: (ltas: Float32Array | null) => void
  setAnalysisStatus: (s: AnalysisStatus) => void
  setAnalysisProgress: (p: number) => void
}

export const useProcessingStore = create<ProcessingStore>((set, get) => ({
  humEnabled: false,
  humAmount: 0.5,
  humQ: 12,
  noiseEnabled: false,
  noiseAmount: 0.4,
  eqEnabled: true,
  eqIntensity: 0.5,
  eqBands: SPEECH_EQ_CURVE,
  compressionEnabled: false,
  compressionAmount: 0.3,
  exciterEnabled: false,
  exciterAmount: 0.2,
  exciterMode: 'brilliance',
  desibilanceEnabled: false,
  desibilanceAmount: 0,
  desibilanceFreq: 7000,
  limiterTarget: -14,

  measuredLTAS: null,
  referenceLTAS: SPEECH_REFERENCE_LTAS,
  analysisStatus: 'idle',
  analysisProgress: 0,

  exportOptions: {
    format: 'mp3',
    quality: 'high',
    sampleRate: 44100,
    channels: 2,
    normalizeToLUFS: -14,
    filename: 'predigt_fixed',
  },

  setHumEnabled: (v) => set({ humEnabled: v }),
  setHumAmount: (v) => set({ humAmount: v }),
  setHumQ: (v) => set({ humQ: v }),
  setNoiseEnabled: (v) => set({ noiseEnabled: v }),
  setNoiseAmount: (v) => set({ noiseAmount: v }),
  setEqEnabled: (v) => set({ eqEnabled: v }),
  setEqIntensity: (v) => set({ eqIntensity: v }),
  setEqBands: (bands) => set({ eqBands: bands }),
  setEqBand: (id, changes) =>
    set((s) => ({
      eqBands: s.eqBands.map((b) => (b.id === id ? { ...b, ...changes } : b)),
    })),
  setCompressionEnabled: (v) => set({ compressionEnabled: v }),
  setCompressionAmount: (v) => set({ compressionAmount: v }),
  setExciterEnabled: (v) => set({ exciterEnabled: v }),
  setExciterAmount: (v) => set({ exciterAmount: v }),
  setExciterMode: (v) => set({ exciterMode: v }),
  setDesibilanceEnabled: (v) => set({ desibilanceEnabled: v }),
  setDesibilanceAmount: (v) => set({ desibilanceAmount: v }),
  setDesibilanceFreq: (v) => set({ desibilanceFreq: v }),
  setLimiterTarget: (v) => set({ limiterTarget: v }),
  setExportOptions: (opts) =>
    set((s) => ({ exportOptions: { ...s.exportOptions, ...opts } })),

  setMeasuredLTAS: (ltas) => set({ measuredLTAS: ltas }),
  setAnalysisStatus: (s) => set({ analysisStatus: s }),
  setAnalysisProgress: (p) => set({ analysisProgress: p }),

  getParams: (): ProcessingParams => {
    const s = get()
    return {
      humEnabled: s.humEnabled,
      humAmount: s.humAmount,
      humQ: s.humQ,
      noiseEnabled: s.noiseEnabled,
      noiseAmount: s.noiseAmount,
      eqEnabled: s.eqEnabled,
      eqIntensity: s.eqIntensity,
      eqBands: s.eqBands,
      compressionEnabled: s.compressionEnabled,
      compressionAmount: s.compressionAmount,
      exciterEnabled: s.exciterEnabled,
      exciterAmount: s.exciterAmount,
      exciterMode: s.exciterMode,
      desibilanceEnabled: s.desibilanceEnabled,
      desibilanceAmount: s.desibilanceAmount,
      desibilanceFreq: s.desibilanceFreq,
      limiterTarget: s.limiterTarget,
    }
  },
}))
