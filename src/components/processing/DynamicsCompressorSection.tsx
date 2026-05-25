import { Activity } from 'lucide-react'
import { useProcessingStore } from '@/store/useProcessingStore'
import { ProcessingSlider } from './ProcessingSlider'
import { DynamicsScale } from './DynamicsScale'

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
    <ProcessingSlider
      label="Dynamik / Kompressor"
      icon={<Activity size={16} />}
      value={store.compressionAmount}
      onChange={store.setCompressionAmount}
      enabled={store.compressionEnabled}
      onToggle={store.setCompressionEnabled}
      displayValue={`${Math.round(store.compressionAmount * 100)}%`}
      title={compressionStage2Tooltip(store.compressionAmount, isMixed)}
    >
      <DynamicsScale
        originalDb={store.originalDynamicsDb}
        processedDb={store.processedDynamicsDb}
        showProcessed={showProcessed}
      />
    </ProcessingSlider>
  )
}
