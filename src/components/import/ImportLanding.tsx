import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Lock,
  Zap,
  Headphones,
  Church,
  Podcast,
  Mic,
  Radio,
  Download,
  SlidersHorizontal,
  Upload,
  CheckCircle2,
  Sparkles,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useInView } from '@/hooks/useInView'
import { useAudioFilePicker } from '@/hooks/useAudioFilePicker'
import { FileUploadArea } from './FileUploadArea'
import { SpeechFixLogo } from '@/components/brand/SpeechFixLogo'

const USE_CASES = [
  { icon: Mic, label: 'Predigten & Vorträge', desc: 'Klarere Stimme für Podcast & Kirchen-Gemeinde' },
  { icon: Radio, label: 'Aufnahmen reparieren', desc: 'Brummen, Rauschen, Zischen entfernen' },
  { icon: Download, label: 'Schnell exportieren', desc: 'Ohne DAW — direkt im Browser' },
] as const

const BENEFITS: ReadonlyArray<{ icon: LucideIcon; text: string }> = [
  { icon: Zap, text: 'Sofort starten, keine Anmeldung' },
  { icon: Sparkles, text: 'Kein Audio-Wissen nötig' },
  { icon: SlidersHorizontal, text: 'Alle Verbesserungen intuitiv mit einem Regler einstellbar' },
]

const WORKFLOW_STEPS = [
  { icon: Upload, label: 'Importieren' },
  { icon: Headphones, label: 'Hören' },
  { icon: SlidersHorizontal, label: 'Regler justieren' },
  { icon: Download, label: 'Exportieren' },
  { icon: CheckCircle2, label: 'Fertig' },
] as const

function LandingHero() {
  return (
    <div className="w-full flex items-end gap-2 sm:gap-2.5 text-left">
      <SpeechFixLogo layout="stacked" className="shrink-0" />
      <p className="flex-1 min-w-0 text-[10px] sm:text-[11px] text-text-secondary leading-[1.32] pb-px">
        für Reden, Predigten
        <br />
        und Podcasts
        <br />
        <span className="text-text-secondary/85">— direkt hier im Browser</span>
      </p>
    </div>
  )
}

function BenefitsList() {
  return (
    <ul className="w-full mt-3.5 rounded-xl border border-card-border/60 bg-card/35 overflow-hidden divide-y divide-card-border/50 shadow-sm shadow-black/10">
      {BENEFITS.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-start gap-3 px-3.5 py-2.5 sm:py-3">
          <div
            className="shrink-0 w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center"
            aria-hidden
          >
            <Icon className="w-3.5 h-3.5 text-accent" />
          </div>
          <span className="text-[11px] sm:text-xs text-text-primary leading-relaxed pt-1 min-w-0">
            {text}
          </span>
        </li>
      ))}
    </ul>
  )
}

function WorkflowJourney() {
  return (
    <section
      className="w-full mt-3 rounded-xl border border-accent/25 bg-gradient-to-b from-accent/8 via-card/70 to-card/30 px-2.5 py-3 shadow-sm shadow-black/15"
      aria-label="Ablauf in fünf Schritten"
    >
      <ol className="relative flex items-start justify-between gap-0.5">
        <div
          className="pointer-events-none absolute left-[10%] right-[10%] top-[18px] h-px bg-gradient-to-r from-accent/20 via-accent/50 to-accent/20 rounded-full"
          aria-hidden
        />
        {WORKFLOW_STEPS.map((step, index) => {
          const Icon = step.icon
          const isLast = index === WORKFLOW_STEPS.length - 1
          return (
            <li key={step.label} className="relative z-10 flex flex-1 min-w-0 flex-col items-center">
              <div
                className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center border shadow-sm shadow-black/20',
                  isLast
                    ? 'bg-success/15 border-success/40'
                    : 'bg-background/90 border-accent/40',
                )}
              >
                <Icon
                  className={cn('w-4 h-4', isLast ? 'text-success' : 'text-accent')}
                  aria-hidden
                />
              </div>
              <span className="mt-1.5 text-[9px] font-medium text-text-primary text-center leading-[1.15] px-0.5">
                {step.label}
              </span>
              {!isLast && (
                <ChevronRight
                  className="absolute -right-0.5 top-3.5 w-3 h-3 text-accent/60 hidden min-[360px]:block"
                  aria-hidden
                />
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

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
  const picker = useAudioFilePicker()

  return (
    <article className="flex-1 flex flex-col min-h-0 overflow-y-auto scrollbar-none">
      <header className="relative px-4 pt-8 pb-4 overflow-hidden">
        <div
          className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-accent/10 blur-3xl"
          aria-hidden
        />
        <div className="relative flex flex-col items-center w-full gap-3">
          <LandingHero />
          <div
            className="flex flex-col items-center gap-1 px-4 py-2.5 rounded-xl bg-success/10 border border-success/30 text-success text-center max-w-[300px] w-full"
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
          <div className="w-full mt-2">
            <FileUploadArea variant="landing" picker={picker} />
          </div>
          <BenefitsList />
          <WorkflowJourney />
        </div>
      </header>

      <div className="px-4 flex flex-col gap-8 pb-8">
        <RevealSection delay={80}>
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
              <Church className="w-3 h-3 text-accent" aria-hidden /> Kirchen-Gemeinde
            </span>
            <span className="inline-flex items-center gap-1.5 text-[10px] text-text-secondary bg-background border border-card-border px-2.5 py-1 rounded-pill">
              <Podcast className="w-3 h-3 text-accent" aria-hidden /> Podcast & Video
            </span>
          </div>
        </RevealSection>

      </div>

      <div className="sr-only">
        <p>
          SpeechFix ist ein Browser-Tool zur Audio-Reparatur von Sprachaufnahmen:
          KI-Rauschunterdrückung, Brummfilter, EQ, Kompressor, De-Esser, Exciter und Export.
          Alle Verarbeitung erfolgt lokal ohne Upload.
        </p>
      </div>
    </article>
  )
}
