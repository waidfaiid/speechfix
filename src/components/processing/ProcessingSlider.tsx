import * as RadixSlider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
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
}

export function ProcessingSlider({
  label, icon, value, onChange, enabled = true, onToggle,
  displayValue, min = 0, max = 1, step = 0.01, children, action, rightAddon,
}: ProcessingSliderProps) {
  const pct = Math.round(((value - min) / (max - min)) * 100)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary">{icon}</span>
          <span className="font-medium text-text-primary text-sm">{label}</span>
          {action}
        </div>
        <div className="flex items-center gap-2">
          {rightAddon}
          <span className="text-text-secondary text-xs tabular-nums">
            {displayValue ?? `${pct}%`}
          </span>
          {onToggle && (
            <Switch.Root
              checked={enabled}
              onCheckedChange={onToggle}
              className="w-9 h-5 rounded-pill border-2 border-text-secondary/30 bg-transparent data-[state=checked]:bg-accent data-[state=checked]:border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Switch.Thumb className="block w-3.5 h-3.5 rounded-full bg-text-secondary/60 data-[state=checked]:bg-white translate-x-0.5 data-[state=checked]:translate-x-4 transition-transform" />
            </Switch.Root>
          )}
        </div>
      </div>

      <RadixSlider.Root
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min}
        max={max}
        step={step}
        disabled={!enabled}
        className="relative flex items-center select-none touch-none w-full h-11"
      >
        <RadixSlider.Track className="bg-slider-track relative grow rounded-pill h-2">
          <RadixSlider.Range className="absolute bg-accent rounded-pill h-full" />
        </RadixSlider.Track>
        <RadixSlider.Thumb
          className="block w-5 h-5 bg-white rounded-full border-2 border-accent shadow transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={label}
        />
      </RadixSlider.Root>

      {children}
    </div>
  )
}
