import type { EQBand, ExciterMode } from './audio.types'

export type ContentType = 'speech' | 'mixed'

export interface DetectedHumPeak {
  /** Frequency in Hz */
  frequency: number
  /** Amplitude above local noise floor in dB */
  amplitude: number
  /** Filter Q (sharpness) derived from measured peak width */
  q: number
  /** Notch depth in dB (negative) */
  gainDb: number
  /** Whether this peak is enabled for filtering */
  enabled: boolean
}

export interface ProcessingParams {
  humEnabled: boolean
  humAmount: number
  humQ: number
  /** true = use auto-detected peaks; false = use legacy 4-band manual mode */
  humAutoMode: boolean
  /** Peaks detected by HumAnalyzer (auto mode only) */
  humDetectedFreqs: DetectedHumPeak[]
  /** Enable spectral subtraction as second stage after notch filters */
  humSpectralSubtraction: boolean
  /** Spectral subtraction factor α (0.5–2.0) */
  humSubtractionAlpha: number

  noiseEnabled: boolean
  noiseAmount: number
  /** Dry-path delay in milliseconds to time-align the original signal with the
   *  DTLN-processed wet signal.  Compensates for the WorkletNode ring-buffer
   *  latency (~32 ms) plus the two MediaStream bridge hops (~10 ms).
   *  User-adjustable in 1 ms steps via the ± controls in ProcessingPanel. */
  dtlnLatencyMs: number

  eqEnabled: boolean
  eqIntensity: number
  eqBands: EQBand[]

  compressionEnabled: boolean
  /** 0 = light, 1 = heavy (stage-2 LA2A-style compressor). */
  compressionAmount: number
  /** User moved the compressor slider after auto-preset. */
  compressionUserAdjusted: boolean

  pinkNoiseEnabled: boolean

  exciterEnabled: boolean
  exciterAmount: number
  exciterMode: ExciterMode

  desibilanceEnabled: boolean
  /** 0 = bypass, 1 = maximum de-essing (threshold −30 dBFS, up to −12 dB gain reduction) */
  desibilanceAmount: number
  /** Detected sibilance peak frequency in Hz (auto-set by LTAS analysis) */
  desibilanceFreq: number

  limiterTarget: number
  contentType: ContentType
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
  /** Trim start in seconds — audio before this point is excluded from export */
  trimStart?: number
  /** Trim end in seconds (absolute position) — audio after this point is excluded from export */
  trimEnd?: number
}
