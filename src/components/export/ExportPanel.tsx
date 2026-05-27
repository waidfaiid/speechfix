import { useState, useRef, useEffect } from 'react'
import { Download, Shield, DownloadCloud, Target, ChevronDown, Pencil } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useFileStore } from '@/store/useFileStore'
import { useAudioStore } from '@/store/useAudioStore'
import { useUIStore } from '@/store/useUIStore'
import { estimateExportSize, formatFileSize } from '@/utils/audioMath'
import { exportFile } from '@/audio/ffmpeg/Transcoder'
import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import { LimiterStatus } from '@/components/processing/LimiterStatus'
import JSZip from 'jszip'
import type { ExportFormat, ExportQuality, SampleRate } from '@/types/processing.types'
import type { BatchFile } from '@/types/file.types'
import { cn } from '@/utils/cn'

const FORMATS: ExportFormat[] = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg']

/**
 * Scroll the focused input into view after the mobile keyboard has finished
 * sliding up (~300–350 ms). Without this delay the scroll fires before the
 * keyboard has claimed its space, so the element ends up hidden underneath it.
 * Also acts as the canonical spot to add any other mobile-focus side-effects.
 */
function scrollInputIntoView(e: React.FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget
  setTimeout(() => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, 350)
}
const LUFS_OPTIONS = [-14, -16] as const

const QUALITIES: { value: ExportQuality; label: string }[] = [
  { value: 'low',      label: 'Niedrig (64 kbps)' },
  { value: 'medium',   label: 'Normal (128 kbps)' },
  { value: 'high',     label: 'Hoch (320 kbps)' },
  { value: 'lossless', label: 'Verlustfrei' },
]

const QUALITY_ORDER: ExportQuality[] = ['low', 'medium', 'high', 'lossless']
const SAMPLE_RATES: SampleRate[] = [44100, 48000]
const LOSSLESS_FORMATS = new Set(['wav', 'flac', 'aiff'])

function getStepLabel(p: number): string {
  if (p < 5) return 'Audio vorbereiten…'
  if (p < 20) return 'Lautheit messen…'
  if (p < 35) return 'Dynamik analysieren…'
  if (p < 90) return 'Filter & Limiter anwenden…'
  return 'Wird abgeschlossen…'
}

function getQualityCeiling(file: BatchFile): ExportQuality {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (LOSSLESS_FORMATS.has(ext)) return 'lossless'
  if (file.duration <= 0) return 'high'
  const bitrateKbps = (file.file.size * 8) / file.duration / 1000
  if (bitrateKbps < 96)  return 'low'
  if (bitrateKbps < 160) return 'medium'
  return 'high'
}

function isQualityDisabled(quality: ExportQuality, ceiling: ExportQuality): boolean {
  return QUALITY_ORDER.indexOf(quality) > QUALITY_ORDER.indexOf(ceiling)
}

function LimiterSection({
  limiterEnabled,
  setLimiterEnabled,
  limiterTarget,
  setLimiterTarget,
  limiterInterventionDb,
  isPlaying,
}: {
  limiterEnabled: boolean
  setLimiterEnabled: (v: boolean) => void
  limiterTarget: number
  setLimiterTarget: (v: number) => void
  limiterInterventionDb: number
  isPlaying: boolean
}) {
  const [showCustom, setShowCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const isPreset = LUFS_OPTIONS.includes(limiterTarget as typeof LUFS_OPTIONS[number])

  useEffect(() => {
    if (showCustom && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [showCustom])

  function applyCustomValue() {
    const parsed = parseFloat(customValue)
    if (isNaN(parsed)) return
    const negative = parsed > 0 ? -parsed : parsed
    const clamped = Math.max(-60, Math.min(0, Math.round(negative)))
    setLimiterTarget(clamped)
    setShowCustom(false)
  }

  function openCustomInput() {
    setCustomValue(String(isPreset ? '' : limiterTarget))
    setShowCustom(true)
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-background rounded-md border border-card-border"><Shield size={16} className="text-text-secondary" /></div>
          <span className="font-bold text-sm text-white">Limiter & Ziel-Lautheit</span>
        </div>
        <button
          type="button"
          onClick={() => setLimiterEnabled(!limiterEnabled)}
          className={cn(
            'relative w-8 h-[18px] rounded-full transition-colors duration-200',
            limiterEnabled ? 'bg-accent' : 'bg-card-border'
          )}
        >
          <span className={cn(
            'absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform duration-200',
            limiterEnabled && 'translate-x-[14px]'
          )} />
        </button>
      </div>

      {limiterEnabled && (
        <div className="mb-4">
          <LimiterStatus interventionDb={limiterInterventionDb} isPlaying={isPlaying} />
        </div>
      )}

      {!limiterEnabled && (
        <div className="text-[10px] text-amber-400/80 bg-amber-400/10 border border-amber-500/20 rounded-md px-3 py-2 mb-4">
          Limiter deaktiviert — Pegelspitzen werden nicht begrenzt. Kann zu Clipping führen.
        </div>
      )}

      {/* LUFS Auswahl Grid */}
      <div className="grid grid-cols-3 gap-2 mb-2">
        {LUFS_OPTIONS.map((val) => (
          <button
            key={val}
            type="button"
            onClick={() => { setLimiterTarget(val); setShowCustom(false) }}
            className={cn(
              'py-3 rounded-lg font-tech text-xs transition shadow-sm border',
              limiterTarget === val
                ? 'bg-accent/10 border-accent text-accent font-bold'
                : 'bg-background border-card-border text-stone-300 hover:text-white'
            )}
          >
            {val} LUFS
          </button>
        ))}
        {showCustom ? (
          <div className="flex rounded-lg overflow-hidden border border-accent shadow-sm">
            <input
              ref={inputRef}
              type="number"
              min={-60}
              max={0}
              step={1}
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCustomValue()
                if (e.key === 'Escape') setShowCustom(false)
              }}
              onBlur={() => {
                if (customValue) applyCustomValue()
                else setShowCustom(false)
              }}
              placeholder="-23"
              onFocus={scrollInputIntoView}
              className="w-full bg-background text-white font-tech text-base text-center py-3 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={openCustomInput}
            className={cn(
              'py-3 rounded-lg font-tech text-xs transition shadow-sm border flex items-center justify-center gap-1.5',
              !isPreset
                ? 'bg-accent/10 border-accent text-accent font-bold'
                : 'bg-background border-card-border text-stone-300 hover:text-white'
            )}
          >
            {!isPreset ? (
              <>{limiterTarget} LUFS</>
            ) : (
              <><Pencil size={10} />cutomized</>
            )}
          </button>
        )}
      </div>
      <div className="text-[10px] text-text-secondary text-center mt-2">
        {limiterTarget === -14 && 'Streaming (Spotify, YouTube) — etwas lauter.'}
        {limiterTarget === -16 && 'Standard für Sprache & Podcasts (-16 empfohlen).'}
        {!LUFS_OPTIONS.includes(limiterTarget as typeof LUFS_OPTIONS[number]) && `Individueller Zielwert: ${limiterTarget} LUFS.`}
      </div>
    </div>
  )
}

export function ExportPanel() {
  const { exportOptions, setExportOptions, getParams, humNoiseProfile, limiterEnabled, setLimiterEnabled, limiterTarget, setLimiterTarget, limiterInterventionDb } = useProcessingStore()
  const { files, updateFile, setExportProgress, setIsExporting } = useFileStore()
  const { ffmpegLoaded, trimStart, trimEnd, isPlaying } = useAudioStore()
  const { addToast } = useUIStore()

  const activeFile = useFileStore((s) => s.getActiveFile())
  const estimatedSize = activeFile
    ? estimateExportSize(activeFile.duration, exportOptions.format, exportOptions.quality)
    : 0

  const qualityCeiling: ExportQuality = activeFile ? getQualityCeiling(activeFile) : 'lossless'

  async function startExport() {
    if (!ffmpegManager.isLoaded) {
      addToast('FFmpeg wird noch geladen. Bitte warten.', 'warning')
      return
    }

    const filesToExport = files.filter((f) => f.file && f.status !== 'processing')
    if (filesToExport.length === 0) { addToast('Keine Dateien zum Exportieren.', 'info'); return }

    setIsExporting(true)
    const params = getParams()
    const noiseProfile = params.humAutoMode && params.humDetectedFreqs.length > 0 ? humNoiseProfile : null
    const zip = filesToExport.length > 1 ? new JSZip() : null
    const blobs: { name: string; blob: Blob }[] = []
    const isSingle = filesToExport.length === 1

    for (let i = 0; i < filesToExport.length; i++) {
      const f = filesToExport[i]
      updateFile(f.id, { status: 'processing' })
      setExportProgress({
        fileId: f.id,
        fileName: f.name,
        fileIndex: i + 1,
        totalFiles: filesToExport.length,
        stepProgress: 0,
        stepLabel: 'Wird verarbeitet…',
        estimatedSecondsLeft: 0,
      })

      try {
        const exportStartedAt = Date.now()
        const blob = await exportFile(f.file, params, {
          ...exportOptions,
          normalizeToLUFS: params.limiterTarget,
          trimStart: trimStart > 0 ? trimStart : undefined,
          trimEnd: trimEnd !== null ? trimEnd : undefined,
        }, (p) => {
          const elapsed = (Date.now() - exportStartedAt) / 1000
          const estimatedTotal = p > 3 ? elapsed / (p / 100) : 0
          const estimatedLeft = Math.max(0, Math.round(estimatedTotal - elapsed))
          setExportProgress({
            fileId: f.id,
            fileName: f.name,
            fileIndex: i + 1,
            totalFiles: filesToExport.length,
            stepProgress: p,
            stepLabel: getStepLabel(p),
            estimatedSecondsLeft: estimatedLeft,
            startedAt: exportStartedAt,
          })
        }, noiseProfile)

        const originalBase = f.name.replace(/\.[^.]+$/, '')
        const base = isSingle
          ? (exportOptions.filename.trim() || originalBase)
          : originalBase
        const suffix = exportOptions.filenameSuffix !== '' ? exportOptions.filenameSuffix : '_fixed'
        const outName = `${base}${suffix}.${exportOptions.format}`

        updateFile(f.id, { status: 'done', outputBlob: blob })
        blobs.push({ name: outName, blob })
        if (zip) zip.file(outName, blob)
      } catch (err) {
        updateFile(f.id, { status: 'error', error: String(err) })
        addToast(`Fehler bei ${f.name}`, 'error')
      }
    }

    setExportProgress(null)
    setIsExporting(false)

    if (zip && blobs.length > 1) {
      const content = await zip.generateAsync({ type: 'blob' })
      downloadBlob(content, 'SermonFix_Export.zip')
      addToast(`${blobs.length} Dateien exportiert!`, 'success')
    } else if (blobs.length === 1) {
      downloadBlob(blobs[0].blob, blobs[0].name)
      addToast('Export abgeschlossen!', 'success')
    }
  }

  return (
    <div className="px-3 pb-6 space-y-4">
      <div className="mod-card border-t-2 border-t-accent/30 !pb-2 !pt-6">
        <div className="card-inner">
          
          {/* Limiter */}
          <LimiterSection
            limiterEnabled={limiterEnabled}
            setLimiterEnabled={setLimiterEnabled}
            limiterTarget={limiterTarget}
            setLimiterTarget={setLimiterTarget}
            limiterInterventionDb={limiterInterventionDb}
            isPlaying={isPlaying}
          />

        </div>
      </div>
      
      <div className="mod-card !pb-8 !pt-2 border-none">
        <div className="card-inner !bg-transparent !p-0">

          {/* Export */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 bg-background rounded-md border border-card-border"><DownloadCloud size={16} className="text-text-secondary" /></div>
              <span className="font-bold text-sm text-white">Export-Einstellungen</span>
            </div>
            
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div>
                <label className="text-[9px] text-text-secondary uppercase tracking-wider mb-1.5 block font-medium">Format</label>
                <div className="relative">
                  <select 
                    value={exportOptions.format}
                    onChange={(e) => setExportOptions({ format: e.target.value as ExportFormat })}
                    className="w-full appearance-none bg-background border border-card-border text-white font-medium text-xs py-3 pl-3 pr-8 rounded-lg outline-none focus:border-accent shadow-sm cursor-pointer transition"
                  >
                    {FORMATS.map(f => (
                      <option key={f} value={f}>{f.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-text-secondary uppercase tracking-wider mb-1.5 block font-medium">Qualität</label>
                <div className="relative">
                  <select 
                    value={exportOptions.quality}
                    onChange={(e) => setExportOptions({ quality: e.target.value as ExportQuality })}
                    className="w-full appearance-none bg-background border border-card-border text-white font-medium text-xs py-3 pl-3 pr-8 rounded-lg outline-none focus:border-accent shadow-sm cursor-pointer transition"
                  >
                    {QUALITIES.map(q => (
                      <option key={q.value} value={q.value} disabled={isQualityDisabled(q.value, qualityCeiling)}>
                        {q.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            
            <label className="text-[9px] text-text-secondary uppercase tracking-wider mb-1.5 block font-medium">Dateiname</label>
            <div className="flex mb-5 shadow-sm min-w-0">
              <input 
                type="text" 
                value={exportOptions.filename}
                onChange={(e) => setExportOptions({ filename: e.target.value })}
                onFocus={scrollInputIntoView}
                placeholder={activeFile ? activeFile.name.replace(/\.[^.]+$/, '') : 'dateiname'}
                className="bg-background border border-card-border p-3 text-base min-w-0 flex-1 rounded-l-lg focus:outline-none focus:border-accent text-white font-medium"
              />
              <div className="flex items-center shrink-0">
                <input 
                  type="text" 
                  value={exportOptions.filenameSuffix}
                  onChange={(e) => setExportOptions({ filenameSuffix: e.target.value })}
                  onFocus={scrollInputIntoView}
                  placeholder="_fixed"
                  className="w-20 bg-background border border-l-0 border-card-border text-white font-tech text-base focus:outline-none focus:border-accent px-2 py-3"
                />
                <span className="bg-card-elevated text-text-secondary font-tech text-sm px-2.5 border border-l-0 border-card-border rounded-r-lg flex items-center self-stretch">.{exportOptions.format}</span>
              </div>
            </div>

            <div className="flex justify-between items-center text-[10px] text-text-secondary mb-3 px-1">
              <span>{(exportOptions.sampleRate / 1000).toFixed(1)} kHz • Stereo</span>
              {estimatedSize > 0 && (
                <span>Geschätzte Größe: <span className="text-white font-tech bg-background px-1.5 py-0.5 rounded border border-card-border">{formatFileSize(estimatedSize)}</span></span>
              )}
            </div>

            <button 
              onClick={startExport}
              disabled={!ffmpegLoaded}
              className="w-full bg-accent hover:bg-accent-hover text-background font-bold py-4 rounded-xl shadow-[0_4px_14px_rgba(245,158,11,0.3)] flex justify-center items-center gap-2 transition-transform active:scale-95 text-base mt-2 disabled:opacity-50 disabled:pointer-events-none"
            >
              <Download size={20} /> 
              {files.length > 1 ? `${files.length} Dateien Exportieren` : 'Audio Exportieren'}
            </button>
            {!ffmpegLoaded && (
              <p className="text-center text-xs text-text-secondary mt-2 animate-pulse-soft">
                Audio-Verarbeitung wird vorbereitet…
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
