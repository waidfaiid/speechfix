import { forwardRef, useImperativeHandle, useState } from 'react'
import { Upload, Music } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/Button'
import { useAudioFilePicker, type AudioFilePicker } from '@/hooks/useAudioFilePicker'

export interface FileUploadAreaHandle {
  openPicker: () => void
}

interface FileUploadAreaProps {
  variant?: 'compact' | 'hero' | 'landing'
  className?: string
  /** Gemeinsamer Picker (z. B. mit Sticky-CTA auf der Landing). */
  picker?: AudioFilePicker
}

export const FileUploadArea = forwardRef<FileUploadAreaHandle, FileUploadAreaProps>(
  function FileUploadArea({ variant = 'compact', className, picker: externalPicker }, ref) {
    const internalPicker = useAudioFilePicker()
    const picker = externalPicker ?? internalPicker
    const { inputRef, openPicker, handleFiles, accept } = picker

    const [dragging, setDragging] = useState(false)

    useImperativeHandle(ref, () => ({ openPicker }), [openPicker])

    function onDrop(e: React.DragEvent) {
      e.preventDefault()
      setDragging(false)
      handleFiles(e.dataTransfer.files)
    }

    function onDragOver(e: React.DragEvent) {
      e.preventDefault()
      setDragging(true)
    }

    const isHero = variant === 'hero'
    const isLanding = variant === 'landing'

    return (
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        className={cn(
          'w-full flex flex-col rounded-card border-2 border-dashed transition-all duration-300',
          isLanding
            ? 'gap-2.5 p-3.5'
            : isHero
              ? 'items-center gap-5 p-8'
              : 'items-center gap-6 p-10 max-w-sm',
          dragging
            ? 'border-accent bg-accent/10 scale-[1.01] shadow-[0_0_32px_rgba(245,158,11,0.15)]'
            : 'border-card-border hover:border-accent/50',
          className,
        )}
      >
        {isLanding ? (
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                'w-10 h-10 shrink-0 flex items-center justify-center rounded-xl transition-colors',
                dragging ? 'bg-accent/20' : 'bg-card',
              )}
            >
              {dragging ? (
                <Upload size={20} className="text-accent" />
              ) : (
                <Music size={20} className="text-text-secondary" />
              )}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-sm font-medium text-text-primary leading-snug">
                Audio ablegen oder auswählen
              </p>
              <p className="text-[10px] text-text-secondary mt-0.5 leading-snug">
                MP3, WAV, AIFF, FLAC, AAC, M4A, OGG
              </p>
            </div>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'flex items-center justify-center rounded-2xl transition-colors',
                isHero ? 'w-16 h-16' : 'w-20 h-20',
                dragging ? 'bg-accent/20' : 'bg-card',
              )}
            >
              {dragging ? (
                <Upload size={isHero ? 28 : 36} className="text-accent" />
              ) : (
                <Music size={isHero ? 28 : 36} className="text-text-secondary" />
              )}
            </div>

            <div className="text-center space-y-1.5">
              <p className={cn('text-text-primary font-medium', isHero ? 'text-base' : '')}>
                {isHero ? 'Audio hier ablegen oder auswählen' : 'Audio-Datei hier ablegen'}
              </p>
              {!isHero && <p className="text-text-secondary text-sm">oder</p>}
            </div>
          </>
        )}

        <Button
          variant="primary"
          size={isLanding ? 'md' : 'lg'}
          className="w-full"
          onClick={openPicker}
        >
          {isLanding ? 'Datei wählen' : isHero ? 'Jetzt starten — Datei wählen' : 'Datei auswählen'}
        </Button>

        {!isLanding && (
          <p className="text-text-secondary text-xs text-center">
            MP3, WAV, AIFF, FLAC, AAC, M4A, OGG
          </p>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>
    )
  },
)
