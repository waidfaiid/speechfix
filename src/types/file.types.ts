export type FileStatus =
  | 'pending'
  | 'reference'
  | 'queued'
  | 'processing'
  | 'done'
  | 'error'

export interface BatchFile {
  id: string
  file: File
  name: string
  duration: number
  status: FileStatus
  outputBlob?: Blob
  waveformData?: Float32Array
  lufs?: number
  error?: string
  /** Sample rate of the decoded audio buffer (from AudioContext) */
  originalSampleRate?: number
}

export interface ExportProgress {
  fileId: string
  fileName: string
  fileIndex: number
  totalFiles: number
  stepProgress: number
  stepLabel: string
  estimatedSecondsLeft: number
  startedAt?: number
}
