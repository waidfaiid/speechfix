import { useEffect, useRef } from 'react'
import { Radio, Volume2, SlidersHorizontal, Activity, Sparkles, Target, Repeat } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useAudioStore } from '@/store/useAudioStore'
import { useUIStore } from '@/store/useUIStore'
import { audioEngine } from '@/audio/AudioEngine'
import { ProcessingSlider } from './ProcessingSlider'
import { Button } from '@/components/ui/Button'
import { cn } from '@/utils/cn'

const LUFS_OPTIONS = [-10, -12, -14, -16, -18, -23]

export function ProcessingPanel() {
  const store = useProcessingStore()
  const { abMode, setAbMode } = useAudioStore()
  const { setShowEQPro } = useUIStore()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const params = store.getParams()

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      audioEngine.updateParams(params)
    }, 16)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [params])

  const isOriginalMode = abMode === 'original'

  return (
    <div className="px-4 pb-4 space-y-5">

      {/* A/B Compare */}
      <div className="bg-card border border-card-border rounded-card p-3 flex items-center justify-between">
        <span className="text-text-secondary text-sm">Vergleich</span>
        <div className="flex gap-2">
          {(['original', 'processed'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => { setAbMode(mode); audioEngine.setABMode(mode) }}
              className={cn(
                'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                abMode === mode
                  ? 'bg-accent text-white'
                  : 'bg-slider-track text-text-secondary hover:text-text-primary',
              )}
            >
              {mode === 'original' ? 'Original' : 'Bearbeitet'}
            </button>
          ))}
        </div>
      </div>

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
          displayValue={`${Math.round(store.humAmount * 100)}%`}
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
          label="Klang"
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

        {/* Compression */}
        <ProcessingSlider
          label="Dynamik"
          icon={<Activity size={16} />}
          value={store.compressionAmount}
          onChange={store.setCompressionAmount}
          enabled={store.compressionEnabled}
          onToggle={store.setCompressionEnabled}
          displayValue={`${Math.round(store.compressionAmount * 100)}%`}
        />

        {/* Exciter */}
        <ProcessingSlider
          label="Präsenz"
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
