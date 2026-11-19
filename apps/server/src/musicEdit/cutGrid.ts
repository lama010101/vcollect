// =============================================================================
// Cut grid — pure, deterministic builders that turn a grid *spec* into the
// inner cut marks (time + beat index + boundary kind) the EDL planner
// consumes. No I/O, no ffmpeg: every analysis product the grids need
// (detected beats, stem onset peaks, energy sections) arrives through
// CutGridContext, so the whole module is unit-testable on synthetic data.
// =============================================================================

import type { BeatPoint, CutGridSpec, CutMark, EdlBoundaryKind } from "@twio/shared";
import { MusicEditError } from "./errors.js";

export type { CutMark };

export interface OnsetPeak {
  time: number; // seconds
  strength: number; // 0..1 relative to the envelope maximum
}

export type SectionClass = "quiet" | "medium" | "loud";

export interface EnergySection {
  start: number; // seconds
  end: number; // seconds
  /** Mean window RMS normalised by the song's 90th-percentile RMS. */
  energy: number;
  cls: SectionClass;
}

export interface CutGridContext {
  /** Detected beats (time + onset strength) — needed by every source except
   *  pure stem onsets, which cut on the stem's own peaks. */
  beats: BeatPoint[];
  audioDuration: number;
  /** Peak-picked onset times of the chosen stem — required for stem_onsets. */
  onsetPeaks?: OnsetPeak[];
  /** RMS-energy sections of the song — required for sections, and reused by
   *  adaptive for quiet<->loud structural hits. */
  sections?: EnergySection[];
  /** Raw song intensity features — required for adaptive. */
  adaptive?: AdaptiveFeatures;
}

/** One windowed-RMS frame on the ~0.25 s intensity timeline. */
export interface RmsWindow {
  start: number; // seconds
  end: number; // seconds
  rms: number; // raw windowed RMS (not normalised)
}

/** Raw song features the adaptive grid maps onto a cut ladder — cached by
 *  the service (decode + STFT are the expensive parts; every mapping param
 *  is applied afterwards in pure code). */
export interface AdaptiveFeatures {
  /** Full-band onset envelope of the SONG (frame-spaced). */
  onsetEnv: ArrayLike<number>;
  envSampleRate: number;
  envHop: number;
  /** Windowed RMS series on the ~0.25 s intensity timeline. */
  windows: RmsWindow[];
}

export type AdaptiveSpec = Extract<CutGridSpec, { source: "adaptive" }>;

export interface BuiltCutGrid {
  marks: CutMark[];
  label: string; // human-readable, shown in the UI + stamped on the plan
  detail?: string;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function invalidGrid(message: string): MusicEditError {
  return new MusicEditError(400, "INVALID_GRID", message);
}

// --- Every N beats -------------------------------------------------------------

/** Cuts on beat indices offset, offset+n, offset+2n… — the same phase
 *  convention the legacy beatsPerCut/beatOffset settings used. */
export function everyNBeatsMarks(beatTimes: number[], n: number, offset = 0): CutMark[] {
  if (!Number.isInteger(n) || n < 1) throw invalidGrid(`beats-per-cut must be a positive integer (got ${n}).`);
  if (!Number.isInteger(offset) || offset < 0) throw invalidGrid(`beat offset must be a non-negative integer (got ${offset}).`);
  const marks: CutMark[] = [];
  for (let i = offset; i < beatTimes.length; i += n) {
    marks.push({ time: beatTimes[i]!, beat: i, kind: "beat" });
  }
  return marks;
}

// --- Bars / downbeats ----------------------------------------------------------

/** The beat phase (residue mod beatsPerBar) whose summed onset strength is
 *  highest — a simple, deterministic bar-phase estimate. Ties resolve to
 *  the lowest phase. */
export function pickBarPhase(beats: BeatPoint[], beatsPerBar: number): number {
  const scores = new Array<number>(beatsPerBar).fill(0);
  for (let i = 0; i < beats.length; i++) {
    const p = i % beatsPerBar;
    scores[p] = scores[p]! + (beats[i]!.strength ?? 0);
  }
  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) if (scores[p]! > scores[best]!) best = p;
  return best;
}

/** Cuts on bar starts: every beat index ≡ phase (mod beatsPerBar). `phase`
 *  omitted → auto-picked by summed onset strength. Returns the phase used. */
export function barsMarks(beats: BeatPoint[], beatsPerBar: number, phase?: number): { marks: CutMark[]; phase: number } {
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 2) {
    throw invalidGrid(`beats-per-bar must be an integer ≥ 2 (got ${beatsPerBar}).`);
  }
  const ph = phase === undefined ? pickBarPhase(beats, beatsPerBar) : ((phase % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const marks: CutMark[] = [];
  for (let i = ph; i < beats.length; i += beatsPerBar) {
    marks.push({ time: beats[i]!.time, beat: i, kind: "bar" });
  }
  return { marks, phase: ph };
}

// --- Stem onsets -----------------------------------------------------------------

/** Greedy peak-pick over a per-frame onset-strength envelope: local maxima
 *  above `threshold` × max, at least `minGapSec` apart (refractory period —
 *  same role as librosa's `wait`). Deterministic left-to-right. */
export function pickOnsetPeaks(
  env: ArrayLike<number>,
  sampleRate: number,
  hopLength: number,
  opts: { minGapSec?: number; threshold?: number } = {},
): OnsetPeak[] {
  const minGapSec = opts.minGapSec ?? 0.25;
  const threshold = opts.threshold ?? 0.12;
  const n = env.length;
  if (n < 3 || sampleRate <= 0 || hopLength <= 0) return [];
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = env[i]!;
    if (v > max) max = v;
  }
  if (!(max > 0)) return [];
  const thresh = threshold * max;
  const minGapFrames = Math.max(1, Math.round((minGapSec * sampleRate) / hopLength));
  const peaks: OnsetPeak[] = [];
  let nextAllowed = 0;
  for (let i = 1; i < n - 1; i++) {
    if (i < nextAllowed) continue;
    const v = env[i]!;
    if (v < thresh) continue;
    const l = env[i - 1]!;
    const r = env[i + 1]!;
    // Local maximum — ≥ both neighbours and strictly above at least one,
    // so flat stretches don't produce a pick on every frame.
    if (!(v >= l && v >= r && (v > l || v > r))) continue;
    peaks.push({ time: round6((i * hopLength) / sampleRate), strength: round4(v / max) });
    nextAllowed = i + minGapFrames;
  }
  return peaks;
}

// --- Energy sections --------------------------------------------------------------

const SECTION_WIN_SEC = 0.5;
const SECTION_HOP_SEC = 0.25;
const SECTION_MIN_SEC = 1.5;
// Class thresholds as fractions of the song's loud (p90) RMS level.
const CLS_QUIET = 0.4;
const CLS_LOUD = 0.75;

const classify = (norm: number): SectionClass => (norm < CLS_QUIET ? "quiet" : norm < CLS_LOUD ? "medium" : "loud");

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
}

/** Windowed RMS series — the shared front half of segmentByEnergy, also
 *  the energy signal for the adaptive grid. Partial tail windows under half
 *  a window are skipped. */
export function windowedRmsSeries(
  pcm: Float32Array,
  sampleRate: number,
  opts: { winSec?: number; hopSec?: number } = {},
): RmsWindow[] {
  const winSec = opts.winSec ?? SECTION_WIN_SEC;
  const hopSec = opts.hopSec ?? SECTION_HOP_SEC;
  const duration = pcm.length / sampleRate;
  if (!Number.isFinite(duration) || duration <= 0 || sampleRate <= 0) return [];
  const win = Math.max(1, Math.round(winSec * sampleRate));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const out: RmsWindow[] = [];
  for (let s = 0; s < pcm.length; s += hop) {
    const e = Math.min(s + win, pcm.length);
    if (e - s < win * 0.5) break;
    let sum = 0;
    for (let i = s; i < e; i++) sum += pcm[i]! * pcm[i]!;
    out.push({ start: s / sampleRate, end: e / sampleRate, rms: Math.sqrt(sum / (e - s)) });
  }
  return out;
}

/** Segment a song into energy sections: short-time RMS windows classified
 *  quiet/medium/loud relative to the song's own loud level (p90), consecutive
 *  same-class windows grouped, and sections shorter than ~1.5 s merged into
 *  the neighbour with the closer mean energy. Deterministic; simple on
 *  purpose — spectral novelty would be a refinement, not a requirement.
 *  Works on any precomputed RmsWindow[] (e.g. the adaptive feature cache). */
export function energySectionsFromWindows(
  windows: RmsWindow[],
  duration: number,
  opts: { minSectionSec?: number } = {},
): EnergySection[] {
  const minSectionSec = opts.minSectionSec ?? SECTION_MIN_SEC;
  const energies = windows.map((w) => w.rms);
  const starts = windows.map((w) => w.start);
  const ends = windows.map((w) => w.end);
  if (energies.length === 0 || !Number.isFinite(duration) || duration <= 0) return [];

  const p90 = percentile([...energies].sort((a, b) => a - b), 0.9) || Math.max(...energies) || 1;
  const norm = energies.map((e) => e / p90);

  // Group consecutive same-class windows (n = window count, for weighted merges).
  interface SectionAcc extends EnergySection {
    n: number;
  }
  let secs: SectionAcc[] = [];
  for (let i = 0; i < energies.length; i++) {
    const cls = classify(norm[i]!);
    const last = secs[secs.length - 1];
    if (last && last.cls === cls) {
      last.end = ends[i]!;
      last.energy = (last.energy * last.n + norm[i]!) / (last.n + 1);
      last.n += 1;
    } else {
      secs.push({ start: starts[i]!, end: ends[i]!, energy: norm[i]!, cls, n: 1 });
    }
  }

  // Merge too-short sections into the energy-closer neighbour until stable.
  for (let guard = 0; guard < 1000; guard++) {
    const idx = secs.findIndex((s) => s.end - s.start < minSectionSec);
    if (idx < 0 || secs.length <= 1) break;
    const cur = secs[idx]!;
    const prev = secs[idx - 1];
    const next = secs[idx + 1];
    let target = -1;
    if (prev && next) {
      target = Math.abs(prev.energy - cur.energy) <= Math.abs(next.energy - cur.energy) ? idx - 1 : idx + 1;
    } else if (prev) target = idx - 1;
    else if (next) target = idx + 1;
    else break;
    const [a, b] = idx < target ? [idx, target] : [target, idx];
    const sa = secs[a]!;
    const sb = secs[b]!;
    const n = sa.n + sb.n;
    const energy = (sa.energy * sa.n + sb.energy * sb.n) / n;
    secs.splice(a, b - a + 1, { start: sa.start, end: sb.end, energy, cls: classify(energy), n });
  }

  if (secs.length === 0) return [];
  secs[0]!.start = 0;
  secs[secs.length - 1]!.end = duration;
  return secs.map(({ n: _n, ...s }) => ({ ...s, start: round6(s.start), end: round6(s.end), energy: round4(s.energy) }));
}

/** Segment a decoded song into energy sections (PCM convenience wrapper —
 *  callers holding only RmsWindow[] use energySectionsFromWindows). */
export function segmentByEnergy(
  pcm: Float32Array,
  sampleRate: number,
  opts: { winSec?: number; hopSec?: number; minSectionSec?: number } = {},
): EnergySection[] {
  return energySectionsFromWindows(windowedRmsSeries(pcm, sampleRate, opts), pcm.length / sampleRate, opts);
}

// --- Rhythm-adaptive grid ---------------------------------------------------------

const ADAPTIVE_MIN_CLIP_SEC = 0.3;
const ADAPTIVE_LADDER_ALL = [1, 2, 4, 8] as const;
const ADAPTIVE_ONSET_WINDOW_SEC = 0.5;
const ADAPTIVE_PEAK_MIN_GAP_SEC = 0.25;
const ADAPTIVE_PEAK_THRESHOLD = 0.12;
const ADAPTIVE_BAR_METER = 4;
const ADAPTIVE_FLAT_P90_P10 = 0.1;
const CLS_ORDER: Record<SectionClass, number> = { quiet: 0, medium: 1, loud: 2 };

/** Mid-rank of each value within the set, scaled to [0,1]. Ties share the
 *  mean rank; a single value ranks 0.5. Deterministic. */
function percentileRank(values: number[]): number[] {
  const n = values.length;
  const ranks = new Array<number>(n).fill(0.5);
  if (n <= 1) return ranks;
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1]![0] === order[i]![0]) j++;
    const pr = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = pr;
    i = j + 1;
  }
  return ranks;
}

/** I(t) in [0,1] on the RMS-window timeline (~0.25 s hop): onset density +
 *  mean onset strength blended with windowed energy, smoothed over
 *  smoothSec, then percentile-ranked against the song itself so the
 *  quietest passage maps to 0 and the loudest to 1 regardless of level.
 *  A nearly-flat smoothed signal (p90-p10 < 0.1) is NOT stretched — every
 *  frame returns 0.5 so the walk holds a middle rung. */
function adaptiveIntensity(feat: AdaptiveFeatures, smoothSec: number): number[] {
  const wins = feat.windows;
  const n = wins.length;
  if (n === 0) return [];
  const times = wins.map((w) => (w.start + w.end) / 2);

  const peaks = pickOnsetPeaks(feat.onsetEnv, feat.envSampleRate, feat.envHop, {
    minGapSec: ADAPTIVE_PEAK_MIN_GAP_SEC,
    threshold: ADAPTIVE_PEAK_THRESHOLD,
  });
  const W = ADAPTIVE_ONSET_WINDOW_SEC;
  const density = new Array<number>(n).fill(0);
  const strength = new Array<number>(n).fill(0);
  let a = 0;
  let b = 0;
  let cnt = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const lo = times[i]! - W;
    const hi = times[i]! + W;
    while (a < peaks.length && peaks[a]!.time < lo) {
      cnt--;
      sum -= peaks[a]!.strength;
      a++;
    }
    while (b < peaks.length && peaks[b]!.time <= hi) {
      cnt++;
      sum += peaks[b]!.strength;
      b++;
    }
    density[i] = cnt / (2 * W);
    strength[i] = cnt > 0 ? sum / cnt : 0;
  }

  const rmsVals = wins.map((w) => w.rms);
  const p90 = percentile([...rmsVals].sort((x, y) => x - y), 0.9) || Math.max(...rmsVals, 0) || 1;
  const energy = rmsVals.map((r) => r / p90);
  const prDensity = percentileRank(density);
  const prStrength = percentileRank(strength);
  const onset = prDensity.map((d, i) => 0.5 * d + 0.5 * prStrength[i]!);
  const prOnset = percentileRank(onset);
  const prEnergy = percentileRank(energy);
  const raw = prOnset.map((o, i) => 0.5 * o + 0.5 * prEnergy[i]!);

  const hop = n > 1 ? times[1]! - times[0]! : SECTION_HOP_SEC;
  const w = Math.max(1, Math.round(smoothSec / Math.max(1e-6, hop)));
  const half = Math.floor(w / 2);
  const sm = raw.map((_, i) => {
    let sum2 = 0;
    let c = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) {
      sum2 += raw[k]!;
      c++;
    }
    return sum2 / c;
  });

  const sorted = [...sm].sort((x, y) => x - y);
  if (percentile(sorted, 0.9) - percentile(sorted, 0.1) < ADAPTIVE_FLAT_P90_P10) {
    return sm.map(() => 0.5);
  }
  return percentileRank(sm);
}

/** Adaptive cut marks: the intensity signal picks a target rung on the
 *  {1,2,4,8} beats-per-cut ladder (constrained to [minBeats..maxBeats]);
 *  the walk moves AT MOST ONE rung per cut toward that target, so cuts
 *  accelerate/decelerate gradually and never jump. Every mark lands on a
 *  detected beat; spans >=4 beats prefer a bar start within +1 beat;
 *  quiet<->loud section jumps force a cut at the boundary; clips stay
 *  >=0.3 s and <=maxClipSec when set. rungIdx records the ladder index
 *  used per interval so tests can assert the one-rung ramp. */
export function adaptiveMarks(ctx: CutGridContext, spec: AdaptiveSpec): { marks: CutMark[]; rungIdx: number[] } {
  const feat = ctx.adaptive;
  if (!feat) {
    throw new MusicEditError(500, "GRID_CONTEXT_MISSING", "adaptive grid requires precomputed intensity features.");
  }
  const beats = ctx.beats;
  const beatTimes = beats.map((b) => b.time);
  const ladder = ADAPTIVE_LADDER_ALL.filter((n) => n >= spec.minBeats && n <= spec.maxBeats);
  const intensity = adaptiveIntensity(feat, spec.smoothSec);
  const frameTimes = feat.windows.map((w) => (w.start + w.end) / 2);

  const atBeat = beatTimes.map((t) => {
    if (frameTimes.length === 0) return 0.5;
    let lo = 0;
    let hi = frameTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameTimes[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    const i0 = Math.max(0, lo - 1);
    const i1 = Math.min(frameTimes.length - 1, lo);
    const v0 = intensity[i0] ?? 0.5;
    const v1 = intensity[i1] ?? 0.5;
    return Math.abs(frameTimes[i0]! - t) <= Math.abs(frameTimes[i1]! - t) ? v0 : v1;
  });

  const targetIdx = (i: number): number => {
    if (ladder.length <= 1) return 0;
    const x = Math.min(1, Math.max(0, atBeat[i]!));
    const xc = Math.min(1, Math.max(0, 0.5 + (x - 0.5) * spec.contrast));
    return Math.round((1 - xc) * (ladder.length - 1));
  };

  const hardBounds: number[] = [];
  const secs = ctx.sections ?? [];
  for (let i = 1; i < secs.length; i++) {
    if (Math.abs(CLS_ORDER[secs[i]!.cls] - CLS_ORDER[secs[i - 1]!.cls]) === 2) {
      hardBounds.push(secs[i]!.start);
    }
  }

  const barPhase = pickBarPhase(beats, ADAPTIVE_BAR_METER);
  const marks: CutMark[] = [];
  const rungIdx: number[] = [];
  if (beatTimes.length === 0) return { marks, rungIdx };
  marks.push({ time: beatTimes[0]!, beat: 0, kind: "adaptive" });

  let cur = targetIdx(0);
  let bi = 0;
  for (let guard = 0; guard < beatTimes.length * 4 + 8; guard++) {
    const tIdx = targetIdx(bi);
    cur = tIdx > cur ? Math.min(cur + 1, tIdx) : tIdx < cur ? Math.max(cur - 1, tIdx) : cur;
    let next = bi + ladder[cur]!;
    if (ladder[cur]! >= 4 && next < beatTimes.length) {
      const aligned =
        next + (((barPhase - (next % ADAPTIVE_BAR_METER)) % ADAPTIVE_BAR_METER) + ADAPTIVE_BAR_METER) % ADAPTIVE_BAR_METER;
      if (aligned > next && aligned - next <= 1 && aligned < beatTimes.length) next = aligned;
    }
    for (const hb of hardBounds) {
      if (hb <= beatTimes[bi]! + 1e-6) continue;
      if (next >= beatTimes.length || hb >= beatTimes[next]! - 1e-6) break;
      let fi = bi + 1;
      while (fi < beatTimes.length && beatTimes[fi]! < hb - 1e-6) fi++;
      if (fi > bi && fi < beatTimes.length) next = Math.min(next, fi);
      break;
    }
    if (next >= beatTimes.length) break;
    let minNext = bi + 1;
    while (minNext < beatTimes.length && beatTimes[minNext]! - beatTimes[bi]! < ADAPTIVE_MIN_CLIP_SEC - 1e-6) minNext++;
    if (minNext >= beatTimes.length) break;
    next = Math.max(next, minNext);
    if (spec.maxClipSec !== undefined && spec.maxClipSec > 0) {
      while (next > minNext && beatTimes[next]! - beatTimes[bi]! > spec.maxClipSec + 1e-6) next--;
    }
    if (next <= bi || next >= beatTimes.length) break;
    marks.push({ time: beatTimes[next]!, beat: next, kind: "adaptive" });
    rungIdx.push(cur);
    bi = next;
  }
  return { marks, rungIdx };
}

// --- Section-aware density ---------------------------------------------------------

/** Auto density per energy class — higher energy gets more cuts. Users may
 *  override any class via the spec (values are beats-per-cut: 1, 2, 4, 8). */
export const SECTION_AUTO_DENSITY: Record<SectionClass, number> = { quiet: 4, medium: 2, loud: 1 };

/** Cuts on detected beats inside each section at that section's density.
 *  The first beat of every section is always a cut, so section boundaries
 *  are always edit points. */
export function sectionMarks(
  beatTimes: number[],
  sections: EnergySection[],
  densities: Record<SectionClass, number>,
): CutMark[] {
  const marks: CutMark[] = [];
  for (const s of sections) {
    const n = densities[s.cls];
    if (!Number.isInteger(n) || n < 1) throw invalidGrid(`section density must be a positive integer (got ${n}).`);
    let j = 0;
    for (let i = 0; i < beatTimes.length; i++) {
      const t = beatTimes[i]!;
      if (t < s.start - 1e-6 || t >= s.end - 1e-6) continue;
      if (j % n === 0) marks.push({ time: t, beat: i, kind: "section" });
      j++;
    }
  }
  return marks;
}

// --- Dispatcher ---------------------------------------------------------------------

const BAND_LABEL: Record<string, string> = {
  full: "full band",
  kick: "kick band (<150 Hz)",
  snare_hat: "snare/hat band",
};

/** Build the cut marks for a grid spec. Beat-derived grids need only
 *  ctx.beats; stem_onsets needs ctx.onsetPeaks and sections needs
 *  ctx.sections — missing context is a server bug (500), an empty result
 *  is a user-tunable outcome (422 GRID_NO_CUTS). */
export function buildCutGrid(spec: CutGridSpec, ctx: CutGridContext): BuiltCutGrid {
  const beatTimes = ctx.beats.map((b) => b.time);
  let marks: CutMark[];
  let label: string;
  let detail: string | undefined;

  switch (spec.source) {
    case "beats": {
      marks = everyNBeatsMarks(beatTimes, 1, 0);
      label = "Every beat";
      break;
    }
    case "every_n_beats": {
      marks = everyNBeatsMarks(beatTimes, spec.n, spec.offset);
      label = spec.n === 1 ? "Every beat" : `Every ${spec.n} beats`;
      if (spec.offset > 0) detail = `starting at beat ${spec.offset + 1}`;
      break;
    }
    case "bars": {
      const r = barsMarks(ctx.beats, spec.beatsPerBar, spec.phase);
      marks = r.marks;
      label = `Bar starts (${spec.beatsPerBar}/4)`;
      detail = `phase: beat ${r.phase + 1} of each bar${spec.phase === undefined ? " (auto)" : ""}`;
      break;
    }
    case "stem_onsets": {
      if (!ctx.onsetPeaks) {
        throw new MusicEditError(500, "GRID_CONTEXT_MISSING", "stem_onsets grid requires precomputed onset peaks.");
      }
      marks = ctx.onsetPeaks
        .filter((p) => p.time < ctx.audioDuration)
        .map((p) => ({ time: p.time, beat: null, kind: "stem_onset" as EdlBoundaryKind }));
      label = `Stem hits · ${spec.stem}`;
      detail = `${BAND_LABEL[spec.band] ?? spec.band} · ≥${spec.minGapBeats != null ? `${spec.minGapBeats} beats` : `${spec.minGap}s`} apart · threshold ${spec.threshold}`;
      break;
    }
    case "sections": {
      if (!ctx.sections || ctx.sections.length === 0) {
        throw new MusicEditError(500, "GRID_CONTEXT_MISSING", "sections grid requires precomputed energy sections.");
      }
      const densities = {
        quiet: spec.quietEvery ?? SECTION_AUTO_DENSITY.quiet,
        medium: spec.mediumEvery ?? SECTION_AUTO_DENSITY.medium,
        loud: spec.loudEvery ?? SECTION_AUTO_DENSITY.loud,
      };
      marks = sectionMarks(beatTimes, ctx.sections, densities);
      label = "Auto by section";
      detail =
        `${ctx.sections.length} sections · ` +
        `quiet every ${densities.quiet}, medium every ${densities.medium}, loud every ${densities.loud} beat${densities.loud === 1 ? "" : "s"}` +
        (spec.quietEvery === undefined && spec.mediumEvery === undefined && spec.loudEvery === undefined ? " (auto)" : "");
      break;
    }
    case "adaptive": {
      const r = adaptiveMarks(ctx, spec);
      marks = r.marks;
      label = "Follow rhythm";
      const bounds = [0, ...marks.map((m) => m.time), ctx.audioDuration];
      let minS = Infinity;
      let maxS = 0;
      for (let i = 1; i < bounds.length; i++) {
        const d = bounds[i]! - bounds[i - 1]!;
        if (d < minS) minS = d;
        if (d > maxS) maxS = d;
      }
      detail =
        `${spec.minBeats}-${spec.maxBeats} beats per cut · ${marks.length} cuts · ` +
        `shortest ${Number.isFinite(minS) ? minS.toFixed(2) : "0"}s / longest ${maxS.toFixed(2)}s` +
        (spec.maxClipSec !== undefined ? ` · cap ${spec.maxClipSec}s` : "");
      break;
    }
    default: {
      const never: never = spec;
      throw invalidGrid(`Unknown cut grid source: ${JSON.stringify(never)}`);
    }
  }

  // Defensive: builders emit sorted unique marks; sort + dedupe exact-time
  // duplicates so the EDL validator always sees a clean sequence.
  marks.sort((a, b) => a.time - b.time);
  marks = marks.filter((m, i) => i === 0 || m.time > marks[i - 1]!.time);

  if (marks.length === 0) {
    const hint =
      spec.source === "stem_onsets"
        ? " — no onsets passed the threshold; lower it or choose another stem/band."
        : spec.source === "every_n_beats" || spec.source === "bars"
          ? " — the offset/phase skips every detected beat."
          : "";
    throw new MusicEditError(422, "GRID_NO_CUTS", `The "${label}" grid produced no cuts${hint}`);
  }
  return { marks, label, detail };
}
