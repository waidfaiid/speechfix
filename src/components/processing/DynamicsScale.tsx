import { dynamicsDbToPosition, DYNAMICS_SCALE_MAX_DB, DYNAMICS_IDEAL_MIN_DB, DYNAMICS_IDEAL_MAX_DB } from '@/audio/analysis/dynamicsMeter'
import { cn } from '@/utils/cn'

export const ORIGINAL_COLOR = '#94a3b8'   // slate-400
export const PROCESSED_COLOR = '#f59e0b'  // amber-500

const SCALE_TICKS = [20, 15, 10, 5, 0]

interface DynamicsScaleProps {
  originalDb: number
  processedDb: number
  showProcessed: boolean
}

export function DynamicsScale({ originalDb, processedDb, showProcessed }: DynamicsScaleProps) {
  const originalPos = dynamicsDbToPosition(originalDb)
  const processedPos = dynamicsDbToPosition(processedDb)

  const idealLeftPct = dynamicsDbToPosition(DYNAMICS_IDEAL_MAX_DB) * 100
  const idealRightPct = dynamicsDbToPosition(DYNAMICS_IDEAL_MIN_DB) * 100

  return (
    <div className="bg-background p-3 rounded-xl border border-card-border mt-2">
      {/* Value labels */}
      <div className="flex items-center mb-2.5 px-1 gap-2">
        <div className="flex items-center gap-1.5">
          <div className="w-[3px] h-[10px] rounded-sm" style={{ background: ORIGINAL_COLOR }} />
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-medium">
            Original <span className="font-tech text-slate-300 ml-1 font-normal lowercase">{originalDb.toFixed(1)} dB</span>
          </span>
        </div>

        <span className="font-tech text-[8px] text-text-secondary/30 flex-1 text-center" style={{ textTransform: 'none' }}>dB · P80–P20 RMS</span>
        
        <div className={cn("flex items-center gap-1.5 transition-opacity", showProcessed ? "opacity-100" : "opacity-40")}>
          <span className={cn("text-[10px] uppercase tracking-wider", showProcessed ? "text-accent font-bold" : "text-text-secondary font-medium")}>
            Bearbeitet <span className={cn("font-tech ml-1 lowercase", showProcessed ? "text-accent font-bold" : "font-normal")}>{showProcessed ? processedDb.toFixed(1) : "—"} dB</span>
          </span>
          <div className="w-[3px] h-[10px] rounded-sm" style={{ background: showProcessed ? PROCESSED_COLOR : '#78716c' }} />
        </div>
      </div>

      {/* Meter area */}
      <div className="relative px-1">
        {/* Gradient bar — orange (dynamic) → green (ideal) → red (lifeless) */}
        <div className="h-[5px] w-full rounded-full relative overflow-hidden"
             style={{ background: 'linear-gradient(to right, #f59e0b, #22c55e 40%, #22c55e 55%, #ef4444)' }}>
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPjxyZWN0IHdpZHRoPSI0IiBoZWlnaHQ9IjQiIGZpbGw9InRyYW5zcGFyZW50Ij48L3JlY3Q+PHBhdGggZD0iTTAgNEw0IDBaIiBzdHJva2U9InJnYmEoMjU1LDI1NSwyNTUsMC4xKSIgc3Ryb2tlLXdpZHRoPSIxIj48L3BhdGg+PC9zdmc+')] opacity-40" />
        </div>

        {/* Ideal zone bracket */}
        <div className="absolute top-[-1px] h-[7px] border-t border-b border-green-400/30 rounded-sm pointer-events-none"
             style={{ left: `${idealLeftPct}%`, width: `${idealRightPct - idealLeftPct}%` }} />

        {/* Original marker */}
        <div
          className="absolute top-[-4px] w-[2px] h-[13px] rounded-[1px] z-10 transition-[left] duration-500 ease-out"
          style={{
            left: `calc(${Math.max(1, Math.min(99, originalPos * 100))}% - 1px)`,
            background: ORIGINAL_COLOR,
            boxShadow: `0 0 3px ${ORIGINAL_COLOR}80`,
          }}
        />

        {/* Processed marker */}
        <div
          className={cn(
            "absolute top-[-4px] w-[2px] h-[13px] rounded-[1px] z-20 transition-all duration-500 ease-out",
            !showProcessed && "opacity-0",
          )}
          style={{
            left: `calc(${Math.max(1, Math.min(99, processedPos * 100))}% - 1px)`,
            background: PROCESSED_COLOR,
            boxShadow: `0 0 4px ${PROCESSED_COLOR}90`,
          }}
        />

        {/* dB tick marks + numbers */}
        <div className="relative h-[14px] mt-[3px]">
          {SCALE_TICKS.map((db) => {
            const pos = dynamicsDbToPosition(db) * 100
            const anchor = db === 0 ? 'translate-x-[-100%]' : db === 20 ? '' : '-translate-x-1/2'
            return (
              <div key={db} className="absolute" style={{ left: `${pos}%` }}>
                <div className="w-px h-[3px] bg-text-secondary/25" />
                <span className={cn("font-tech text-[8px] text-text-secondary/40 leading-none block mt-px", anchor)}>
                  {db}
                </span>
              </div>
            )
          })}
        </div>

        {/* Zone labels */}
        <div className="flex justify-between text-[7px] font-medium uppercase tracking-wider mt-px">
          <span className="text-amber-400/50">Schwankend</span>
          <span className="text-green-400/60">Ideal</span>
          <span className="text-red-400/50">Leblos</span>
        </div>
      </div>
    </div>
  )
}
