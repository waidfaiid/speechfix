import { create } from 'zustand'
import type { AudioAnalysis, AudioContextState } from '@/types/audio.types'

interface AudioStore {
  contextState: AudioContextState
  isPlaying: boolean
  currentTime: number
  duration: number
  isLoading: boolean
  /** True while a playback chunk is being decoded (chunked mode on iOS). */
  isChunkLoading: boolean
  analysis: AudioAnalysis | null
  abMode: 'original' | 'processed'
  ffmpegLoaded: boolean
  ffmpegLoadProgress: number
  trimStart: number
  trimEnd: number | null

  setContextState: (s: AudioContextState) => void
  setIsPlaying: (v: boolean) => void
  setCurrentTime: (t: number) => void
  setDuration: (d: number) => void
  setIsLoading: (v: boolean) => void
  setIsChunkLoading: (v: boolean) => void
  setAnalysis: (a: AudioAnalysis | null) => void
  setAbMode: (m: 'original' | 'processed') => void
  setFfmpegLoaded: (v: boolean) => void
  setFfmpegLoadProgress: (p: number) => void
  setTrimStart: (t: number) => void
  setTrimEnd: (t: number | null) => void
}

export const useAudioStore = create<AudioStore>((set) => ({
  contextState: 'uninitialized',
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  isLoading: false,
  isChunkLoading: false,
  analysis: null,
  abMode: 'processed',
  ffmpegLoaded: false,
  ffmpegLoadProgress: 0,
  trimStart: 0,
  trimEnd: null,

  setContextState: (s) => set({ contextState: s }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setCurrentTime: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d }),
  setIsLoading: (v) => set({ isLoading: v }),
  setIsChunkLoading: (v) => set({ isChunkLoading: v }),
  setAnalysis: (a) => set({ analysis: a }),
  setAbMode: (m) => set({ abMode: m }),
  setFfmpegLoaded: (v) => set({ ffmpegLoaded: v }),
  setFfmpegLoadProgress: (p) => set({ ffmpegLoadProgress: p }),
  setTrimStart: (t) => set({ trimStart: t }),
  setTrimEnd: (t) => set({ trimEnd: t }),
}))
