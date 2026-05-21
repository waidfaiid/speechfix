import { Radio, Volume2, SlidersHorizontal, Sparkles, Target, AudioWaveform, Mic, Music, Loader2, AlertCircle, Wand2, RotateCcw } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useAudioStore } from '@/store/useAudioStore'
import { useUIStore } from '@/store/useUIStore'
import { audioEngine } from '@/audio/AudioEngine'
import { analyzeNoiseProfile } from '@/audio/analysis/HumAnalyzer'
import { ProcessingSlider } from './ProcessingSlider'
import { DynamicsCompressorSection } from './DynamicsCompressorSection'
import { LimiterStatus } from './LimiterStatus'
import { cn } from '@/utils/cn'

const LUFS_OPTIONS = [-14, -16] as const

// ---------------------------------------------------------------------------
// HumSection – Brummen with one-button auto-profile workflow
// ---------------------------------------------------------------------------

/** Width of the noise-profile window placed at the playhead on first click. */
const PROFILE_WINDOW_SEC = 5

function HumSection() {
  const store = useProcessingStore()
  const currentTime = useAudioStore((s) => s.currentTime)
  const duration    = useAudioStore((s) => s.duration)

  const hasRegion  = store.humNoiseProfileStart !== null && store.humNoiseProfileEnd !== null
  const profileDone = store.humAutoMode && store.humAnalysisState === 'done'
  const selecting   = store.humAutoMode && store.humAnalysisState !== 'done'

  async function runAnalysis() {
    const buffer = audioEngine.loadedBuffer
    if (!buffer || !hasRegion) return
    store.setHumAnalysisState('analyzing')
    try {
      const result = await analyzeNoiseProfile(
        buffer,
        store.humNoiseProfileStart!,
        store.humNoiseProfileEnd!,
      )
      store.setHumDetectedFreqs(result.peaks)
      store.setHumNoiseProfile(result.noiseProfile)
      store.setHumAnalysisState('done')
      if (!store.humEnabled) store.setHumEnabled(true)
    } catch (err) {
      console.error('[HumAnalyzer]', err)
      store.setHumAnalysisState('error')
    }
  }

  function handleProfileButton() {
    if (store.humAnalysisState === 'analyzing') return

    if (!store.humAutoMode) {
      // Step 1 – "Brummprofil": place 5-sec window at current playhead
      const start = Math.max(0, currentTime)
      const end   = Math.min(duration > 0 ? duration : start + PROFILE_WINDOW_SEC, start + PROFILE_WINDOW_SEC)
      store.setHumNoiseProfileStart(start)
      store.setHumNoiseProfileEnd(end)
      store.setHumAutoMode(true)
      store.setHumAnalysisState('idle')
      return
    }

    if (store.humAnalysisState === 'done') {
      // "Profil erneuern": full reset so user can pick a new region
      store.setHumAutoMode(false)
      store.setHumAnalysisState('idle')
      store.setHumDetectedFreqs([])
      store.setHumNoiseProfile(null)
      store.setHumNoiseProfileStart(null)
      store.setHumNoiseProfileEnd(null)
      return
    }

    // Step 2 – "Brummprofil analysieren": run FFT analysis
    if (hasRegion) runAnalysis()
  }

  // Button label & style
  let btnLabel: React.ReactNode
  let btnDisabled = false
  let btnStyle = 'bg-slider-track text-text-secondary border-card-border hover:text-text-primary'

  if (store.humAnalysisState === 'analyzing') {
    btnLabel    = <><Loader2 size={9} className="animate-spin shrink-0" /><span>Analysiere…</span></>
    btnDisabled = true
    btnStyle    = 'bg-slider-track text-text-secondary border-card-border opacity-60'
  } else if (profileDone) {
    btnLabel = <><RotateCcw size={9} className="shrink-0" /><span>Profil erneuern</span></>
    btnStyle = 'bg-green-500/10 text-green-400 border-green-500/30 hover:bg-green-500/20'
  } else if (selecting && hasRegion) {
    btnLabel = <><Wand2 size={9} className="shrink-0" /><span>Analysieren</span></>
    btnStyle = 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
  } else {
    // idle or selecting-without-region: always show "Brummprofil"
    btnLabel = <><Wand2 size={9} className="shrink-0" /><span>Brummprofil</span></>
  }

  const profileButton = (
    <button
      type="button"
      onClick={handleProfileButton}
      disabled={btnDisabled || duration <= 0}
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-pill text-[10px] font-medium transition-colors whitespace-nowrap border',
        btnStyle,
        (btnDisabled || duration <= 0) && 'opacity-50 cursor-not-allowed',
      )}
    >
      {btnLabel}
    </button>
  )


  return (
    <ProcessingSlider
      label="Brummen"
      icon={<Radio size={16} />}
      value={store.humAmount}
      onChange={store.setHumAmount}
      enabled={store.humEnabled}
      onToggle={store.setHumEnabled}
      displayValue={store.humAmount === 0 ? '0 dB' : `-${Math.round(store.humAmount * 70)} dB`}
      action={profileButton}
    >
      {/* Region hint (only while selecting, before analysis) */}
      {selecting && (
        <p className="text-[10px] text-text-secondary">
          {hasRegion
            ? `Region: ${store.humNoiseProfileStart!.toFixed(1)} – ${store.humNoiseProfileEnd!.toFixed(1)} s · Handles im Waveform verschieben, dann analysieren`
            : 'Grüne Region im Waveform verschieben, dann "Brummprofil analysieren" drücken'}
        </p>
      )}

      {/* Error messages only */}
      {store.humAnalysisState === 'error' && (
        <p className="text-[10px] text-red-400 flex items-center gap-1">
          <AlertCircle size={10} />
          Analyse fehlgeschlagen – Region mindestens 0,5 Sek. lang?
        </p>
      )}
      {store.humAnalysisState === 'done' && store.humDetectedFreqs.length === 0 && (
        <p className="text-[10px] text-amber-400 flex items-center gap-1">
          <AlertCircle size={10} />
          Kein Brummen erkannt – enthält die Region wirklich nur Brummen/Stille?
        </p>
      )}
    </ProcessingSlider>
  )
}

export function ProcessingPanel() {
  const store = useProcessingStore()
  const { abMode, setAbMode, isPlaying } = useAudioStore()
  const { setShowEQPro } = useUIStore()

  const isOriginalMode = abMode === 'original'

  return (
    <div className="px-4 pb-4 space-y-5">

      {/* Content Type + A/B Compare — always active */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            {([
              { value: 'speech', label: 'Redner', icon: <Mic size={13} /> },
              { value: 'mixed',  label: 'Live', icon: <Music size={13} /> },
            ] as const).map(({ value, label, icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => store.setContentType(value)}
                className={cn(
                  'flex items-center justify-center gap-1 py-2 px-3 rounded-pill text-xs font-medium transition-colors whitespace-nowrap',
                  store.contentType === value
                    ? 'bg-accent/20 text-accent border border-accent/30'
                    : 'bg-slider-track text-text-secondary hover:text-text-primary border border-transparent',
                )}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          <div className="flex gap-1 ml-auto shrink-0">
            {(['original', 'processed'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => { setAbMode(mode); audioEngine.setABMode(mode) }}
                className={cn(
                  'px-2.5 py-1.5 rounded-pill text-xs font-medium transition-colors whitespace-nowrap',
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
        <p className="text-[10px] text-text-secondary">
          {store.contentType === 'mixed'
            ? 'Sanftere Kompression – Musik- und Gesangspassagen werden geschont.'
            : 'Optimiert für reine Sprach- und Predigtaufnahmen.'}
        </p>
      </div>

      {isOriginalMode && (
        <p className="text-center text-xs text-text-secondary py-1">
          Original-Modus — Effekte werden nicht angewendet
        </p>
      )}

      <div className={cn(
        'space-y-5 transition-opacity duration-200',
        isOriginalMode && 'opacity-30 pointer-events-none select-none',
      )}>

        {/* Hum */}
        <HumSection />

        {/* Noise */}
        <ProcessingSlider
          label="Rauschen"
          icon={<Volume2 size={16} />}
          value={store.noiseAmount}
          onChange={store.setNoiseAmount}
          enabled={store.noiseEnabled}
          onToggle={store.setNoiseEnabled}
          displayValue={`${Math.round(store.noiseAmount * 100)}%`}
          rightAddon={store.noiseEnabled ? (
            <div
              className="flex items-center gap-1"
              title="Latenz ausgleichen"
            >
              <span className="text-[9px] text-text-secondary whitespace-nowrap mr-0.5">Latenz</span>
              <button
                type="button"
                onClick={() => store.setDtlnLatencyMs(store.dtlnLatencyMs - 0.1)}
                className="w-5 h-5 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-slider-track transition-colors text-xs font-bold leading-none"
              >
                −
              </button>
              <span className="text-[11px] tabular-nums text-text-primary w-12 text-center">
                {(store.dtlnLatencyMs - 48).toFixed(1)} ms
              </span>
              <button
                type="button"
                onClick={() => store.setDtlnLatencyMs(store.dtlnLatencyMs + 0.1)}
                className="w-5 h-5 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-slider-track transition-colors text-xs font-bold leading-none"
              >
                +
              </button>
            </div>
          ) : undefined}
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
              type="button"
              onClick={() => setShowEQPro(true)}
              className="ml-2 px-2 py-0.5 text-xs font-medium text-accent border border-accent/30 rounded-pill hover:bg-accent/10 transition-colors"
            >
              Pro
            </button>
          }
        />

        {/* Compressor + Dynamics visualisation */}
        <DynamicsCompressorSection />

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
                type="button"
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

        {/* Ziel-Lautheit + Limiter-Status — below Exciter, above Export */}
        <div className="bg-card border border-card-border rounded-card p-4 space-y-4">
          <LimiterStatus
            interventionDb={store.limiterInterventionDb}
            isPlaying={isPlaying}
          />

          <div className="border-t border-card-border pt-4 space-y-3">
            <div className="flex items-center gap-2">
              <Target size={16} className="text-text-secondary" />
              <span className="font-medium text-text-primary text-sm">Ziel-Lautheit</span>
              <span className="ml-auto text-accent text-sm font-semibold tabular-nums">
                {store.limiterTarget} LUFS
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {LUFS_OPTIONS.map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => store.setLimiterTarget(val)}
                  className={cn(
                    'py-2.5 rounded-lg text-sm font-medium transition-colors',
                    store.limiterTarget === val
                      ? 'bg-accent text-white'
                      : 'bg-slider-track text-text-secondary hover:text-text-primary',
                  )}
                >
                  {val} LUFS
                </button>
              ))}
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              {store.limiterTarget === -14 && 'Streaming (Spotify, YouTube) — etwas lauter.'}
              {store.limiterTarget === -16 && 'Standard für Podcasts & Predigten — empfohlen.'}
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}
