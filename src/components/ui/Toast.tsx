import { useState } from 'react'
import { X, CheckCircle, AlertCircle, Info, AlertTriangle, Copy, Check } from 'lucide-react'
import { useUIStore } from '@/store/useUIStore'
import { cn } from '@/utils/cn'

const icons = {
  info: Info,
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
}

function ToastItem({ t, onRemove }: { t: { id: string; message: string; type: 'info' | 'success' | 'error' | 'warning' }; onRemove: () => void }) {
  const [copied, setCopied] = useState(false)
  const Icon = icons[t.type]

  function handleCopy() {
    navigator.clipboard?.writeText(t.message)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => {
        // Fallback for environments where Clipboard API is unavailable.
        try {
          const el = document.createElement('textarea')
          el.value = t.message
          el.style.position = 'fixed'
          el.style.opacity = '0'
          document.body.appendChild(el)
          el.select()
          document.execCommand('copy')
          document.body.removeChild(el)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* silent */ }
      })
  }

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 rounded-card border animate-fade-in pointer-events-auto',
        'bg-card border-card-border',
        { 'border-l-4 border-l-success': t.type === 'success' },
        { 'border-l-4 border-l-error': t.type === 'error' },
        { 'border-l-4 border-l-warning': t.type === 'warning' },
        { 'border-l-4 border-l-accent': t.type === 'info' },
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0 text-text-secondary" />
      <p className="flex-1 text-sm text-text-primary break-words min-w-0">{t.message}</p>
      <div className="flex items-center gap-1 shrink-0 ml-1">
        <button
          onClick={handleCopy}
          title="Nachricht kopieren"
          className={cn(
            'p-1 rounded transition-colors',
            copied
              ? 'text-success'
              : 'text-text-secondary hover:text-text-primary',
          )}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          onClick={onRemove}
          className="p-1 text-text-secondary hover:text-text-primary transition-colors rounded"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

export function ToastContainer() {
  const { toasts, removeToast } = useUIStore()

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  )
}
