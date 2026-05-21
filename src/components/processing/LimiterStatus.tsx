import type { LimiterInterventionLevel } from '@/types/audio.types'
import { cn } from '@/utils/cn'

function levelFromDb(db: number): LimiterInterventionLevel {
  if (db < 3) return 'ok'
  if (db <= 8) return 'warn'
  return 'critical'
}

const STYLES: Record<LimiterInterventionLevel, { bar: string; text: string; message: string }> = {
  ok: {
    bar: 'bg-green-500',
    text: 'text-green-700 dark:text-green-400',
    message: 'Limiter greift wenig ein — Kompressor arbeitet gut.',
  },
  warn: {
    bar: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-400',
    message: 'Limiter ~3–8 dB aktiv — Kompressor etwas erhöhen.',
  },
  critical: {
    bar: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
    message: 'Limiter arbeitet sehr hart — Kompressor erhöhen oder −16/−14 LUFS wählen.',
  },
}

interface LimiterStatusProps {
  interventionDb: number
  isPlaying: boolean
}

export function LimiterStatus({ interventionDb, isPlaying }: LimiterStatusProps) {
  const level = levelFromDb(interventionDb)
  const style = STYLES[level]
  const fillPct = Math.min(100, (interventionDb / 12) * 100)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-primary">Limiter-Belastung</span>
        <span className={cn('text-xs tabular-nums font-semibold', style.text)}>
          {isPlaying ? `${interventionDb.toFixed(1)} dB` : '—'}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slider-track overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-200', style.bar)}
          style={{ width: isPlaying ? `${fillPct}%` : '0%' }}
        />
      </div>
      <p className={cn('text-[11px] leading-snug', style.text)}>
        {isPlaying ? style.message : 'Während der Wiedergabe wird die Limiter-Belastung angezeigt.'}
      </p>
    </div>
  )
}
