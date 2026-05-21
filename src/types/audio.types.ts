export type BiquadFilterType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'lowshelf'
  | 'highshelf'
  | 'peaking'
  | 'notch'
  | 'allpass'

export interface EQBand {
  id: string
  label: string
  freq: number
  gain: number
  q: number
  type: BiquadFilterType
  enabled: boolean
}

export type ExciterMode = 'brilliance' | 'warmth'

export interface AudioAnalysis {
  lufs: number
  peak: number
  rms: number
  /** P80−P20 dynamics range in dB (raw file). */
  dynamicsRangeDb: number
  crestFactor: number
  dynamicsCategory: 'very_dynamic' | 'normal' | 'compressed' | 'clipped'
  hasHum: boolean
  hasNoise: boolean
  suggestedThreshold: number
  suggestedRatio: number
}

export type LimiterInterventionLevel = 'ok' | 'warn' | 'critical'

export type AudioContextState = 'uninitialized' | 'running' | 'suspended' | 'closed'
