// =============================================================================
// Built-in beat tracker — no external runtime, no Python.
//
// Same algorithm family as the librosa tracker it replaces:
//   PCM → STFT (2048 / hop, periodic Hann, centered) → Slaney mel power
//       → log-amplitude spectral-flux onset envelope
//       → tempo via autocorrelation + log-normal prior (centred on 120 BPM)
//       → dynamic-programming beat sequence (Ellis 2007)
//       → beats snapped to local onset maxima, weak edge beats trimmed
//
// Output shape matches the analyzer JSON that parseAnalyzerOutput() expects.
// =============================================================================

export const ANALYZER_NAME = "twio.spectral-flux-dp";
export const ANALYZER_VERSION = "1";

const N_FFT = 2048;
const N_BINS = N_FFT / 2 + 1;
const N_MELS = 128;
const TOP_DB = 80;
const MIN_POWER = 1e-10;
const TIGHTNESS = 100;
const MIN_BPM = 40;
const MAX_BPM = 320;
const START_BPM = 120;
const STD_BPM = 1;

// --- FFT (iterative radix-2, in-place, real input packed as complex) ---------

const N_BITS = Math.log2(N_FFT);
const fftRev = new Uint32Array(N_FFT);
const fftCos = new Float32Array(N_FFT / 2);
const fftSin = new Float32Array(N_FFT / 2);
for (let i = 0; i < N_FFT; i++) {
  fftRev[i] = (i === 0 ? 0 : fftRev[i >> 1]! >> 1) | ((i & 1) << (N_BITS - 1));
}
for (let k = 0; k < N_FFT / 2; k++) {
  const a = (-2 * Math.PI * k) / N_FFT;
  fftCos[k] = Math.cos(a);
  fftSin[k] = Math.sin(a);
}

function fftInPlace(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < N_FFT; i++) {
    const j = fftRev[i]!;
    if (j > i) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= N_FFT; len <<= 1) {
    const half = len >> 1;
    const step = N_FFT / len;
    for (let i = 0; i < N_FFT; i += len) {
      for (let k = 0; k < half; k++) {
        const c = fftCos[k * step]!;
        const s = fftSin[k * step]!;
        const a = i + k;
        const b = a + half;
        const tr = re[b]! * c - im[b]! * s;
        const ti = re[b]! * s + im[b]! * c;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

// Periodic Hann window (librosa/scipy fftbins convention).
const HANN = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

// --- Slaney mel filterbank (librosa default: slaney scale + area norm) -------

const MEL_LIN_HZ = 1000;
const MEL_FSP = 200 / 3; // 66.67 Hz per mel below 1 kHz
const MEL_LOG_STEP = Math.log(6.4) / 27; // slaney log slope above 1 kHz
const MEL_LIN_MEL = MEL_LIN_HZ / MEL_FSP; // 15

const hzToMel = (f: number): number =>
  f < MEL_LIN_HZ ? f / MEL_FSP : MEL_LIN_MEL + Math.log(f / MEL_LIN_HZ) / MEL_LOG_STEP;
const melToHz = (m: number): number =>
  m < MEL_LIN_MEL ? m * MEL_FSP : MEL_LIN_HZ * Math.exp(MEL_LOG_STEP * (m - MEL_LIN_MEL));

interface MelBand {
  bin: Uint32Array; // FFT bin indices with nonzero weight
  w: Float32Array; // corresponding weights
}

let melCache: { sampleRate: number; bands: MelBand[] } | null = null;

function buildMelBands(sampleRate: number): MelBand[] {
  if (melCache && melCache.sampleRate === sampleRate) return melCache.bands;
  const edgeMel = (i: number) => (hzToMel(sampleRate / 2) * i) / (N_MELS + 1);
  const edges = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(edgeMel(i)));
  const binHz = (k: number) => (k * sampleRate) / N_FFT;
  const bands: MelBand[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const lo = edges[m]!;
    const ctr = edges[m + 1]!;
    const hi = edges[m + 2]!;
    const enorm = 2 / (hi - lo); // slaney area normalisation
    const idx: number[] = [];
    const wts: number[] = [];
    for (let k = 0; k < N_BINS; k++) {
      const f = binHz(k);
      if (f <= lo || f >= hi) continue;
      const w = (f <= ctr ? (f - lo) / (ctr - lo || 1) : (hi - f) / (hi - ctr || 1)) * enorm;
      if (w > 0) {
        idx.push(k);
        wts.push(w);
      }
    }
    bands.push({ bin: Uint32Array.from(idx), w: Float32Array.from(wts) });
  }
  melCache = { sampleRate, bands };
  return bands;
}

// --- Onset envelope ----------------------------------------------------------
// Mean over mel bands of the positive first difference of the log-amplitude
// spectrum (lag = 1), matching librosa.onset.onset_strength's default path.

function onsetEnvelope(samples: Float32Array, sampleRate: number, hop: number): Float32Array {
  const n = samples.length;
  const pad = N_FFT >> 1;
  const nFrames = 1 + Math.floor(n / hop);
  const bands = buildMelBands(sampleRate);
  const mel = new Float32Array(nFrames * N_MELS);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  let globalMax = MIN_POWER;

  // Reflect-pad the signal once (center=True, edges excluded like np.pad
  // 'reflect'), so frame extraction is a plain windowed copy.
  const padded = new Float32Array(n + 2 * pad);
  padded.set(samples, pad);
  for (let k = 1; k <= pad; k++) {
    padded[pad - k] = samples[Math.min(k, n - 1)]!;
    padded[pad + n - 1 + k] = samples[Math.max(0, n - 1 - k)]!;
  }

  for (let t = 0; t < nFrames; t++) {
    const base = t * hop;
    im.fill(0);
    for (let j = 0; j < N_FFT; j++) re[j] = padded[base + j]! * HANN[j]!;
    fftInPlace(re, im);
    const row = t * N_MELS;
    for (let m = 0; m < N_MELS; m++) {
      const b = bands[m]!;
      let p = 0;
      for (let q = 0; q < b.bin.length; q++) {
        const k = b.bin[q]!;
        p += b.w[q]! * (re[k]! * re[k]! + im[k]! * im[k]!);
      }
      mel[row + m] = p;
      if (p > globalMax) globalMax = p;
    }
  }

  const floorDb = 10 * Math.log10(globalMax) - TOP_DB;
  const db = (p: number): number => Math.max(10 * Math.log10(Math.max(p, MIN_POWER)), floorDb);
  const env = new Float32Array(nFrames);
  for (let t = 1; t < nFrames; t++) {
    const row = t * N_MELS;
    const prev = row - N_MELS;
    let sum = 0;
    for (let m = 0; m < N_MELS; m++) {
      const d = db(mel[row + m]!) - db(mel[prev + m]!);
      if (d > 0) sum += d;
    }
    env[t] = sum / N_MELS;
  }
  return env;
}

// --- Tempo -------------------------------------------------------------------
// Mean-subtracted autocorrelation over the onset envelope, weighted by a
// log-normal tempo prior centred on START_BPM (librosa.feature.tempo prior).

function estimateTempo(env: Float32Array, fps: number): number {
  const n = env.length;
  const lagMin = Math.max(1, Math.floor((60 * fps) / MAX_BPM));
  const lagMax = Math.min(n - 1, Math.ceil((60 * fps) / MIN_BPM));
  if (lagMax < lagMin) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i]!;
  mean /= n;

  let bestBpm = 0;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let ac = 0;
    for (let t = 0; t + lag < n; t++) ac += (env[t]! - mean) * (env[t + lag]! - mean);
    ac /= n - lag;
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / START_BPM) / STD_BPM) ** 2);
    const score = ac * prior;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return bestScore > 0 ? bestBpm : 0;
}

// --- Dynamic-programming beat sequence ---------------------------------------
// Ellis (2007): each beat inherits the score of the best predecessor inside
// [0.5·period, 2·period] back, penalised by a quadratic in log-spacing.

function trackBeats(env: Float32Array, fps: number, bpm: number): number[] {
  const n = env.length;
  const period = (60 * fps) / bpm;
  let envMax = 0;
  for (let i = 0; i < n; i++) if (env[i]! > envMax) envMax = env[i]!;
  if (envMax <= 0 || period < 1) return [];
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) local[i] = env[i]! / envMax;

  const kMin = Math.max(1, Math.round(0.5 * period));
  const kMax = Math.max(kMin, Math.round(2 * period));
  const txwt = new Float32Array(kMax + 1);
  for (let k = kMin; k <= kMax; k++) txwt[k] = -TIGHTNESS * Math.log(k / period) ** 2;

  const cum = new Float32Array(n);
  const backlink = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bestJ = -1;
    for (let k = kMin; k <= kMax; k++) {
      const j = i - k;
      if (j < 0) break;
      const s = cum[j]! + txwt[k]!;
      if (s > best) {
        best = s;
        bestJ = j;
      }
    }
    cum[i] = local[i]! + (bestJ >= 0 ? best : 0);
    backlink[i] = bestJ;
  }

  // Best endpoint: highest cumulative score in the final beat period.
  let bestEnd = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) {
    if (cum[i]! > cum[bestEnd]!) bestEnd = i;
  }

  const frames: number[] = [];
  for (let f = bestEnd; f >= 0; f = backlink[f]!) frames.push(f);
  frames.reverse();

  // Snap each beat to the local onset maximum within ±10% of the period.
  const w = Math.max(1, Math.round(period * 0.1));
  const snapped = frames.map((f) => {
    let b = f;
    for (let i = Math.max(0, f - w); i <= Math.min(n - 1, f + w); i++) {
      if (env[i]! > env[b]!) b = i;
    }
    return b;
  });
  const beats = [...new Set(snapped)].sort((a, b) => a - b);

  // Trim leading/trailing beats too weak relative to the median beat strength.
  if (beats.length > 2) {
    const strengths = beats.map((f) => env[f]! / envMax).sort((a, b) => a - b);
    const med = strengths[Math.floor(strengths.length / 2)]!;
    const thresh = 0.5 * med;
    while (beats.length > 2 && env[beats[0]!]! / envMax < thresh) beats.shift();
    while (beats.length > 2 && env[beats[beats.length - 1]!]! / envMax < thresh) beats.pop();
  }
  return beats;
}

// --- Public API ----------------------------------------------------------------

export interface BuiltinBeatAnalysis {
  bpm: number;
  duration: number;
  beats: Array<{ time: number; strength: number }>;
  downbeats: null;
  analyzer: { name: string; version: string; sampleRate: number; hopLength: number };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Analyse decoded mono PCM (float32) and return the analyzer result object. */
export function analyzePcm(samples: Float32Array, sampleRate: number, hopLength: number): BuiltinBeatAnalysis {
  const duration = samples.length / sampleRate;
  const out = (bpm: number, frames: number[], env: Float32Array | null): BuiltinBeatAnalysis => {
    let envMax = 1;
    if (env) for (const v of env) if (v > envMax) envMax = v;
    return {
      bpm: Math.round(bpm * 1000) / 1000,
      duration: round6(duration),
      beats: frames.map((f) => ({
        time: round6((f * hopLength) / sampleRate),
        strength: env ? Math.round((env[f]! / envMax) * 10000) / 10000 : 0,
      })),
      downbeats: null,
      analyzer: { name: ANALYZER_NAME, version: ANALYZER_VERSION, sampleRate, hopLength },
    };
  };

  if (!samples.length || sampleRate <= 0) return out(0, [], null);
  const env = onsetEnvelope(samples, sampleRate, hopLength);
  const bpm = estimateTempo(env, sampleRate / hopLength);
  if (bpm <= 0) return out(0, [], env);
  return out(bpm, trackBeats(env, sampleRate / hopLength, bpm), env);
}
