import { Radio, Volume2, SlidersHorizontal, Sparkles, AudioWaveform, Mic, Music, Loader2, AlertCircle, Wand2, RotateCcw, Waves, Flame, Zap } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useAudioStore } from '@/store/useAudioStore'
import { useUIStore } from '@/store/useUIStore'
import { audioEngine } from '@/audio/AudioEngine'
import { analyzeNoiseProfile } from '@/audio/analysis/HumAnalyzer'
import { ProcessingSlider } from './ProcessingSlider'
import { DynamicsCompressorSection } from './DynamicsCompressorSection'
import { cn } from '@/utils/cn'

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
  let btnStyle = 'text-text-secondary'

  if (store.humAnalysisState === 'analyzing') {
    btnLabel    = <><Loader2 size={9} className="animate-spin shrink-0" /><span>Analysiere…</span></>
    btnDisabled = true
    btnStyle    = 'text-text-secondary opacity-60'
  } else if (profileDone) {
    btnLabel = <span>Brummprofil aktiv</span>
    btnStyle = 'text-accent'
  } else if (selecting && hasRegion) {
    btnLabel = <><Wand2 size={9} className="shrink-0" /><span>Analysieren</span></>
    btnStyle = 'text-green-400'
  } else {
    // idle or selecting-without-region: always show "Brummprofil"
    btnLabel = <><Wand2 size={9} className="shrink-0" /><span>Brummprofil</span></>
    btnStyle = 'bg-card-elevated border border-accent/30 text-accent rounded-full px-3 py-1 hover:bg-accent/20'
  }

  const profileButton = (
    <button
      type="button"
      onClick={handleProfileButton}
      disabled={btnDisabled || duration <= 0}
      className={cn(
        'text-[9px] uppercase tracking-wide font-medium transition-colors flex items-center gap-1',
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
    <div className="px-3 pb-4 space-y-4">
      {/* PROFIL & A/B */}
      <div className="flex gap-2 mb-6">
        <div className="flex bg-background border border-card-border rounded-lg p-1 flex-1 min-w-0 relative">
          <div 
            className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-card-elevated rounded-md shadow-sm border border-card-border transition-all duration-300"
            style={{ left: store.contentType === 'speech' ? '4px' : 'calc(50%)' }}
          ></div>
          <button 
            type="button"
            onClick={() => store.setContentType('speech')}
            className={cn("flex-1 py-2 text-xs font-medium rounded-md flex justify-center items-center gap-1 relative z-10 transition-colors", store.contentType === 'speech' ? "text-white" : "text-text-secondary hover:text-white")}
          >
            <Mic size={12} className={store.contentType === 'speech' ? "text-accent" : ""} /> Redner
          </button>
          <button 
            type="button"
            onClick={() => store.setContentType('mixed')}
            className={cn("flex-1 py-2 text-xs font-medium rounded-md flex justify-center items-center gap-1 relative z-10 transition-colors", store.contentType === 'mixed' ? "text-white" : "text-text-secondary hover:text-white")}
          >
            <Music size={12} className={store.contentType === 'mixed' ? "text-accent" : ""} /> Live
          </button>
        </div>
        
        <div className="flex bg-background border border-card-border rounded-lg p-1 flex-1 min-w-0 relative">
          <div 
            className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-accent/20 rounded-md shadow-sm border border-accent/50 transition-all duration-300"
            style={{ left: abMode === 'original' ? '4px' : 'calc(50%)' }}
          ></div>
          <button 
            type="button"
            onClick={() => { setAbMode('original'); audioEngine.setABMode('original') }}
            className={cn("flex-1 py-2 text-xs font-medium rounded-md relative z-10 transition-colors", abMode === 'original' ? "text-accent" : "text-text-secondary hover:text-white")}
          >
            Original
          </button>
          <button 
            type="button"
            onClick={() => { setAbMode('processed'); audioEngine.setABMode('processed') }}
            className={cn("flex-1 py-2 text-xs font-medium rounded-md relative z-10 transition-colors", abMode === 'processed' ? "text-accent" : "text-text-secondary hover:text-white")}
          >
            Bearbeitet
          </button>
        </div>
      </div>

      <div className={cn(
        'transition-opacity duration-200',
        isOriginalMode && 'opacity-50 pointer-events-none select-none',
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
        />

        {/* EQ */}
        <ProcessingSlider
          label="Klang (EQ)"
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
              className="ml-2 px-1.5 py-0.5 text-[9px] font-bold text-accent bg-accent/20 border border-transparent rounded uppercase hover:bg-accent/30 transition-colors"
            >
              Pro
            </button>
          }
        />

        {/* Compressor + Dynamics */}
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
              ? 'Aus'
              : `${Math.round(store.desibilanceAmount * 100)}%`
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
          <div className="flex gap-2 mb-2 bg-background p-1 rounded-lg border border-card-border mt-2">
            {([
              { id: 'auto', label: 'Natürlich' },
              { id: 'tube', label: 'Wärme' },
              { id: 'tape', label: 'Präsenz' },
            ] as const).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => store.setExciterMode(id)}
                className={cn(
                  'flex-1 py-1.5 text-[10px] font-medium rounded-md transition-colors',
                  store.exciterMode === id
                    ? 'bg-card-elevated text-white shadow-sm border border-card-border'
                    : 'text-text-secondary hover:text-white border border-transparent'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </ProcessingSlider>
      </div>
    </div>
  )
}
