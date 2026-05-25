import { useState, useCallback, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, RefreshCw, Loader2 } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useUIStore } from '@/store/useUIStore'
import { useFileStore } from '@/store/useFileStore'
import { EQGraph } from './EQGraph'
import { audioEngine } from '@/audio/AudioEngine'
import { analyzeLTAS } from '@/audio/analysis/LTASAnalyzer'
import { computeEQCorrection } from '@/utils/eqMatcher'
import * as RadixSwitch from '@radix-ui/react-switch'
import { cn } from '@/utils/cn'
import type { BiquadFilterType } from '@/types/audio.types'

const FILTER_TYPES: { value: BiquadFilterType; label: string }[] = [
  { value: 'peaking', label: 'Peaking' },
  { value: 'highshelf', label: 'Hi Shelf' },
  { value: 'lowshelf', label: 'Lo Shelf' },
  { value: 'highpass', label: 'Hi Pass' },
  { value: 'lowpass', label: 'Lo Pass' },
  { value: 'notch', label: 'Notch' },
]

export function EQProPanel() {
  const { showEQPro, setShowEQPro, addToast } = useUIStore()
  const {
    eqBands, setEqBand, setEqBands,
    measuredLTAS, referenceLTAS,
    analysisStatus, analysisProgress,
    setMeasuredLTAS, setAnalysisStatus, setAnalysisProgress,
  } = useProcessingStore()
  const activeFile = useFileStore((s) => s.getActiveFile())

  const [selectedId, setSelectedId] = useState<string | null>(eqBands[0]?.id ?? null)
  const [isReanalyzing, setIsReanalyzing] = useState(false)

  const selected = eqBands.find((b) => b.id === selectedId)

  const handleReanalyze = useCallback(async () => {
    if (!activeFile || isReanalyzing) return
    setIsReanalyzing(true)
    setAnalysisStatus('running')
    setAnalysisProgress(0)
    setMeasuredLTAS(null)
    try {
      const source = audioEngine.loadedBuffer ?? activeFile.file
      const ltas = await analyzeLTAS(source, (p) => setAnalysisProgress(p))
      setMeasuredLTAS(ltas)
      const corrected = computeEQCorrection(ltas, referenceLTAS, eqBands)
      setEqBands(corrected)
      setAnalysisStatus('done')
      addToast('Klang-Korrektur neu berechnet ✓', 'success')
    } catch {
      setAnalysisStatus('error')
      addToast('Neu-Analyse fehlgeschlagen', 'error')
    } finally {
      setIsReanalyzing(false)
    }
  }, [activeFile, isReanalyzing, eqBands, referenceLTAS, setMeasuredLTAS, setEqBands, setAnalysisStatus, setAnalysisProgress, addToast])

  const isRunning = analysisStatus === 'running' || isReanalyzing

  return (
    <Dialog.Root open={showEQPro} onOpenChange={setShowEQPro}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 z-50 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-card border border-card-border rounded-2xl max-h-[85vh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto animate-fade-in">
          <div className="sticky top-0 bg-card border-b border-card-border px-4 py-3 flex items-center justify-between">
            <Dialog.Title className="text-text-primary font-semibold">Klang der Stimme / Equalizer</Dialog.Title>
            <div className="flex items-center gap-2">
              {activeFile && (
                <button
                  onClick={handleReanalyze}
                  disabled={isRunning}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                    isRunning
                      ? 'bg-slider-track text-text-secondary cursor-not-allowed'
                      : 'bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20'
                  )}
                >
                  {isRunning
                    ? <Loader2 size={12} className="animate-spin" />
                    : <RefreshCw size={12} />
                  }
                  {isRunning
                    ? `Analysiere… ${Math.round(analysisProgress * 100)}%`
                    : 'Neu berechnen'
                  }
                </button>
              )}
              <Dialog.Close asChild>
                <button className="p-2 text-text-secondary hover:text-text-primary transition-colors" aria-label="Schließen">
                  <X size={20} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="p-4 space-y-4">
            {/* Graph */}
            <div className="bg-background border border-card-border rounded-card overflow-hidden">
              <EQGraph
                bands={eqBands}
                selectedBandId={selectedId}
                onBandSelect={setSelectedId}
                onBandChange={(id, freq, gain) => setEqBand(id, { freq, gain })}
                onBandQChange={(id, q) => setEqBand(id, { q })}
                measuredLTAS={measuredLTAS}
                referenceLTAS={referenceLTAS}
              />

              {/* Freq axis labels */}
              <div className="flex justify-between px-2 pb-2">
                {['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k'].map((f) => (
                  <span key={f} className="text-text-secondary text-[10px]">{f}</span>
                ))}
              </div>
            </div>

            {/* Curve legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
              <LegendItem color="#f59e0b" label="EQ-Kurve (aktiv)" />
              {measuredLTAS && <LegendItem color="#fcd34d" label="Deine Aufnahme" muted />}
              <LegendItem color="#2dd4bf" label="Profi-Referenz" muted />
            </div>

            {/* Analysis status banner */}
            {analysisStatus === 'running' && (
              <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border border-accent/20 rounded-card text-xs text-accent">
                <Loader2 size={12} className="animate-spin shrink-0" />
                Analysiere Aufnahme… {Math.round(analysisProgress * 100)}%
              </div>
            )}
            {analysisStatus === 'error' && (
              <div className="px-3 py-2 bg-error/10 border border-error/20 rounded-card text-xs text-error">
                Analyse fehlgeschlagen – Standard-Kurve wird verwendet.
              </div>
            )}

            {/* Band selection — wraps into two rows on narrow screens */}
            <div className="flex flex-wrap gap-2">
              {eqBands.map((band) => (
                <button
                  key={band.id}
                  onClick={() => setSelectedId(band.id)}
                  className={cn(
                    'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                    selectedId === band.id
                      ? 'bg-accent text-white'
                      : 'bg-slider-track text-text-secondary hover:text-text-primary',
                    !band.enabled && 'opacity-50',
                  )}
                >
                  {band.label}
                </button>
              ))}
            </div>

            {/* Selected band controls — one row */}
            {selected && (
              <div className="bg-background border border-card-border rounded-card p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-text-primary font-medium text-sm">{selected.label}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">
                      {selected.enabled ? 'An' : 'Aus'}
                    </span>
                    <RadixSwitch.Root
                      checked={selected.enabled}
                      onCheckedChange={(v) => setEqBand(selected.id, { enabled: v })}
                      className="w-9 h-5 rounded-pill bg-slider-track data-[state=checked]:bg-accent transition-colors"
                    >
                      <RadixSwitch.Thumb className="block w-4 h-4 rounded-full bg-white translate-x-0.5 data-[state=checked]:translate-x-4 transition-transform" />
                    </RadixSwitch.Root>
                  </div>
                </div>

                <div className="flex gap-1.5">
                  <DragField
                    label="Freq"
                    value={selected.freq}
                    unit="Hz"
                    min={20}
                    max={20000}
                    logScale
                    onChangeValue={(v) => setEqBand(selected.id, { freq: Math.round(v) })}
                    formatValue={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`}
                  />
                  <DragField
                    label="Gain"
                    value={selected.gain}
                    unit="dB"
                    min={-18}
                    max={18}
                    onChangeValue={(v) => setEqBand(selected.id, { gain: parseFloat(v.toFixed(1)) })}
                    formatValue={(v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))}
                    disabled={selected.type === 'highpass' || selected.type === 'lowpass'}
                  />
                  <DragField
                    label="Q"
                    value={selected.q}
                    unit=""
                    min={0.1}
                    max={10}
                    onChangeValue={(v) => setEqBand(selected.id, { q: parseFloat(v.toFixed(2)) })}
                    formatValue={(v) => v.toFixed(2)}
                  />
                  <div className="flex-1 min-w-0 bg-slider-track rounded-lg px-2 py-1.5 flex flex-col gap-0.5">
                    <span className="text-[10px] text-text-secondary leading-none">Typ</span>
                    <select
                      value={selected.type}
                      onChange={(e) => setEqBand(selected.id, { type: e.target.value as BiquadFilterType })}
                      className="bg-transparent text-xs font-semibold text-text-primary focus:outline-none w-full cursor-pointer leading-tight"
                    >
                      {FILTER_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface DragFieldProps {
  label: string
  value: number
  unit: string
  onChangeValue: (v: number) => void
  min: number
  max: number
  logScale?: boolean
  formatValue?: (v: number) => string
  disabled?: boolean
}

function DragField({
  label,
  value,
  unit,
  onChangeValue,
  min,
  max,
  logScale = false,
  formatValue,
  disabled = false,
}: DragFieldProps) {
  const pointerStart = useRef<{ y: number; value: number } | null>(null)
  const fmt = formatValue ?? ((v: number) => String(v))

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    pointerStart.current = { y: e.clientY, value }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!pointerStart.current || disabled) return
    const deltaY = pointerStart.current.y - e.clientY
    let newValue: number
    if (logScale) {
      newValue = pointerStart.current.value * Math.pow(1.005, deltaY)
    } else {
      const sensitivity = (max - min) / 150
      newValue = pointerStart.current.value + deltaY * sensitivity
    }
    onChangeValue(Math.max(min, Math.min(max, newValue)))
  }

  function onPointerUp() {
    pointerStart.current = null
  }

  return (
    <div
      className={cn(
        'flex-1 min-w-0 bg-slider-track rounded-lg px-2 py-1.5 flex flex-col gap-0.5 select-none',
        disabled ? 'opacity-40' : 'cursor-ns-resize active:bg-accent/10',
      )}
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="text-[10px] text-text-secondary leading-none">{label}</span>
      <span className="text-xs font-semibold text-text-primary leading-tight whitespace-nowrap overflow-hidden text-ellipsis">
        {fmt(value)}
        {unit && <span className="font-normal text-text-secondary ml-0.5">{unit}</span>}
      </span>
    </div>
  )
}

function LegendItem({
  color,
  label,
  muted = false,
}: {
  color: string
  label: string
  muted?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block w-6 h-0.5 rounded-full"
        style={{ backgroundColor: color, opacity: muted ? 0.6 : 1 }}
      />
      <span className="text-xs text-text-secondary">{label}</span>
    </div>
  )
}
