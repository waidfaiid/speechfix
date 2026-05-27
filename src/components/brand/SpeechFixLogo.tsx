import { AudioLines } from 'lucide-react'
import { cn } from '@/utils/cn'

interface SpeechFixLogoProps {
  className?: string
  size?: 'default' | 'compact'
}

export function SpeechFixLogo({ className, size = 'default' }: SpeechFixLogoProps) {
  const compact = size === 'compact'
  return (
    <div
      className={cn(
        'flex items-center justify-center',
        compact ? 'gap-2' : 'gap-3 w-full px-1',
        className,
      )}
      aria-label="SpeechFix"
    >
      <AudioLines
        className={cn('text-accent shrink-0', compact ? 'w-7 h-7' : 'w-9 h-9 sm:w-10 sm:h-10')}
        aria-hidden
      />
      <p
        className={cn(
          'font-bold tracking-tight leading-none',
          compact ? 'text-[1.6rem]' : 'text-[2rem] sm:text-[2.35rem]',
        )}
      >
        <span className="text-white">Speech</span>
        <span className="text-accent">Fix</span>
      </p>
    </div>
  )
}
