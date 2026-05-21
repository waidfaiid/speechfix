import {
  DYNAMICS_IDEAL_MAX_DB,
  DYNAMICS_IDEAL_MIN_DB,
  DYNAMICS_SCALE_MAX_DB,
  DYNAMICS_AUTO_TARGET_DB,
  dynamicsDbToPosition,
} from '@/audio/analysis/dynamicsMeter'
import { cn } from '@/utils/cn'

// Marker colors — exported so DynamicsCompressorSection can match them
export const ORIGINAL_COLOR = '#a78bfa'   // violet-400
export const PROCESSED_COLOR = '#38bdf8'  // sky-400

// dB ticks: every 2 dB; show label only for key values
const TICKS = [0, 2, 4, 6, 8, 9, 10, 12, 14, 16, 18, 20]
const LABELED = new Set([0, 10, 20])
const IDEAL_EDGE = new Set([DYNAMICS_IDEAL_MIN_DB, DYNAMICS_IDEAL_MAX_DB]) // 9, 12

// Gradient: yellow (too dynamic) → green (9–12 dB ideal, 10 dB peak) → orange → red (over-compressed)
// position 0 = left = high dynamics (20 dB), position 1 = right = no dynamics (0 dB)
const pct = (db: number) => `${((DYNAMICS_SCALE_MAX_DB - db) / DYNAMICS_SCALE_MAX_DB * 100).toFixed(1)}%`
const GRADIENT = [
  `#eab308 0%`,
  `#84cc16 ${pct(16)}`,
  `#22c55e ${pct(DYNAMICS_IDEAL_MAX_DB)}`,
  `#16a34a ${pct(DYNAMICS_AUTO_TARGET_DB)}`,
  `#22c55e ${pct(DYNAMICS_IDEAL_MIN_DB)}`,
  `#f97316 ${pct(4)}`,
  `#ef4444 100%`,
].join(', ')

interface DynamicsScaleProps {
  originalDb: number
  processedDb: number
  showProcessed: boolean
}

export function DynamicsScale({ originalDb, processedDb, showProcessed }: DynamicsScaleProps) {
  const originalPos = dynamicsDbToPosition(originalDb)
  const processedPos = dynamicsDbToPosition(processedDb)
  const idealPct = pct(DYNAMICS_AUTO_TARGET_DB)

  return (
    <div className="space-y-1">
      {/* Color bar with pin markers */}
      <div
        className="relative h-3 rounded-full overflow-hidden border border-card-border"
        style={{ background: `linear-gradient(to right, ${GRADIENT})` }}
      >
        {/* Subtle center-ideal notch at 10 dB */}
        <div
          className="absolute top-0 bottom-0 w-px bg-white/25"
          style={{ left: idealPct }}
        />

        <PinMarker
          position={originalPos}
          color={ORIGINAL_COLOR}
          label={`Original · ${originalDb.toFixed(1)} dB Dynamik`}
        />
        {showProcessed && (
          <PinMarker
            position={processedPos}
            color={PROCESSED_COLOR}
            label={`Komprimiert · ${processedDb.toFixed(1)} dB Dynamik`}
          />
        )}
      </div>

      {/* dB tick scale */}
      <div className="relative h-5">
        {TICKS.map((db) => {
          const pos = (1 - db / DYNAMICS_SCALE_MAX_DB) * 100
          const isMain = LABELED.has(db)
          const isIdealEdge = IDEAL_EDGE.has(db)
          const isIdealCenter = db === DYNAMICS_AUTO_TARGET_DB
          return (
            <div
              key={db}
              className="absolute flex flex-col items-center"
              style={{ left: `${pos}%`, transform: 'translateX(-50%)' }}
            >
              <div
                className={cn(
                  'w-px',
                  isIdealCenter
                    ? 'h-2.5 bg-green-400/80'
                    : isIdealEdge
                      ? 'h-2 bg-green-500/50'
                      : isMain
                        ? 'h-2 bg-text-secondary/40'
                        : 'h-1.5 bg-text-secondary/25',
                )}
              />
              {(isMain || isIdealCenter) && (
                <span
                  className={cn(
                    'text-[9px] tabular-nums mt-px leading-none',
                    isIdealCenter
                      ? 'text-green-400 font-bold'
                      : 'text-text-secondary',
                  )}
                >
                  {db}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer labels */}
      <div className="flex justify-between text-[10px] leading-tight">
        <span className="text-yellow-600 dark:text-yellow-400">
          zu schwankend<br />
          <span className="text-text-secondary">zu viel Dynamik</span>
        </span>
        <span className="text-green-500 dark:text-green-400 font-medium text-center">
          ideal<br />
          <span className="text-text-secondary font-normal">
            {DYNAMICS_IDEAL_MIN_DB}–{DYNAMICS_IDEAL_MAX_DB} dB
          </span>
        </span>
        <span className="text-right text-red-500 dark:text-red-400">
          leblos<br />
          <span className="text-text-secondary">zu wenig Dynamik</span>
        </span>
      </div>
    </div>
  )
}

function PinMarker({
  position,
  color,
  label,
}: {
  position: number
  color: string
  label: string
}) {
  const left = `${Math.max(2, Math.min(98, position * 100))}%`
  return (
    <div
      className="absolute top-0 bottom-0 flex flex-col items-center pointer-events-none transition-[left] duration-500 ease-out"
      style={{ left, transform: 'translateX(-50%)' }}
      title={label}
    >
      {/* Cap */}
      <div
        className="w-1.5 h-1 rounded-sm shrink-0"
        style={{ backgroundColor: color, boxShadow: `0 0 4px ${color}` }}
      />
      {/* Needle */}
      <div
        className="w-px flex-1"
        style={{ backgroundColor: color, opacity: 0.55 }}
      />
    </div>
  )
}
