import { useRef, useState, useCallback } from 'react'
import { Upload, Music } from 'lucide-react'
import { useFileStore } from '@/store/useFileStore'
import { audioEngine } from '@/audio/AudioEngine'
import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import { isIOS } from '@/utils/mobileAudio'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/Button'

const ACCEPTED = ['.mp3', '.wav', '.aiff', '.flac', '.aac', '.m4a', '.ogg', '.wma']

export function DropZone() {
  const addFiles = useFileStore((s) => s.addFiles)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback((files: FileList | File[]) => {
    const audio = Array.from(files).filter((f) =>
      f.type.startsWith('audio/') || ACCEPTED.some((ext) => f.name.toLowerCase().endsWith(ext)),
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

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        className={cn(
          'w-full max-w-sm flex flex-col items-center gap-6 p-10 rounded-card border-2 border-dashed transition-colors',
          dragging
            ? 'border-accent bg-accent/10'
            : 'border-card-border hover:border-accent/50',
        )}
      >
        <div className={cn(
          'flex items-center justify-center w-20 h-20 rounded-2xl transition-colors',
          dragging ? 'bg-accent/20' : 'bg-card',
        )}>
          {dragging ? (
            <Upload size={36} className="text-accent" />
          ) : (
            <Music size={36} className="text-text-secondary" />
          )}
        </div>

        <div className="text-center space-y-2">
          <p className="text-text-primary font-medium">
            Audio-Datei hier ablegen
          </p>
          <p className="text-text-secondary text-sm">oder</p>
        </div>

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={() => {
            // iOS Safari requires AudioContext.resume() to be called synchronously
            // inside a user-gesture handler. Pre-initialising here (before the file
            // picker opens) ensures the context is running by the time loadFile()
            // calls decodeAudioData(). Without this the context stays suspended and
            // decodeAudioData() silently hangs on iPhone.
            audioEngine.init().catch(() => {})
            if (isIOS()) ffmpegManager.load().catch(() => {})
            inputRef.current?.click()
          }}
        >
          Datei auswählen
        </Button>

        <p className="text-text-secondary text-xs text-center">
          MP3, WAV, AIFF, FLAC, AAC, M4A, OGG
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(',')}
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>
    </div>
  )
}
