import { Radio, Volume2, SlidersHorizontal, Activity, Sparkles, Target, Repeat, AudioWaveform } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useAudioStore } from '@/store/useAudioStore'
import { useUIStore } from '@/store/useUIStore'
import { ProcessingSlider } from './ProcessingSlider'
import { cn } from '@/utils/cn'

const LUFS_OPTIONS = [-10, -12, -14, -16, -18, -23]

const HUM_Q_OPTIONS = [
  { label: 'sehr fein', value: 20 },
  { label: 'fein',      value: 12 },
  { label: 'mittel',    value: 8  },
  { label: 'grob',      value: 5  },
]

export function ProcessingPanel() {
  const store = useProcessingStore()
  const { abMode } = useAudioStore()
  const { setShowEQPro } = useUIStore()

  const isOriginalMode = abMode === 'original'

  return (
    <div className="px-4 pb-4 space-y-5">

      {isOriginalMode && (
        <p className="text-center text-xs text-text-secondary py-1">
          Original-Modus — Effekte werden nicht angewendet
        </p>
      )}

      {/* Processing controls — dimmed when in original bypass mode */}
      <div className={cn(
        'space-y-5 transition-opacity duration-200',
        isOriginalMode && 'opacity-30 pointer-events-none select-none',
      )}>

        {/* Hum */}
        <ProcessingSlider
          label="Brummen"
          icon={<Radio size={16} />}
          value={store.humAmount}
          onChange={store.setHumAmount}
          enabled={store.humEnabled}
          onToggle={store.setHumEnabled}
          displayValue={store.humAmount === 0 ? '0 dB' : `-${Math.round(store.humAmount * 40)} dB`}
          rightAddon={
            <select
              value={store.humQ}
              onChange={(e) => store.setHumQ(Number(e.target.value))}
              disabled={!store.humEnabled}
              className="text-xs bg-slider-track text-text-primary rounded-pill px-2.5 py-1 border-0 outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {HUM_Q_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          }
        />

        {/* Noise */}
        <ProcessingSlider
          label="Rauschen"
          icon={<Volume2 size={16} />}
          value={store.noiseAmount}
          onChange={store.setNoiseAmount}
          enabled={store.noiseEnabled}
          onToggle={store.setNoiseEnabled}
          displayValue={`${Math.round(store.noiseAmount * 100)}%`}
        />

        {/* EQ */}
        <ProcessingSlider
          label="Klang der Stimme / Equalizer"
          icon={<SlidersHorizontal size={16} />}
          value={store.eqIntensity}
          onChange={store.setEqIntensity}
          enabled={store.eqEnabled}
          onToggle={store.setEqEnabled}
          displayValue={`${Math.round(store.eqIntensity * 100)}%`}
          action={
            <button
              onClick={() => setShowEQPro(true)}
              className="ml-2 px-2 py-0.5 text-xs font-medium text-accent border border-accent/30 rounded-pill hover:bg-accent/10 transition-colors"
            >
              Pro
            </button>
          }
        />

        {/* De-esser */}
        <ProcessingSlider
          label="Zischen / De-Esser"
          icon={<AudioWaveform size={16} />}
          value={store.desibilanceAmount}
          onChange={store.setDesibilanceAmount}
          enabled={store.desibilanceEnabled}
          onToggle={store.setDesibilanceEnabled}
          displayValue={
            store.desibilanceAmount === 0
              ? 'aus'
              : `${Math.round(store.desibilanceAmount * 100)}% · ${Math.round(store.desibilanceFreq / 100) / 10} kHz`
          }
        />

        {/* Compression */}
        <ProcessingSlider
          label="Dynamik / Compressor"
          icon={<Activity size={16} />}
          value={store.compressionAmount}
          onChange={store.setCompressionAmount}
          enabled={store.compressionEnabled}
          onToggle={store.setCompressionEnabled}
          displayValue={`${Math.round(store.compressionAmount * 100)}%`}
        />

        {/* Exciter */}
        <ProcessingSlider
          label="Präsenz / Exciter"
          icon={<Sparkles size={16} />}
          value={store.exciterAmount}
          onChange={store.setExciterAmount}
          enabled={store.exciterEnabled}
          onToggle={store.setExciterEnabled}
          displayValue={`${Math.round(store.exciterAmount * 100)}%`}
        >
          <div className="flex gap-2 pt-1">
            {(['brilliance', 'warmth'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => store.setExciterMode(mode)}
                className={cn(
                  'flex-1 py-1.5 rounded-pill text-xs font-medium transition-colors',
                  store.exciterMode === mode
                    ? 'bg-accent/20 text-accent border border-accent/30'
                    : 'bg-slider-track text-text-secondary hover:text-text-primary',
                )}
              >
                {mode === 'brilliance' ? 'Höhen' : 'Wärme'}
              </button>
            ))}
          </div>
        </ProcessingSlider>

      </div>{/* end processing controls */}

      {/* LUFS Target */}
      <div className="bg-card border border-card-border rounded-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Target size={16} className="text-text-secondary" />
          <span className="font-medium text-text-primary text-sm">Ziel-Lautheit</span>
          <span className="ml-auto text-accent text-sm font-semibold tabular-nums">
            {store.limiterTarget} LUFS
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {LUFS_OPTIONS.map((val) => (
            <button
              key={val}
              onClick={() => store.setLimiterTarget(val)}
              className={cn(
                'py-2 rounded-lg text-xs font-medium transition-colors',
                store.limiterTarget === val
                  ? 'bg-accent text-white'
                  : 'bg-slider-track text-text-secondary hover:text-text-primary',
              )}
            >
              {val} LUFS
            </button>
          ))}
        </div>
        <p className="text-xs text-text-secondary">
          {store.limiterTarget === -14 && 'Standard für Streaming (Spotify, YouTube)'}
          {store.limiterTarget === -16 && 'Empfohlen für Podcasts'}
          {store.limiterTarget === -23 && 'Broadcast-Standard (EBU R128)'}
          {![-14, -16, -23].includes(store.limiterTarget) && 'Benutzerdefiniert'}
        </p>
        <div className="flex items-center gap-2">
          <Repeat size={14} className="text-text-secondary" />
          <span className="text-xs text-text-secondary">Auf alle Dateien anwenden</span>
        </div>
      </div>
    </div>
  )
}
