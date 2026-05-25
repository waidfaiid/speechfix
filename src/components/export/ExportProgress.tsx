import { useFileStore } from '@/store/useFileStore'

function formatTimeLeft(seconds: number): string {
  if (seconds <= 0) return ''
  if (seconds < 60) return `~${seconds}s verbleibend`
  const min = Math.floor(seconds / 60)
  const sec = seconds % 60
  return `~${min}:${sec.toString().padStart(2, '0')} verbleibend`
}

export function ExportProgress() {
  const progress = useFileStore((s) => s.exportProgress)
  const isExporting = useFileStore((s) => s.isExporting)

  if (!isExporting || !progress) return null

  const overallPct = Math.round(((progress.fileIndex - 1) / progress.totalFiles) * 100 + progress.stepProgress / progress.totalFiles)
  const timeLeft = formatTimeLeft(progress.estimatedSecondsLeft)

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-end animate-fade-in">
      <div className="w-full bg-card border-t border-card-border rounded-t-2xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <p className="text-text-primary font-semibold">Wird verarbeitet…</p>
          <span className="text-text-secondary text-sm">
            {progress.fileIndex}/{progress.totalFiles}
          </span>
        </div>

        {/* Per-file progress */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary truncate max-w-[200px]">{progress.fileName}</span>
            <span className="text-text-secondary font-tech">{progress.stepProgress}%</span>
          </div>
          <div className="h-2.5 bg-slider-track rounded-pill overflow-hidden">
            <div
              className="h-full bg-accent rounded-pill transition-[width] duration-500 ease-out"
              style={{ width: `${progress.stepProgress}%` }}
            />
          </div>
          <div className="flex justify-between items-center">
            <p className="text-xs text-text-secondary">{progress.stepLabel}</p>
            {timeLeft && (
              <p className="text-xs text-text-secondary font-tech">{timeLeft}</p>
            )}
          </div>
        </div>

        {/* Overall progress */}
        {progress.totalFiles > 1 && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-text-secondary">
              <span>Gesamt</span>
              <span>{overallPct}%</span>
            </div>
            <div className="h-1 bg-slider-track rounded-pill overflow-hidden">
              <div
                className="h-full bg-accent/60 rounded-pill transition-[width] duration-500 ease-out"
                style={{ width: `${overallPct}%` }}
              />
            </div>
          </div>
        )}

        <p className="text-xs text-center text-text-secondary">
          Bitte warte bis die Verarbeitung abgeschlossen ist
        </p>
      </div>
    </div>
  )
}
