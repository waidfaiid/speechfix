import { useRef, useCallback, type RefObject } from 'react'
import { useFileStore } from '@/store/useFileStore'
import { audioEngine } from '@/audio/AudioEngine'
import { ffmpegManager } from '@/audio/ffmpeg/FFmpegManager'
import { isIOS } from '@/utils/mobileAudio'

const ACCEPTED_AUDIO = ['.mp3', '.wav', '.aiff', '.flac', '.aac', '.m4a', '.ogg', '.wma']

export function useAudioFilePicker() {
  const addFiles = useFileStore((s) => s.addFiles)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback((files: FileList | File[]) => {
    const audio = Array.from(files).filter(
      (f) =>
        f.type.startsWith('audio/') ||
        ACCEPTED_AUDIO.some((ext) => f.name.toLowerCase().endsWith(ext)),
    )
    if (audio.length > 0) addFiles(audio)
  }, [addFiles])

  const openPicker = useCallback(() => {
    audioEngine.init().catch(() => {})
    if (isIOS()) ffmpegManager.load().catch(() => {})
    inputRef.current?.click()
  }, [])

  return { inputRef, openPicker, handleFiles, accept: ACCEPTED_AUDIO.join(',') }
}

export type AudioFilePicker = ReturnType<typeof useAudioFilePicker>

export function mergeRefs<T>(...refs: (RefObject<T | null> | ((el: T | null) => void) | null | undefined)[]) {
  return (el: T | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(el)
      else ref.current = el
    }
  }
}
