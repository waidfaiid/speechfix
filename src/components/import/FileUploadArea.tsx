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
            ? 'gap-3 p-4 bg-card/25'
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
          <div className="text-center space-y-1">
            <div
              className={cn(
                'mx-auto w-11 h-11 flex items-center justify-center rounded-xl border border-card-border transition-colors',
                dragging ? 'bg-accent/15 border-accent/40' : 'bg-card/80',
              )}
            >
              {dragging ? (
                <Upload size={22} className="text-accent" aria-hidden />
              ) : (
                <Music size={22} className="text-text-secondary" aria-hidden />
              )}
            </div>
            <p className="text-sm font-medium text-text-primary">
              {dragging ? 'Jetzt loslassen …' : 'Audio importieren'}
            </p>
            <p className="text-[10px] text-text-secondary leading-snug">
              Datei wählen oder hier ablegen
            </p>
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
          className={cn(
            'w-full',
            isLanding &&
              'h-11 rounded-xl font-semibold shadow-md shadow-accent/25 active:scale-[0.99] hover:shadow-lg hover:shadow-accent/30',
          )}
          onClick={openPicker}
        >
          {isLanding ? 'Datei wählen' : isHero ? 'Jetzt starten — Datei wählen' : 'Datei auswählen'}
        </Button>

        {isLanding ? (
          <p className="text-[10px] text-text-secondary/90 text-center leading-snug">
            MP3, WAV, AIFF, FLAC, AAC, M4A, OGG
          </p>
        ) : (
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
