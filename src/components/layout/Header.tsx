import { AudioLines, Plus } from 'lucide-react'
import { useFileStore } from '@/store/useFileStore'
import { audioEngine } from '@/audio/AudioEngine'
import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import { isIOS } from '@/utils/mobileAudio'
import { useRef } from 'react'

export function Header() {
  const files = useFileStore((s) => s.files)
  const addFiles = useFileStore((s) => s.addFiles)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <header className="flex items-center justify-between px-3 py-4 pt-8 sticky top-0 z-40 bg-background">
      <div>
        <h1 className="font-bold text-xl tracking-tight text-white flex items-center gap-2">
          <div className="relative flex items-center justify-center">
            <AudioLines className="text-accent w-6 h-6" />
          </div> 
          SpeechFix
        </h1>
      </div>

      <button 
        onClick={() => {
          audioEngine.init().catch(() => {})
          if (isIOS()) ffmpegManager.load().catch(() => {})
          inputRef.current?.click()
        }}
        className="bg-card-elevated hover:bg-card-border text-xs px-4 py-2 rounded-full flex items-center gap-2 transition border border-card-border text-white"
      >
        <Plus className="w-3 h-3" /> Dateien
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.aiff,.flac,.aac,.m4a,.ogg"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && addFiles(Array.from(e.target.files))}
      />
    </header>
  )
}
