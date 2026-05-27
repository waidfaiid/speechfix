import { useRef, useState, useCallback } from 'react'
import { Upload, Music } from 'lucide-react'
import { useFileStore } from '@/store/useFileStore'
import { audioEngine } from '@/audio/AudioEngine'
import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import { isIOS } from '@/utils/mobileAudio'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/Button'

const ACCEPTED_AUDIO = ['.mp3', '.wav', '.aiff', '.flac', '.aac', '.m4a', '.ogg', '.wma']

interface FileUploadAreaProps {
  variant?: 'compact' | 'hero'
  className?: string
}

export function FileUploadArea({ variant = 'compact', className }: FileUploadAreaProps) {
  const addFiles = useFileStore((s) => s.addFiles)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback((files: FileList | File[]) => {
    const audio = Array.from(files).filter(
      (f) =>
        f.type.startsWith('audio/') ||
        ACCEPTED_AUDIO.some((ext) => f.name.toLowerCase().endsWith(ext)),
    )
    if (audio.length > 0) addFiles(audio)
  }, [addFiles])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragging(true)
  }

  function openPicker() {
    audioEngine.init().catch(() => {})
    if (isIOS()) ffmpegManager.load().catch(() => {})
    inputRef.current?.click()
  }

  const isHero = variant === 'hero'

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      className={cn(
        'w-full flex flex-col items-center rounded-card border-2 border-dashed transition-all duration-300',
        isHero ? 'gap-5 p-8' : 'gap-6 p-10 max-w-sm',
        dragging
          ? 'border-accent bg-accent/10 scale-[1.01] shadow-[0_0_32px_rgba(245,158,11,0.15)]'
          : 'border-card-border hover:border-accent/50',
        className,
      )}
    >
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

      <Button variant="primary" size="lg" className="w-full" onClick={openPicker}>
        {isHero ? 'Jetzt starten — Datei wählen' : 'Datei auswählen'}
      </Button>

      <p className="text-text-secondary text-xs text-center">
        MP3, WAV, AIFF, FLAC, AAC, M4A, OGG
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_AUDIO.join(',')}
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />
    </div>
  )
}
