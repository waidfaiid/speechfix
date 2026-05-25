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
  /** Delay in ms applied to the dry bypass path to compensate for RNNoise latency.
   *  Default 10 ms (= 480 samples at 48 kHz). User-tunable via ± buttons. */
  noiseLatencyMs: number

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

  limiterEnabled: boolean
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
  /** Suffix appended between the base filename and the extension, e.g. "_fixed". Empty string = no suffix. */
  filenameSuffix: string
  /** Trim start in seconds — audio before this point is excluded from export */
  trimStart?: number
  /** Trim end in seconds (absolute position) — audio after this point is excluded from export */
  trimEnd?: number
}
