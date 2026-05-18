import { Download } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useFileStore } from '@/store/useFileStore'
import { useAudioStore } from '@/store/useAudioStore'
import { useUIStore } from '@/store/useUIStore'
import { estimateExportSize, formatFileSize } from '@/utils/audioMath'
import { Button } from '@/components/ui/Button'
import { exportFile } from '@/audio/ffmpeg/Transcoder'
import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import JSZip from 'jszip'
import type { ExportFormat, ExportQuality, SampleRate } from '@/types/processing.types'
import type { BatchFile } from '@/types/file.types'
import { cn } from '@/utils/cn'

const FORMATS: ExportFormat[] = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg']

const QUALITIES: { value: ExportQuality; label: string }[] = [
  { value: 'low',      label: 'Niedrig' },
  { value: 'medium',   label: 'Mittel' },
  { value: 'high',     label: 'Hoch' },
  { value: 'lossless', label: 'Verlustfrei' },
]

const QUALITY_ORDER: ExportQuality[] = ['low', 'medium', 'high', 'lossless']

const SAMPLE_RATES: SampleRate[] = [44100, 48000]

const LOSSLESS_FORMATS = new Set(['wav', 'flac', 'aiff'])

/**
 * Estimate the quality ceiling of a file based on extension and bitrate.
 * Lossy formats above their natural bitrate range can't be meaningfully
 * up-exported — higher quality settings would just bloat the file size.
 */
function getQualityCeiling(file: BatchFile): ExportQuality {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (LOSSLESS_FORMATS.has(ext)) return 'lossless'
  if (file.duration <= 0) return 'high' // unknown duration → allow up to high

  const bitrateKbps = (file.file.size * 8) / file.duration / 1000

  if (bitrateKbps < 96)  return 'low'
  if (bitrateKbps < 160) return 'medium'
  if (bitrateKbps < 260) return 'high'
  return 'high' // even high-bitrate lossy stays capped at 'high'; lossless needs lossless source
}

function isQualityDisabled(quality: ExportQuality, ceiling: ExportQuality): boolean {
  return QUALITY_ORDER.indexOf(quality) > QUALITY_ORDER.indexOf(ceiling)
}

export function ExportPanel() {
  const { exportOptions, setExportOptions, getParams } = useProcessingStore()
  const { files, updateFile, setExportProgress, setIsExporting } = useFileStore()
  const { ffmpegLoaded } = useAudioStore()
  const { addToast } = useUIStore()

  const activeFile = useFileStore((s) => s.getActiveFile())
  const estimatedSize = activeFile
    ? estimateExportSize(activeFile.duration, exportOptions.format, exportOptions.quality)
    : 0

  const qualityCeiling: ExportQuality = activeFile ? getQualityCeiling(activeFile) : 'lossless'

  // Available sample rates: only show rates ≤ original (when known)
  const originalSr = activeFile?.originalSampleRate
  const availableSampleRates = SAMPLE_RATES.filter(
    (sr) => !originalSr || sr <= originalSr + 1000 // +1000 tolerance for rounding
  )
  // If no rate passes the filter, show all
  const shownSampleRates = availableSampleRates.length > 0 ? availableSampleRates : SAMPLE_RATES

  async function startExport() {
    if (!ffmpegManager.isLoaded) {
      addToast('FFmpeg wird noch geladen. Bitte warten.', 'warning')
      return
    }

    const filesToExport = files.filter((f) => f.status !== 'done' && f.file)
    if (filesToExport.length === 0) { addToast('Keine Dateien zum Exportieren.', 'info'); return }

    setIsExporting(true)
    const params = getParams()
    const zip = filesToExport.length > 1 ? new JSZip() : null
    const blobs: { name: string; blob: Blob }[] = []

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
        const blob = await exportFile(f.file, params, {
          ...exportOptions,
          filename: f.name.replace(/\.[^.]+$/, ''),
          normalizeToLUFS: params.limiterTarget,
        }, (p) => {
          setExportProgress({
            fileId: f.id,
            fileName: f.name,
            fileIndex: i + 1,
            totalFiles: filesToExport.length,
            stepProgress: p,
            stepLabel: p < 30 ? 'Lautheit messen…' : p < 90 ? 'Filter & Limiter anwenden…' : 'Wird abgeschlossen…',
            estimatedSecondsLeft: 0,
          })
        })

        const outName = `${f.name.replace(/\.[^.]+$/, '')}_fixed.${exportOptions.format}`
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
    <div className="px-4 pb-6 space-y-4">
      <div className="bg-card border border-card-border rounded-card p-4 space-y-4">
        <p className="text-text-primary font-medium text-sm">Export-Einstellungen</p>

        {/* Format */}
        <div className="space-y-2">
          <label className="text-xs text-text-secondary">Format</label>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => (
              <button
                key={f}
                onClick={() => setExportOptions({ format: f })}
                className={cn(
                  'py-2 rounded-lg text-xs font-medium uppercase transition-colors',
                  exportOptions.format === f
                    ? 'bg-accent text-white'
                    : 'bg-slider-track text-text-secondary hover:text-text-primary',
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Quality */}
        <div className="space-y-2">
          <label className="text-xs text-text-secondary">Qualität</label>
          <div className="grid grid-cols-2 gap-2">
            {QUALITIES.map((q) => {
              const disabled = isQualityDisabled(q.value, qualityCeiling)
              return (
                <button
                  key={q.value}
                  onClick={() => !disabled && setExportOptions({ quality: q.value })}
                  disabled={disabled}
                  title={disabled ? 'Überschreitet die Qualität der Originaldatei' : undefined}
                  className={cn(
                    'py-2 rounded-lg text-xs font-medium transition-colors',
                    disabled
                      ? 'opacity-30 cursor-not-allowed bg-slider-track text-text-secondary'
                      : exportOptions.quality === q.value
                        ? 'bg-accent text-white'
                        : 'bg-slider-track text-text-secondary hover:text-text-primary',
                  )}
                >
                  {q.label}
                </button>
              )
            })}
          </div>
          {qualityCeiling !== 'lossless' && (
            <p className="text-xs text-text-secondary">
              Höhere Qualitätsstufen sind nicht verfügbar — die Originaldatei überschreitet diese nicht.
            </p>
          )}
        </div>

        {/* Sample Rate */}
        <div className="space-y-2">
          <label className="text-xs text-text-secondary">Sample-Rate</label>
          <div className="flex gap-2">
            {shownSampleRates.map((sr) => (
              <button
                key={sr}
                onClick={() => setExportOptions({ sampleRate: sr })}
                className={cn(
                  'flex-1 py-2 rounded-lg text-xs font-medium transition-colors',
                  exportOptions.sampleRate === sr
                    ? 'bg-accent text-white'
                    : 'bg-slider-track text-text-secondary hover:text-text-primary',
                )}
              >
                {(sr / 1000).toFixed(1)} kHz
              </button>
            ))}
          </div>
        </div>

        {/* Estimated size */}
        {estimatedSize > 0 && (
          <p className="text-xs text-text-secondary text-right">
            Geschätzte Größe: <span className="text-text-primary">{formatFileSize(estimatedSize)}</span>
          </p>
        )}

        {/* Filename */}
        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Dateiname</label>
          <input
            type="text"
            value={exportOptions.filename}
            onChange={(e) => setExportOptions({ filename: e.target.value })}
            placeholder={activeFile ? activeFile.name.replace(/\.[^.]+$/, '') + '_fixed' : 'datei_fixed'}
            className="w-full bg-slider-track text-text-primary text-sm rounded-lg px-3 py-2.5 border border-card-border focus:outline-none focus:border-accent placeholder:text-text-secondary"
          />
        </div>
      </div>

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={startExport}
        disabled={!ffmpegLoaded}
      >
        <Download size={18} />
        {files.length > 1 ? `${files.length} Dateien exportieren` : 'Exportieren'}
      </Button>

      {!ffmpegLoaded && (
        <p className="text-center text-xs text-text-secondary animate-pulse-soft">
          Audio-Verarbeitung wird vorbereitet…
        </p>
      )}
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
