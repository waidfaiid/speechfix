import { Activity } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { ProcessingSlider } from './ProcessingSlider'
import { DynamicsScale, ORIGINAL_COLOR, PROCESSED_COLOR } from './DynamicsScale'
import { cn } from '@/utils/cn'

function compressionStage2Tooltip(amount: number, isMixed: boolean): string {
  const ratio = (2 + amount * 3).toFixed(1)
  const threshold = (-14 - amount * 18 + (isMixed ? 6 : 0)).toFixed(0)
  const s1ratio = (isMixed ? 1 + amount * 3 : 1 + amount * 11).toFixed(1)
  const s1threshold = isMixed ? -4 : -8
  return `Stufe 2 · Threshold ${threshold} dBFS · Ratio ${ratio}:1 · Stufe 1: Peak-Catcher ${s1threshold} dBFS, ${s1ratio}:1`
}

export function DynamicsCompressorSection() {
  const store = useProcessingStore()
  const isMixed = store.contentType === 'mixed'
  const showProcessed = store.compressionEnabled && store.processedDynamicsDb > 0

  return (
    <div className="space-y-4">
      <ProcessingSlider
        label="Dynamik / Kompressor"
        icon={<Activity size={16} />}
        value={store.compressionAmount}
        onChange={store.setCompressionAmount}
        enabled={store.compressionEnabled}
        onToggle={store.setCompressionEnabled}
        displayValue={`${Math.round(store.compressionAmount * 100)}%`}
        title={compressionStage2Tooltip(store.compressionAmount, isMixed)}
      />

      {/* Stats — above the scale, color-matched to markers */}
      <div className="flex items-center gap-2 text-[11px] font-semibold leading-none">
        {/* Original swatch + label */}
        <span
          className="inline-block w-2 h-2 rounded-sm shrink-0"
          style={{ backgroundColor: ORIGINAL_COLOR, boxShadow: `0 0 4px ${ORIGINAL_COLOR}` }}
        />
        <span style={{ color: ORIGINAL_COLOR }}>
          Original:{' '}
          <span className="tabular-nums">{store.originalDynamicsDb.toFixed(1)} dB</span>
        </span>

        {showProcessed && (
          <>
            <span className="text-text-secondary font-normal">·</span>
            <span
              className="inline-block w-2 h-2 rounded-sm shrink-0"
              style={{ backgroundColor: PROCESSED_COLOR, boxShadow: `0 0 4px ${PROCESSED_COLOR}` }}
            />
            <span style={{ color: PROCESSED_COLOR }}>
              Komprimiert:{' '}
              <span className="tabular-nums">{store.processedDynamicsDb.toFixed(1)} dB</span>
            </span>
          </>
        )}
      </div>

      <DynamicsScale
        originalDb={store.originalDynamicsDb}
        processedDb={store.processedDynamicsDb}
        showProcessed={showProcessed}
      />
    </div>
  )
}
