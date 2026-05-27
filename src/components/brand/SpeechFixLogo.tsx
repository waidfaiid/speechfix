import { AudioLines } from 'lucide-react'
import { cn } from '@/utils/cn'

interface SpeechFixLogoProps {
  className?: string
  /** Icon + Wortmarke nebeneinander, zentriert */
  layout?: 'horizontal' | 'stacked'
}

export function SpeechFixLogo({ className, layout = 'horizontal' }: SpeechFixLogoProps) {
  if (layout === 'stacked') {
    return (
      <div
        className={cn('inline-grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 items-center', className)}
        aria-label="SpeechFix"
      >
        <AudioLines
          className="row-span-2 w-11 h-11 text-accent self-start mt-0.5"
          aria-hidden
        />
        <p className="text-[1.95rem] font-bold tracking-tight leading-none text-left whitespace-nowrap">
          <span className="text-white">Speech</span>
          <span className="text-accent">Fix</span>
        </p>
        <p className="text-[12px] font-semibold text-white leading-tight text-left whitespace-nowrap">
          Sprach-Audio <span className="text-accent">verbessern</span>
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn('flex items-center justify-center gap-3 w-full px-1', className)}
      aria-label="SpeechFix"
    >
      <AudioLines className="w-9 h-9 sm:w-10 sm:h-10 text-accent shrink-0" aria-hidden />
      <p className="text-[2rem] sm:text-[2.35rem] font-bold tracking-tight leading-none">
        <span className="text-white">Speech</span>
        <span className="text-accent">Fix</span>
      </p>
    </div>
  )
}
