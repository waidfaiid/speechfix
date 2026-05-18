/**
 * Dynamic De-Esser AudioWorklet — tuned for close-mic speech (sermons, lectures).
 *
 * Algorithm:
 *   1. Mix input channels to mono and run through a bandpass biquad (sidechain)
 *      centred at the detected sibilance frequency to isolate S-band energy.
 *   2. Follow the sidechain envelope with a very fast attack (1 ms) and a
 *      moderate release (60 ms).  These values are optimal for speech: fast
 *      enough to catch sharp S transients, slow enough to avoid pumping between
 *      words.
 *   3. When the sidechain envelope exceeds `threshold`, compute a gain reduction
 *      in dB using the supplied ratio and hard-cap it at `maxGainReductionDb`.
 *   4. Smooth the resulting gain coefficient (5 ms) to prevent zipper noise,
 *      then apply it identically to all output channels (wideband de-esser).
 *
 * Wideband approach: gain reduction is applied to the full signal, not only the
 * sibilance band.  For speech with a consistent spectral balance this sounds
 * completely transparent — the slight gain dip during an "S" is inaudible as
 * tonal change because it lasts only 30–80 ms.
 *
 * Parameters (all k-rate — sampled once per 128-sample render block):
 *   frequency          Hz    Centre of sidechain bandpass filter (auto from LTAS)
 *   bandwidth          Q     Bandpass Q (fixed 2.5 in engine — not exposed to UI)
 *   threshold          0–1   Linear amplitude above which de-essing starts
 *   ratio              ≥1    Compression ratio above threshold
 *   maxGainReductionDb dB    Hard ceiling on gain reduction (0 = bypass)
 *   enabled            0/1   0 = hard bypass (passthrough)
 */
class DeEsserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency',          defaultValue: 7000,  minValue: 1000,   maxValue: 16000, automationRate: 'k-rate' },
      { name: 'bandwidth',          defaultValue: 2.5,   minValue: 0.5,    maxValue: 10,    automationRate: 'k-rate' },
      { name: 'threshold',          defaultValue: 0.025, minValue: 0.0001, maxValue: 1.0,   automationRate: 'k-rate' },
      { name: 'ratio',              defaultValue: 4,     minValue: 1,      maxValue: 20,    automationRate: 'k-rate' },
      { name: 'maxGainReductionDb', defaultValue: 0,     minValue: 0,      maxValue: 24,    automationRate: 'k-rate' },
      { name: 'enabled',            defaultValue: 0,     minValue: 0,      maxValue: 1,     automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()

    // Bandpass biquad coefficients (sidechain filter)
    this._b0 = this._b1 = this._b2 = 0
    this._a1 = this._a2 = 0
    // Biquad state variables
    this._x1 = this._x2 = this._y1 = this._y2 = 0
    // Cache to avoid recomputing coefficients on every block
    this._lastFreq = -1
    this._lastBw   = -1

    // Peak envelope follower
    this._env = 0
    // 1 ms attack — catches fast sibilant transients without pre-ringing
    this._attackCoef  = Math.exp(-1 / (sampleRate * 0.001))
    // 60 ms release — natural recovery, no pumping between words
    this._releaseCoef = Math.exp(-1 / (sampleRate * 0.060))

    // Gain smoothing (5 ms) to prevent audible zipper noise on fast gain changes
    this._gainSmooth     = 1.0
    this._gainSmoothCoef = Math.exp(-1 / (sampleRate * 0.005))
  }

  /** Recompute bandpass biquad coefficients when frequency or bandwidth changes. */
  _updateBandpass(freq, bw) {
    if (freq === this._lastFreq && bw === this._lastBw) return
    this._lastFreq = freq
    this._lastBw   = bw

    const w0    = 2 * Math.PI * freq / sampleRate
    const sinW  = Math.sin(w0)
    const cosW  = Math.cos(w0)
    const alpha = sinW / (2 * bw)
    const a0    = 1 + alpha

    this._b0 =  alpha / a0
    this._b1 =  0
    this._b2 = -alpha / a0
    this._a1 = -2 * cosW / a0
    this._a2 = (1 - alpha) / a0

    // Reset filter memory and envelope to prevent startup artefacts
    this._x1 = this._x2 = this._y1 = this._y2 = 0
    this._env = 0
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0]
    const output = outputs[0]
    if (!input || !input[0] || !output || !output[0]) return true

    const numCh    = Math.min(input.length, output.length)
    const blockLen = input[0].length

    // Hard bypass: copy input to output unchanged
    if (parameters.enabled[0] < 0.5) {
      for (let ch = 0; ch < numCh; ch++) output[ch].set(input[ch])
      return true
    }

    const freq      = parameters.frequency[0]
    const bw        = parameters.bandwidth[0]
    const threshold = parameters.threshold[0]
    const ratio     = parameters.ratio[0]
    const maxRedDb  = parameters.maxGainReductionDb[0]

    this._updateBandpass(freq, bw)

    const ac  = this._attackCoef
    const rc  = this._releaseCoef
    const gsc = this._gainSmoothCoef
    // Precompute 20/ln(10) for the dB conversion inside the sample loop
    const log10factor = 20 * Math.LOG10E

    for (let i = 0; i < blockLen; i++) {
      // --- Sidechain: mix all channels to mono ---
      let mono = 0
      for (let ch = 0; ch < numCh; ch++) mono += input[ch][i]
      mono /= numCh

      // --- Bandpass biquad (isolates sibilance frequency band) ---
      const sc = this._b0 * mono
               + this._b2 * this._x2
               - this._a1 * this._y1
               - this._a2 * this._y2
      this._x2 = this._x1; this._x1 = mono
      this._y2 = this._y1; this._y1 = sc

      // --- Peak envelope follower (asymmetric attack/release) ---
      const scAbs = Math.abs(sc)
      this._env = scAbs > this._env
        ? ac * this._env + (1 - ac) * scAbs   // fast attack
        : rc * this._env + (1 - rc) * scAbs   // slow release

      // --- Gain computation ---
      let targetGain = 1.0
      if (this._env > threshold && threshold > 0) {
        // How many dB above threshold is the sidechain envelope?
        const overDb      = log10factor * Math.log(this._env / threshold)
        // Gain reduction at this ratio, capped at maxGainReductionDb
        const reductionDb = Math.min(overDb * (1 - 1 / ratio), maxRedDb)
        targetGain = Math.pow(10, -reductionDb / 20)
      }

      // --- Smooth gain to prevent zipper noise ---
      this._gainSmooth = gsc * this._gainSmooth + (1 - gsc) * targetGain

      // --- Apply gain identically to all channels ---
      const g = this._gainSmooth
      for (let ch = 0; ch < numCh; ch++) {
        output[ch][i] = input[ch][i] * g
      }
    }

    return true
  }
}

registerProcessor('de-esser-processor', DeEsserProcessor)
