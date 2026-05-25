import { cn } from '@/utils/cn'
import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium rounded-pill transition-colors select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:opacity-40 disabled:pointer-events-none',
        {
          'bg-accent text-white hover:bg-accent-hover active:scale-95': variant === 'primary',
          'bg-card border border-card-border text-text-primary hover:bg-[#1f2937] active:scale-95': variant === 'secondary',
          'text-stone-300 hover:text-text-primary hover:bg-card active:scale-95': variant === 'ghost',
          'bg-red-900 text-red-200 hover:bg-red-800 active:scale-95': variant === 'danger',
        },
        {
          'h-8 px-3 text-xs': size === 'sm',
          'h-11 px-5 text-sm': size === 'md',
          'h-14 px-6 text-base': size === 'lg',
        },
        className,
      )}
      {...props}
    />
  )
}
