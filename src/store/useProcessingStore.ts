import { create } from 'zustand'
import type { ProcessingParams, ExportOptions } from '@/types/processing.types'
import { SPEECH_EQ_CURVE } from '@/utils/eqCurves'
import type { EQBand } from '@/types/audio.types'

interface ProcessingStore extends ProcessingParams {
  exportOptions: ExportOptions
  setHumEnabled: (v: boolean) => void
  setHumAmount: (v: number) => void
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
  setLimiterTarget: (v: number) => void
  setExportOptions: (opts: Partial<ExportOptions>) => void
  getParams: () => ProcessingParams
}

export const useProcessingStore = create<ProcessingStore>((set, get) => ({
  humEnabled: false,
  humAmount: 0.5,
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
  limiterTarget: -14,

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
  setLimiterTarget: (v) => set({ limiterTarget: v }),
  setExportOptions: (opts) =>
    set((s) => ({ exportOptions: { ...s.exportOptions, ...opts } })),

  getParams: (): ProcessingParams => {
    const s = get()
    return {
      humEnabled: s.humEnabled,
      humAmount: s.humAmount,
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
      limiterTarget: s.limiterTarget,
    }
  },
}))
