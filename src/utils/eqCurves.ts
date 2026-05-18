import type { EQBand } from '@/types/audio.types'

// Shared labels (same IDs as SPEECH_ZONES in eqMatcher.ts)
// All adjustable bands use speech-friendly German names.

export const SPEECH_EQ_CURVE: EQBand[] = [
  { id: 'hp',          label: 'Rumpeln',  freq: 80,    gain: -30, q: 0.7, type: 'highpass', enabled: true },
  { id: 'mud',         label: 'Bass',     freq: 150,   gain: -2,  q: 0.7, type: 'lowshelf', enabled: true },
  { id: 'body',        label: 'Körper',   freq: 350,   gain: -1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence1',   label: 'Mitten',   freq: 900,   gain: +1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence2',   label: 'Präsenz',  freq: 2500,  gain: +2,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'articulation',label: 'Zwischen', freq: 5500,  gain: +2,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'air',         label: 'Klarheit', freq: 10000, gain: +1.5,q: 0.7, type: 'highshelf',enabled: true },
]

export const SPEECH_WARM_EQ: EQBand[] = [
  { id: 'hp',          label: 'Rumpeln',  freq: 80,    gain: -30, q: 0.7, type: 'highpass', enabled: true },
  { id: 'mud',         label: 'Bass',     freq: 150,   gain: -1,  q: 0.7, type: 'lowshelf', enabled: true },
  { id: 'body',        label: 'Körper',   freq: 350,   gain: +1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence1',   label: 'Mitten',   freq: 900,   gain: +1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence2',   label: 'Präsenz',  freq: 2500,  gain: +1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'articulation',label: 'Zwischen', freq: 5500,  gain: +1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'air',         label: 'Klarheit', freq: 10000, gain: +0.5,q: 0.7, type: 'highshelf',enabled: true },
]

export const SPEECH_BRIGHT_EQ: EQBand[] = [
  { id: 'hp',          label: 'Rumpeln',  freq: 80,    gain: -30, q: 0.7, type: 'highpass', enabled: true },
  { id: 'mud',         label: 'Bass',     freq: 150,   gain: -4,  q: 0.7, type: 'lowshelf', enabled: true },
  { id: 'body',        label: 'Körper',   freq: 350,   gain: -2,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence1',   label: 'Mitten',   freq: 900,   gain: +3,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence2',   label: 'Präsenz',  freq: 2500,  gain: +4,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'articulation',label: 'Zwischen', freq: 5500,  gain: +3,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'air',         label: 'Klarheit', freq: 10000, gain: +3,  q: 0.7, type: 'highshelf',enabled: true },
]

export const PODCAST_EQ: EQBand[] = [
  { id: 'hp',          label: 'Rumpeln',  freq: 80,    gain: -30, q: 0.7, type: 'highpass', enabled: true },
  { id: 'mud',         label: 'Bass',     freq: 150,   gain: -2,  q: 0.7, type: 'lowshelf', enabled: true },
  { id: 'body',        label: 'Körper',   freq: 350,   gain: -1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence1',   label: 'Mitten',   freq: 900,   gain: +2,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'presence2',   label: 'Präsenz',  freq: 2500,  gain: +2,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'articulation',label: 'Zwischen', freq: 5500,  gain: +1,  q: 2.0, type: 'peaking',  enabled: true },
  { id: 'air',         label: 'Klarheit', freq: 10000, gain: +1,  q: 0.7, type: 'highshelf',enabled: true },
]

export const FLAT_EQ: EQBand[] = SPEECH_EQ_CURVE.map(b => ({ ...b, gain: 0 }))

export const EQ_PRESETS = {
  speech_neutral: SPEECH_EQ_CURVE,
  speech_warm:    SPEECH_WARM_EQ,
  speech_bright:  SPEECH_BRIGHT_EQ,
  podcast:        PODCAST_EQ,
  flat:           FLAT_EQ,
} as const

export type EQPresetKey = keyof typeof EQ_PRESETS
