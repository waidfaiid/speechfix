/**
 * Triggers LTAS analysis whenever the active file changes.
 *
 * Flow:
 *  1. File changes → run analyzeLTAS() on the full file (non-blocking)
 *  2. On completion → run computeEQCorrection() → write new eqBands to store
 *  3. Detect sibilance peak (5–12 kHz) and auto-set desibilanceFreq.
 *     If the recording has >3 dB excess energy at the sibilance peak vs. the
 *     reference, automatically enable the de-esser at 40% amount.
 *  4. Show a toast confirming the update
 *  5. On error → set status to 'error' and show a toast
 */

import { useEffect, useRef } from 'react'
import { useFileStore } from '@/store/useFileStore'
import { useProcessingStore } from '@/store/useProcessingStore'
import { useUIStore } from '@/store/useUIStore'
import { analyzeLTAS } from '@/audio/analysis/LTASAnalyzer'
import { computeEQCorrection } from '@/utils/eqMatcher'
import { normalizeLTAS, freqToGridIndex, gridFreq } from '@/utils/speechReferenceLTAS'

const SIBILANCE_LO_HZ = 5000
const SIBILANCE_HI_HZ = 12000
/** Minimum excess over reference to auto-enable the de-esser */
const AUTO_ENABLE_THRESHOLD_DB = 3

/**
 * Find the frequency (Hz) in the sibilance range where the measured LTAS
 * exceeds the reference LTAS the most.
 * Returns { freq, excess } where excess is in dB (positive = too bright).
 */
function detectSibilancePeak(
  measuredLTAS: Float32Array,
  referenceLTAS: Float32Array,
): { freq: number; excess: number } {
  const measured  = normalizeLTAS(measuredLTAS)
  const reference = normalizeLTAS(referenceLTAS)

  const lo = freqToGridIndex(SIBILANCE_LO_HZ)
  const hi = freqToGridIndex(SIBILANCE_HI_HZ)

  let maxExcess = -Infinity
  let bestIdx = Math.round((lo + hi) / 2)

  for (let i = lo; i <= hi; i++) {
    const excess = measured[i] - reference[i]
    if (excess > maxExcess) { maxExcess = excess; bestIdx = i }
  }

  return { freq: Math.round(gridFreq(bestIdx)), excess: maxExcess }
}

export function useLTASAnalysis() {
  const activeFile = useFileStore((s) => s.getActiveFile())
  const {
    referenceLTAS,
    eqBands,
    setMeasuredLTAS,
    setEqBands,
    setAnalysisStatus,
    setAnalysisProgress,
    setDesibilanceFreq,
    setDesibilanceEnabled,
    setDesibilanceAmount,
  } = useProcessingStore()
  const addToast = useUIStore((s) => s.addToast)

  const eqBandsRef = useRef(eqBands)
  useEffect(() => { eqBandsRef.current = eqBands }, [eqBands])

  const referenceLTASRef = useRef(referenceLTAS)

  useEffect(() => {
    if (!activeFile) {
      setMeasuredLTAS(null)
      setAnalysisStatus('idle')
      return
    }

    let cancelled = false

    async function run() {
      setAnalysisStatus('running')
      setAnalysisProgress(0)
      setMeasuredLTAS(null)

      try {
        const ltas = await analyzeLTAS(activeFile!.file, (p) => {
          if (!cancelled) setAnalysisProgress(p)
        })

        if (cancelled) return

        setMeasuredLTAS(ltas)

        // EQ matching
        const correctedBands = computeEQCorrection(
          ltas,
          referenceLTASRef.current,
          eqBandsRef.current
        )

        if (cancelled) return
        setEqBands(correctedBands)

        // Sibilance detection
        const { freq, excess } = detectSibilancePeak(ltas, referenceLTASRef.current)
        setDesibilanceFreq(freq)

        if (excess > AUTO_ENABLE_THRESHOLD_DB) {
          // Scale auto-amount: 3 dB excess → 30%, 6 dB → 60%, capped at 80%
          const autoAmount = Math.min(0.8, (excess - AUTO_ENABLE_THRESHOLD_DB) / 10 + 0.3)
          setDesibilanceEnabled(true)
          setDesibilanceAmount(parseFloat(autoAmount.toFixed(2)))
          setAnalysisStatus('done')
          addToast(`Klang-Korrektur & Zischen erkannt (${Math.round(freq / 100) / 10} kHz) ✓`, 'success')
        } else {
          setDesibilanceEnabled(false)
          setDesibilanceAmount(0)
          setAnalysisStatus('done')
          addToast('Klang-Korrektur berechnet ✓', 'success')
        }
      } catch (err) {
        if (cancelled) return
        console.error('LTAS analysis failed:', err)
        setAnalysisStatus('error')
        addToast('Klang-Analyse fehlgeschlagen', 'error')
      }
    }

    run()

    return () => { cancelled = true }
  // Re-run only when the active file identity changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.id])
}
