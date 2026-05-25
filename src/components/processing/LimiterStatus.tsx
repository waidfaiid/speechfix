import type { LimiterInterventionLevel } from '@/types/audio.types'
import { cn } from '@/utils/cn'

function levelFromDb(db: number): LimiterInterventionLevel {
  if (db < 3) return 'ok'
  if (db <= 8) return 'warn'
  return 'critical'
}

const STYLES: Record<LimiterInterventionLevel, { bar: string; dot: string; bg: string; text: string; message: string; border: string }> = {
  ok: {
    bar: 'bg-green-400',
    dot: 'bg-green-400',
    bg: 'bg-green-400/10',
    border: 'border-green-500/20',
    text: 'text-green-400/80',
    message: 'Limiter greift wenig ein — Kompressor arbeitet gut.',
  },
  warn: {
    bar: 'bg-amber-400',
    dot: 'bg-amber-400',
    bg: 'bg-amber-400/10',
    border: 'border-amber-500/20',
    text: 'text-amber-400/80',
    message: 'Limiter ~3–8 dB aktiv — Kompressor etwas erhöhen.',
  },
  critical: {
    bar: 'bg-red-500',
    dot: 'bg-red-500',
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    text: 'text-red-400/80',
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
    <div className={cn("text-[10px] px-3 py-2 rounded-md flex flex-col gap-2 border", style.bg, style.border, style.text)}>
      <div className="flex items-center gap-2">
        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", style.dot, isPlaying && "animate-pulse")}></div>
        <span>{isPlaying ? style.message : 'Limiter-Belastung wird während Wiedergabe aktiv angezeigt.'}</span>
      </div>
      
      {isPlaying && (
        <div className="flex items-center gap-2 mt-1">
          <div className="h-1.5 flex-1 rounded-full bg-background/50 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-200', style.bar)}
              style={{ width: `${fillPct}%` }}
            />
          </div>
          <span className="font-tech font-bold tabular-nums">
            {interventionDb.toFixed(1)} dB
          </span>
        </div>
      )}
    </div>
  )
}
