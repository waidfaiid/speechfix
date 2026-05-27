import { useRef } from 'react'
import type { ReactNode } from 'react'
import { AudioLines, Lock, Zap, Headphones, Church, Podcast, Mic, Radio, Download, Upload } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useInView } from '@/hooks/useInView'
import { useAudioFilePicker } from '@/hooks/useAudioFilePicker'
import { FileUploadArea } from './FileUploadArea'
import { FeatureCarousel, HeroWaveform } from './FeatureCarousel'
import { Button } from '@/components/ui/Button'

const USE_CASES = [
  { icon: Mic, label: 'Predigten & Vorträge', desc: 'Klarere Stimme für Podcast & Kirche' },
  { icon: Radio, label: 'Aufnahmen reparieren', desc: 'Brummen, Rauschen, Zischen entfernen' },
  { icon: Download, label: 'Schnell exportieren', desc: 'Ohne DAW — direkt im Browser' },
] as const

const BENEFITS = [
  { icon: Lock, text: 'Kein Upload — Audio bleibt auf deinem Gerät' },
  { icon: Zap, text: 'Sofort starten, keine Anmeldung' },
  { icon: Headphones, text: 'A/B-Hören: Original vs. bearbeitet' },
] as const

function RevealSection({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const { ref, inView } = useInView<HTMLElement>()
  return (
    <section
      ref={ref}
      className={cn(
        'transition-all duration-700 ease-out',
        inView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6',
        className,
      )}
      style={{ transitionDelay: inView ? `${delay}ms` : '0ms' }}
    >
      {children}
    </section>
  )
}

export function ImportLanding() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const picker = useAudioFilePicker()
  const { openPicker } = picker

  const { ref: uploadAnchorRef, inView: uploadVisible } = useInView<HTMLDivElement>({
    root: scrollRef,
    threshold: 0.35,
    rootMargin: '0px 0px -24px 0px',
    triggerOnce: false,
  })

  const showStickyCta = !uploadVisible

  return (
    <article className="flex-1 flex flex-col min-h-0 relative">
      <div
        ref={scrollRef}
        className={cn(
          'flex-1 overflow-y-auto scrollbar-none',
          showStickyCta ? 'pb-2' : 'pb-8',
        )}
      >
        <header className="relative px-4 pt-2 pb-6 overflow-hidden">
          <div
            className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-accent/10 blur-3xl"
            aria-hidden
          />
          <div className="relative flex flex-col items-center text-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-card border border-card-border flex items-center justify-center shadow-lg shadow-black/30">
              <AudioLines className="w-7 h-7 text-accent" aria-hidden />
            </div>
            <HeroWaveform />
            <h2 className="text-2xl font-bold tracking-tight text-white leading-tight">
              Sprach-Audio
              <span className="text-accent"> reparieren</span>
            </h2>
            <p className="text-text-secondary text-sm leading-snug max-w-[300px]">
              Professionelle Audio Aufbereitung
              <br />
              für Reden, Predigten und Podcasts
              <br />
              — direkt im Browser.
            </p>
            <div
              className="flex flex-col items-center gap-1 px-4 py-2.5 rounded-xl bg-success/10 border border-success/30 text-success text-center max-w-[300px]"
              role="status"
            >
              <div className="flex items-center justify-center gap-2 text-[11px] font-semibold leading-snug">
                <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden />
                <span>100&nbsp;% lokal — kein Upload, kein Server</span>
              </div>
              <p className="text-[10px] font-medium leading-snug text-success/95 px-1">
                alles wird ausschließlich auf deinem Gerät berechnet
              </p>
            </div>
          </div>
        </header>

        <div className="px-4 flex flex-col gap-8">
          <RevealSection>
            <FeatureCarousel />
          </RevealSection>

          <RevealSection delay={80}>
            <h3 className="text-[11px] font-tech uppercase tracking-widest text-text-secondary mb-3">
              Vorteile
            </h3>
            <ul className="space-y-2">
              {BENEFITS.map(({ icon: Icon, text }) => (
                <li
                  key={text}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card/60 border border-card-border/80"
                >
                  <Icon className="w-4 h-4 text-accent shrink-0" aria-hidden />
                  <span className="text-xs text-text-primary leading-snug">{text}</span>
                </li>
              ))}
            </ul>
          </RevealSection>

          <RevealSection delay={120}>
            <h3 className="text-[11px] font-tech uppercase tracking-widest text-text-secondary mb-3">
              Ideal für
            </h3>
            <div className="grid grid-cols-1 gap-2">
              {USE_CASES.map(({ icon: Icon, label, desc }) => (
                <div
                  key={label}
                  className="flex gap-3 p-3 rounded-lg border border-card-border bg-card-elevated/50"
                >
                  <div className="w-9 h-9 rounded-lg bg-background border border-card-border flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-accent" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{label}</p>
                    <p className="text-[11px] text-text-secondary mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 justify-center">
              <span className="inline-flex items-center gap-1.5 text-[10px] text-text-secondary bg-background border border-card-border px-2.5 py-1 rounded-pill">
                <Church className="w-3 h-3 text-accent" aria-hidden /> Gemeinde & Kirche
              </span>
              <span className="inline-flex items-center gap-1.5 text-[10px] text-text-secondary bg-background border border-card-border px-2.5 py-1 rounded-pill">
                <Podcast className="w-3 h-3 text-accent" aria-hidden /> Podcast & Video
              </span>
            </div>
          </RevealSection>

          <RevealSection delay={160} className="pb-2">
            <h3 className="text-[11px] font-tech uppercase tracking-widest text-text-secondary mb-3 text-center">
              Loslegen
            </h3>
            <div ref={uploadAnchorRef}>
              <FileUploadArea variant="hero" picker={picker} />
            </div>
            <p className="text-center text-[10px] text-text-secondary/80 mt-3 leading-relaxed px-2">
              Deine Dateien werden ausschließlich im Arbeitsspeicher deines Browsers verarbeitet.
              Keine Cloud, kein Konto, keine Weitergabe an Dritte.
            </p>
          </RevealSection>
        </div>

        <div className="sr-only">
          <p>
            SpeechFix ist ein Browser-Tool zur Audio-Reparatur von Sprachaufnahmen:
            KI-Rauschunterdrückung, Brummfilter, EQ, Kompressor, De-Esser, Exciter und Export.
            Alle Verarbeitung erfolgt lokal ohne Upload.
          </p>
        </div>
      </div>

      <div
        className={cn(
          'shrink-0 z-20 px-4 pt-3 safe-bottom transition-all duration-300 ease-out',
          'border-t border-card-border/60 bg-background/95 backdrop-blur-md',
          showStickyCta
            ? 'opacity-100 translate-y-0 pointer-events-auto pb-4'
            : 'opacity-0 translate-y-3 pointer-events-none pb-0 max-h-0 overflow-hidden pt-0 border-transparent',
        )}
        aria-hidden={!showStickyCta}
      >
        <Button
          variant="primary"
          size="lg"
          className="w-full shadow-lg shadow-accent/20"
          onClick={openPicker}
        >
          <Upload className="w-5 h-5" aria-hidden />
          Jetzt starten
        </Button>
      </div>
    </article>
  )
}
