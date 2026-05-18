import type { EQBand, ExciterMode } from './audio.types'

export interface ProcessingParams {
  humEnabled: boolean
  humAmount: number
  humQ: number

  noiseEnabled: boolean
  noiseAmount: number

  eqEnabled: boolean
  eqIntensity: number
  eqBands: EQBand[]

  compressionEnabled: boolean
  compressionAmount: number

  exciterEnabled: boolean
  exciterAmount: number
  exciterMode: ExciterMode

  desibilanceEnabled: boolean
  /** 0 = bypass, 1 = maximum de-essing (threshold −30 dBFS, up to −12 dB gain reduction) */
  desibilanceAmount: number
  /** Detected sibilance peak frequency in Hz (auto-set by LTAS analysis) */
  desibilanceFreq: number

  limiterTarget: number
}

export type ExportFormat = 'mp3' | 'wav' | 'flac' | 'aac' | 'm4a' | 'ogg'
export type ExportQuality = 'low' | 'medium' | 'high' | 'lossless'
export type SampleRate = 44100 | 48000

export interface ExportOptions {
  format: ExportFormat
  quality: ExportQuality
  sampleRate: SampleRate
  channels: 1 | 2
  normalizeToLUFS: number
  filename: string
}
