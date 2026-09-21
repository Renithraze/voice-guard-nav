/**
 * Browser-side voice feature extraction.
 *
 * Produces a compact speaker embedding from raw microphone audio using an
 * MFCC front-end (pre-emphasis -> framing -> Hamming -> FFT power spectrum ->
 * mel filterbank -> log -> DCT-II) followed by per-coefficient mean/std
 * pooling over voiced frames. Raw audio never leaves the browser; only this
 * vector is sent to the server, where it is encrypted at rest.
 */

export const EMBEDDING_TARGET_RATE = 16000;
const FRAME_SIZE = 400; // 25 ms @ 16 kHz
const FRAME_HOP = 160; // 10 ms
const FFT_SIZE = 512;
const MEL_BANDS = 26;
const MFCC_COEFS = 20; // keep coefficients 1..19 (drop energy term 0)

/* ---------- FFT (iterative radix-2) ---------- */

function fftPowerSpectrum(frame: Float32Array): Float32Array {
  const n = FFT_SIZE;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re.set(frame.subarray(0, Math.min(frame.length, n)));

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  const bins = n / 2 + 1;
  const power = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    power[i] = (re[i]! * re[i]! + im[i]! * im[i]!) / n;
  }
  return power;
}

/* ---------- mel filterbank ---------- */

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function buildMelFilters(sampleRate: number): Float32Array[] {
  const bins = FFT_SIZE / 2 + 1;
  const lowMel = hzToMel(300);
  const highMel = hzToMel(Math.min(8000, sampleRate / 2));
  const points: number[] = [];
  for (let i = 0; i < MEL_BANDS + 2; i++) {
    const mel = lowMel + ((highMel - lowMel) * i) / (MEL_BANDS + 1);
    points.push(Math.floor(((FFT_SIZE + 1) * melToHz(mel)) / sampleRate));
  }

  const filters: Float32Array[] = [];
  for (let m = 1; m <= MEL_BANDS; m++) {
    const f = new Float32Array(bins);
    const left = points[m - 1]!;
    const center = points[m]!;
    const right = points[m + 1]!;
    for (let k = left; k < center; k++) {
      if (k >= 0 && k < bins && center !== left) f[k] = (k - left) / (center - left);
    }
    for (let k = center; k < right; k++) {
      if (k >= 0 && k < bins && right !== center) f[k] = (right - k) / (right - center);
    }
    filters.push(f);
  }
  return filters;
}

/* ---------- resampling ---------- */

export function resampleTo16k(input: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === EMBEDDING_TARGET_RATE) return input;
  const ratio = sampleRate / EMBEDDING_TARGET_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/* ---------- embedding ---------- */

export type EmbeddingResult = {
  vector: number[];
  voicedFrames: number;
  peakLevel: number;
  durationSeconds: number;
};

/**
 * Compute the speaker embedding for mono PCM audio.
 * Returns null when the clip holds too little voiced audio to be usable.
 */
export function computeVoiceEmbedding(
  pcm: Float32Array,
  sampleRate: number,
): EmbeddingResult | null {
  const samples = resampleTo16k(pcm, sampleRate);
  const durationSeconds = samples.length / EMBEDDING_TARGET_RATE;

  let peakLevel = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peakLevel) peakLevel = v;
  }
  if (samples.length < FRAME_SIZE * 4) return null;

  // pre-emphasis
  const emph = new Float32Array(samples.length);
  emph[0] = samples[0]!;
  for (let i = 1; i < samples.length; i++) emph[i] = samples[i]! - 0.97 * samples[i - 1]!;

  const window = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
  }

  const filters = buildMelFilters(EMBEDDING_TARGET_RATE);
  const frames: Float32Array[] = [];
  const energies: number[] = [];

  const buf = new Float32Array(FRAME_SIZE);
  for (let start = 0; start + FRAME_SIZE <= emph.length; start += FRAME_HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = emph[start + i]!;
      energy += s * s;
      buf[i] = s * window[i]!;
    }
    energies.push(energy / FRAME_SIZE);
    frames.push(fftPowerSpectrum(buf));
  }
  if (frames.length === 0) return null;

  // energy-based voice activity detection: keep frames above 12% of the
  // loudest frame, which drops silence and room noise.
  const maxEnergy = Math.max(...energies);
  const energyFloor = Math.max(maxEnergy * 0.12, 1e-6);

  const mfccFrames: Float32Array[] = [];
  const melLogSum = new Float64Array(MEL_BANDS);

  for (let f = 0; f < frames.length; f++) {
    if (energies[f]! < energyFloor) continue;
    const power = frames[f]!;
    const melLog = new Float32Array(MEL_BANDS);
    for (let m = 0; m < MEL_BANDS; m++) {
      const filter = filters[m]!;
      let sum = 0;
      for (let k = 0; k < filter.length; k++) {
        const w = filter[k]!;
        if (w !== 0) sum += w * power[k]!;
      }
      melLog[m] = Math.log(sum + 1e-10);
      melLogSum[m] += melLog[m]!;
    }
    // DCT-II
    const mfcc = new Float32Array(MFCC_COEFS);
    for (let c = 0; c < MFCC_COEFS; c++) {
      let sum = 0;
      for (let m = 0; m < MEL_BANDS; m++) {
        sum += melLog[m]! * Math.cos((Math.PI * c * (m + 0.5)) / MEL_BANDS);
      }
      mfcc[c] = sum;
    }
    mfccFrames.push(mfcc);
  }

  if (mfccFrames.length < 15) return null;

  const coefCount = MFCC_COEFS - 1; // drop c0 (loudness)
  const mean = new Float64Array(coefCount);
  for (const frame of mfccFrames) {
    for (let c = 1; c < MFCC_COEFS; c++) mean[c - 1]! += frame[c]!;
  }
  for (let c = 0; c < coefCount; c++) mean[c] = mean[c]! / mfccFrames.length;

  const std = new Float64Array(coefCount);
  for (const frame of mfccFrames) {
    for (let c = 1; c < MFCC_COEFS; c++) {
      const d = frame[c]! - mean[c - 1]!;
      std[c - 1]! += d * d;
    }
  }
  for (let c = 0; c < coefCount; c++) std[c] = Math.sqrt(std[c]! / mfccFrames.length);

  // mean spectral envelope adds channel/timbre information
  const melMean = new Float64Array(MEL_BANDS);
  for (let m = 0; m < MEL_BANDS; m++) melMean[m] = melLogSum[m]! / mfccFrames.length;

  const raw = [...Array.from(mean), ...Array.from(std), ...Array.from(melMean)];

  // scale each block independently so no block dominates the cosine, then L2-normalize
  const vector = normalizeBlocks(raw, [coefCount, coefCount, MEL_BANDS]);

  return { vector, voicedFrames: mfccFrames.length, peakLevel, durationSeconds };
}

function normalizeBlocks(values: number[], sizes: number[]): number[] {
  const out: number[] = [];
  let offset = 0;
  for (const size of sizes) {
    const block = values.slice(offset, offset + size);
    let norm = 0;
    for (const v of block) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (const v of block) out.push(v / norm);
    offset += size;
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return out.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mix a decoded AudioBuffer down to mono PCM. */
export function audioBufferToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i]! += data[i]! / channels;
  }
  return out;
}
