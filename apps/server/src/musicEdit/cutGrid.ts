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
  /** RMS-energy sections of the song — required for sections. */
  sections?: EnergySection[];
}

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

/** Segment a song into energy sections: short-time RMS windows classified
 *  quiet/medium/loud relative to the song's own loud level (p90), consecutive
 *  same-class windows grouped, and sections shorter than ~1.5 s merged into
 *  the neighbour with the closer mean energy. Deterministic; simple on
 *  purpose — spectral novelty would be a refinement, not a requirement. */
export function segmentByEnergy(
  pcm: Float32Array,
  sampleRate: number,
  opts: { winSec?: number; hopSec?: number; minSectionSec?: number } = {},
): EnergySection[] {
  const winSec = opts.winSec ?? SECTION_WIN_SEC;
  const hopSec = opts.hopSec ?? SECTION_HOP_SEC;
  const minSectionSec = opts.minSectionSec ?? SECTION_MIN_SEC;
  const duration = pcm.length / sampleRate;
  if (!Number.isFinite(duration) || duration <= 0 || sampleRate <= 0) return [];
  const win = Math.max(1, Math.round(winSec * sampleRate));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));

  // Windowed RMS — partial tail windows under half a window are skipped.
  const energies: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let s = 0; s < pcm.length; s += hop) {
    const e = Math.min(s + win, pcm.length);
    if (e - s < win * 0.5) break;
    let sum = 0;
    for (let i = s; i < e; i++) sum += pcm[i]! * pcm[i]!;
    energies.push(Math.sqrt(sum / (e - s)));
    starts.push(s / sampleRate);
    ends.push(e / sampleRate);
  }
  if (energies.length === 0) return [];

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
      marks = ctx.onsetPeaks.map((p) => ({ time: p.time, beat: null, kind: "stem_onset" as EdlBoundaryKind }));
      label = `Stem hits · ${spec.stem}`;
      detail = `${BAND_LABEL[spec.band] ?? spec.band} · ≥${spec.minGap}s apart · threshold ${spec.threshold}`;
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
