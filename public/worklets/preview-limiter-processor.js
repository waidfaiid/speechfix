/**
 * Low-latency lookahead limiter for the realtime preview path.
 * Posts peak gain-reduction in dB for the limiter status UI.
 */
class PreviewLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: 0.891251, minValue: 0.1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 50, minValue: 5, maxValue: 500, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this._lookahead = Math.max(1, Math.round(sampleRate * 0.005))
    this._buffers = []
    this._writeIndex = 0
    this._gain = 1
    this._maxReductionDb = 0
    this._blockCounter = 0
  }

  _ensureBuffers(channelCount) {
    while (this._buffers.length < channelCount) {
      this._buffers.push(new Float32Array(this._lookahead))
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || !input[0] || !output || !output[0]) return true

    const numCh = Math.min(input.length, output.length)
    const blockLen = input[0].length
    const ceiling = parameters.ceiling[0]
    const releaseSeconds = parameters.releaseMs[0] / 1000
    const releaseCoef = Math.exp(-1 / (sampleRate * releaseSeconds))

    this._ensureBuffers(numCh)
    let blockPeakReductionDb = 0

    for (let i = 0; i < blockLen; i++) {
      let peak = 0
      for (let ch = 0; ch < numCh; ch++) {
        const sample = input[ch][i]
        this._buffers[ch][this._writeIndex] = sample
        const abs = Math.abs(sample)
        if (abs > peak) peak = abs
      }

      const neededGain = peak > ceiling ? ceiling / peak : 1
      if (neededGain < this._gain) {
        this._gain = neededGain
      } else {
        this._gain = releaseCoef * this._gain + (1 - releaseCoef) * 1
      }

      if (this._gain < 0.9999) {
        const redDb = -20 * Math.log10(this._gain)
        if (redDb > blockPeakReductionDb) blockPeakReductionDb = redDb
      }

      const readIndex = (this._writeIndex + 1) % this._lookahead
      for (let ch = 0; ch < numCh; ch++) {
        const limited = this._buffers[ch][readIndex] * this._gain
        output[ch][i] = Math.max(-ceiling, Math.min(ceiling, limited))
      }

      this._writeIndex = readIndex
    }

    if (blockPeakReductionDb > this._maxReductionDb) {
      this._maxReductionDb = blockPeakReductionDb
    }

    this._blockCounter++
    if (this._blockCounter >= 8) {
      this._blockCounter = 0
      this.port.postMessage({ type: 'reduction', db: this._maxReductionDb })
      this._maxReductionDb = 0
    }

    return true
  }
}

registerProcessor('preview-limiter-processor', PreviewLimiterProcessor)
