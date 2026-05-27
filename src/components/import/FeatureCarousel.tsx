import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Shield,
  Radio,
  SlidersHorizontal,
  Sparkles,
  Download,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/utils/cn'

interface Slide {
  icon: LucideIcon
  title: string
  teaser: string
  detail: string
}

const SLIDES: Slide[] = [
  {
    icon: Radio,
    title: 'Brummen & Rauschen',
    teaser: 'Störgeräusche weg — Klarheit rein.',
    detail: 'Automatisches Brummprofil, KI-Rauschunterdrückung und De-Esser für saubere Sprache.',
  },
  {
    icon: SlidersHorizontal,
    title: 'EQ & Dynamik',
    teaser: 'Profiklang ohne Studio.',
    detail: 'Sprach-optimiertes EQ, Kompressor, Limiter und A/B-Vergleich in Echtzeit.',
  },
  {
    icon: Sparkles,
    title: 'Präsenz & Klang',
    teaser: 'Redner klingen nahbar.',
    detail: 'Exciter mit Natürlich-, Wärme- und Präsenz-Modi — fein justierbar per Schieberegler.',
  },
  {
    icon: Download,
    title: 'Export & Batch',
    teaser: 'Fertig in Sekunden.',
    detail: 'MP3, WAV, FLAC und mehr — LUFS-Ziele, Qualitätsstufen, mehrere Dateien auf einmal.',
  },
]

const AUTO_MS = 5500

export function FeatureCarousel() {
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState<'next' | 'prev'>('next')
  const [animating, setAnimating] = useState(false)
  const touchStart = useRef<number | null>(null)
  const pauseUntil = useRef(0)

  const goTo = useCallback((next: number, dir: 'next' | 'prev') => {
    if (animating) return
    setDirection(dir)
    setAnimating(true)
    setIndex(((next % SLIDES.length) + SLIDES.length) % SLIDES.length)
    window.setTimeout(() => setAnimating(false), 420)
  }, [animating])

  const next = useCallback(() => goTo(index + 1, 'next'), [goTo, index])
  const prev = useCallback(() => goTo(index - 1, 'prev'), [goTo, index])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (Date.now() < pauseUntil.current) return
      next()
    }, AUTO_MS)
    return () => window.clearInterval(id)
  }, [next])

  function onTouchStart(e: React.TouchEvent) {
    touchStart.current = e.touches[0].clientX
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStart.current === null) return
    const delta = e.changedTouches[0].clientX - touchStart.current
    touchStart.current = null
    pauseUntil.current = Date.now() + AUTO_MS * 2
    if (delta > 48) prev()
    else if (delta < -48) next()
  }

  const slide = SLIDES[index]
  const Icon = slide.icon

  return (
    <section
      aria-label="Funktionen"
      className="relative"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="overflow-hidden rounded-card border border-card-border bg-card/80 backdrop-blur-sm">
        <div
          key={index}
          className={cn(
            'p-5 min-h-[148px] flex flex-col gap-3',
            animating && (direction === 'next' ? 'animate-slide-in-right' : 'animate-slide-in-left'),
          )}
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-11 h-11 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center">
              <Icon className="w-5 h-5 text-accent" aria-hidden />
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-sm font-semibold text-text-primary leading-tight">
                {slide.title}
              </h3>
              <p className="text-accent text-xs font-medium mt-0.5">{slide.teaser}</p>
            </div>
          </div>
          <p className="text-text-secondary text-xs leading-relaxed">{slide.detail}</p>
        </div>

        <div className="px-5 pb-4 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" role="tablist" aria-label="Feature-Auswahl">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`Feature ${i + 1}`}
                onClick={() => {
                  pauseUntil.current = Date.now() + AUTO_MS * 2
                  goTo(i, i > index ? 'next' : 'prev')
                }}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300',
                  i === index ? 'w-6 bg-accent' : 'w-1.5 bg-card-border hover:bg-text-secondary/60',
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-text-secondary font-tech uppercase tracking-wider">
            <Shield className="w-3 h-3 text-success shrink-0" aria-hidden />
            Lokal
          </div>
        </div>
      </div>
    </section>
  )
}

export function HeroWaveform() {
  return (
    <div className="flex items-end justify-center gap-[3px] h-10 opacity-60" aria-hidden>
      {[0.35, 0.65, 0.9, 0.55, 1, 0.7, 0.45, 0.8, 0.5, 0.75, 0.4, 0.6].map((h, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-accent/80 animate-wave-bar"
          style={{
            height: `${h * 100}%`,
            animationDelay: `${i * 0.07}s`,
          }}
        />
      ))}
    </div>
  )
}

