import * as RadixSlider from '@radix-ui/react-slider'
import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface ProcessingSliderProps {
  label: string
  icon: ReactNode
  value: number
  onChange: (v: number) => void
  enabled?: boolean
  onToggle?: (v: boolean) => void
  displayValue?: string
  min?: number
  max?: number
  step?: number
  children?: ReactNode
  action?: ReactNode
  /** Rendered between displayValue and the toggle switch (e.g. a dropdown) */
  rightAddon?: ReactNode
  title?: string
  className?: string
}

export function ProcessingSlider({
  label, icon, value, onChange, enabled = true, onToggle,
  displayValue, min = 0, max = 1, step = 0.01, children, action, rightAddon, title, className
}: ProcessingSliderProps) {
  const pct = Math.round(((value - min) / (max - min)) * 100)

  return (
    <div className={cn("mod-card", className)} title={title}>
      <div className="card-inner">
        <div className="flex justify-between items-center mb-1 gap-2">
          <div className={cn("flex items-center gap-2 transition-opacity duration-300 min-w-0", !enabled && "opacity-40")}>
            <div className="p-1.5 bg-background rounded-md border border-card-border shrink-0">
              <span className="text-text-secondary w-4 h-4 flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-sm text-white truncate">{label}</span>
              {action}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className={cn("flex items-center gap-2 transition-opacity duration-300", !enabled && "opacity-40")}>
              {rightAddon}
              <span className="font-tech text-xs text-stone-400 w-12 text-right">
                {displayValue ?? `${pct}%`}
              </span>
            </div>
            {onToggle && (
              <input
                type="checkbox"
                className="modern-toggle shrink-0"
                checked={enabled}
                onChange={(e) => onToggle(e.target.checked)}
              />
            )}
          </div>
        </div>

        <div className={cn("flex items-center gap-2 mt-2 transition-opacity duration-300", !enabled && "opacity-40")}>
          <span className="text-[10px] font-tech text-text-secondary">{min}</span>
          <input 
            type="range" 
            value={value} 
            onChange={(e) => onChange(parseFloat(e.target.value))}
            min={min}
            max={max}
            step={step}
            className="flex-1"
            disabled={!enabled}
            style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
          />
          <span className="text-[10px] font-tech text-text-secondary">{max}</span>
        </div>

        {children && (
          <div className={cn("transition-opacity duration-300", !enabled && "opacity-40")}>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
