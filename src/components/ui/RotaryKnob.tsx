import { useRef, useState, useCallback, useEffect } from 'react'

interface RotaryKnobProps {
  /** Current trim value in seconds */
  value: number
  /** Maximum trim value in seconds */
  max: number
  /** Called when the value changes */
  onChange: (v: number) => void
  /** Tooltip / aria-label */
  label: string
  /** Whether this is the end trim knob (reverses knob direction visually) */
  isEnd?: boolean
  /** Larger variant for mobile — 56 px instead of 48 px */
  large?: boolean
}

/** Format seconds as m:ss or h:mm:ss for display inside the knob */
function formatKnobTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * Parse a time string like "56s", "1:59", "1:50:40" into seconds.
 * Returns null if unparseable.
 */
function parseTimeInput(raw: string): number | null {
  const s = raw.trim().toLowerCase()
  const secsMatch = s.match(/^(\d+(?:\.\d+)?)s?$/)
  if (secsMatch) return parseFloat(secsMatch[1])
  const mmss = s.match(/^(\d+):(\d{1,2})$/)
  if (mmss) return parseInt(mmss[1]) * 60 + parseInt(mmss[2])
  const hhmmss = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/)
  if (hhmmss) return parseInt(hhmmss[1]) * 3600 + parseInt(hhmmss[2]) * 60 + parseInt(hhmmss[3])
  return null
}

/** Build an SVG arc path for the knob indicator arc */
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const x1 = cx + r * Math.cos(toRad(startAngle))
  const y1 = cy + r * Math.sin(toRad(startAngle))
  const x2 = cx + r * Math.cos(toRad(endAngle))
  const y2 = cy + r * Math.sin(toRad(endAngle))
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
}

export function RotaryKnob({ value, max, onChange, label, isEnd = false, large = false }: RotaryKnobProps) {
  const [editing, setEditing] = useState(false)
  const [inputVal, setInputVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null)

  // Geometry — default 48 px, large 56 px
  const SIZE   = large ? 56 : 48
  const cx     = SIZE / 2
  const cy     = SIZE / 2
  // Ring radius fills ~83 % of the container radius for a bold look
  const r      = Math.round(cx * 0.83)

  // Arc: starts at ~210° (7 o'clock), sweeps 240° clockwise
  const ARC_START = 210
  const ARC_TOTAL = 240
  const fraction = max > 0 ? Math.min(1, value / max) : 0
  const arcEnd = ARC_START + fraction * ARC_TOTAL

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (editing) return
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startValue: value }

    function onMouseMove(ev: MouseEvent) {
      if (!dragRef.current) return
      const dy = dragRef.current.startY - ev.clientY
      const delta = (dy / 200) * max
      const next = Math.max(0, Math.min(max, dragRef.current.startValue + delta))
      onChange(next)
    }

    function onMouseUp() {
      dragRef.current = null
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [editing, value, max, onChange])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const step = e.shiftKey ? 10 : 1
    const delta = e.deltaY < 0 ? step : -step
    const next = Math.max(0, Math.min(max, value + delta))
    onChange(next)
  }, [value, max, onChange])

  const handleDoubleClick = useCallback(() => {
    setInputVal(formatKnobTime(value))
    setEditing(true)
  }, [value])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  function commitEdit() {
    const parsed = parseTimeInput(inputVal)
    if (parsed !== null) {
      onChange(Math.max(0, Math.min(max, parsed)))
    }
    setEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commitEdit()
    if (e.key === 'Escape') setEditing(false)
  }

  const sizeClass = large ? 'w-14 h-14' : 'w-12 h-12'
  const textSize  = large
    ? (value >= 3600 ? 'text-[8px]' : value >= 60 ? 'text-[9px]' : 'text-[10px]')
    : (value >= 3600 ? 'text-[7px]' : value >= 60 ? 'text-[8px]'  : 'text-[9px]')

  return (
    <div
      ref={knobRef}
      className={`relative flex items-center justify-center ${sizeClass} rounded-full cursor-ns-resize select-none`}
      style={{ touchAction: 'none' }}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      title={`${label} — ziehen oder scrollen; Doppelklick zum Eingeben`}
      aria-label={label}
      role="slider"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
    >
      {/* SVG knob ring */}
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0"
        style={{ pointerEvents: 'none' }}
      >
        {/* Background track ring */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-slider-track"
        />
        {/* Active trim arc */}
        {value > 0 && (
          <path
            d={describeArc(cx, cy, r, ARC_START, arcEnd)}
            fill="none"
            stroke="#ef4444"
            strokeWidth="3"
            strokeLinecap="round"
          />
        )}
      </svg>

      {/* Center label / input */}
      {editing ? (
        <input
          ref={inputRef}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
          className="absolute inset-0 w-full h-full rounded-full text-center text-[9px] font-mono bg-card text-text-primary border border-accent outline-none z-10"
          style={{ cursor: 'text', padding: '0 2px' }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={`relative z-10 font-mono font-semibold leading-none pointer-events-none ${textSize} ${
            value > 0 ? 'text-red-400' : 'text-text-secondary'
          }`}
        >
          {formatKnobTime(value)}
        </span>
      )}
    </div>
  )
}
