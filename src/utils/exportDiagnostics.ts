const STORAGE_KEY = 'speechfix_export_diag'

interface DiagEntry {
  ts: number
  step: string
  memMB?: number
  detail?: string
}

interface DiagLog {
  started: number
  finished?: number
  userAgent: string
  fileSize: number
  fileName: string
  duration?: number
  entries: DiagEntry[]
}

let current: DiagLog | null = null

function heapMB(): number | undefined {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
  if (perf.memory?.usedJSHeapSize) {
    return Math.round(perf.memory.usedJSHeapSize / 1024 / 1024)
  }
  return undefined
}

function save() {
  if (!current) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch { /* quota exceeded — ignore */ }
}

export function diagStart(fileName: string, fileSize: number, duration?: number) {
  current = {
    started: Date.now(),
    userAgent: navigator.userAgent,
    fileSize,
    fileName,
    duration,
    entries: [],
  }
  diagStep('export_start', `file=${fileName} size=${(fileSize / 1024 / 1024).toFixed(1)}MB dur=${duration?.toFixed(1) ?? '?'}s`)
}

export function diagStep(step: string, detail?: string) {
  if (!current) return
  current.entries.push({ ts: Date.now(), step, memMB: heapMB(), detail })
  save()
}

export function diagEnd() {
  if (!current) return
  current.finished = Date.now()
  diagStep('export_complete')
  save()
  current = null
}

export function diagError(error: unknown) {
  if (!current) return
  diagStep('export_error', String(error))
  save()
  current = null
}

export function getCrashLog(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const log: DiagLog = JSON.parse(raw)
    if (log.finished) return null

    const lines: string[] = [
      '=== SpeechFix Export Crash Log ===',
      `UA: ${log.userAgent}`,
      `File: ${log.fileName} (${(log.fileSize / 1024 / 1024).toFixed(1)} MB)`,
      `Duration: ${log.duration?.toFixed(1) ?? 'unknown'}s`,
      `Started: ${new Date(log.started).toLocaleTimeString()}`,
      '',
    ]

    for (const e of log.entries) {
      const t = ((e.ts - log.started) / 1000).toFixed(2)
      const mem = e.memMB != null ? ` [heap=${e.memMB}MB]` : ''
      const det = e.detail ? ` — ${e.detail}` : ''
      lines.push(`+${t}s  ${e.step}${mem}${det}`)
    }

    lines.push('')
    lines.push(`Crashed after: ${((Date.now() - log.started) / 1000).toFixed(1)}s (page reloaded)`)
    return lines.join('\n')
  } catch {
    return null
  }
}

export function clearCrashLog() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
