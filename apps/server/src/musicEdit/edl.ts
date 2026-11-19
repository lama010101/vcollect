// =============================================================================
// Edit decision list planner — pure and deterministic.
//
// Cut boundaries come from the detected beat timestamps (start = beat[i],
// end = beat[i + N]); the song start and end close the first/last clip.
// Sources are consumed round-robin (V1 → V2 → … → V1) with a per-source
// cursor so long clips are progressively used. Each clip is trimmed and, only
// within [maxSlowDown, maxSpeedUp], retimed so it exactly fills its interval.
// =============================================================================

import type {
  CutGridSource,
  EditPlan,
  EditPlanIntercut,
  EditPlanStats,
  EdlBoundaryKind,
  EdlEntry,
  MusicEditSettings,
} from "@twio/shared";
import type { CutMark, OnsetPeak } from "./cutGrid.js";
import { MusicEditError } from "./errors.js";

export interface PlanSource {
  id: string;
  label: string;
  duration: number; // seconds (probed)
  width: number;
  height: number;
  /** Detected motion peaks (seconds + relative strength) — filled by the
   *  service only when settings.alignMotion is on. */
  motionPeaks?: OnsetPeak[];
}

export interface PlanInput {
  beatTimes: number[];
  bpm: number;
  audioDuration: number;
  sources: PlanSource[];
  settings: MusicEditSettings;
  /** Precomputed inner cut marks from the cut-grid feature — when present
   *  they replace the settings-driven (autoBeats/manual) marks entirely. */
  cutMarks?: CutMark[];
  /** Grid provenance stamped onto the returned plan. */
  grid?: { source: CutGridSource; label: string; detail?: string };
  /** Intercut mode: storylines + rotation params. Absent = flat round-robin
   *  over `sources` exactly as before. */
  intercut?: {
    slotsPerSlice: number;
    endOfMaterial: "loop" | "retire";
    rotation?: "roundRobin";
    storylines: PlanStoryline[];
  };
}

/** One parallel storyline: an ordered list of clips played as a single
 *  continuous thread. Each storyline keeps its own source-time cursor that
 *  advances through `clips` — the next segment always FOLLOWS the previous
 *  one in source time (never restarts mid-storyline). */
export interface PlanStoryline {
  id: string;
  name: string;
  clips: PlanSource[];
}

export interface Boundary {
  time: number;
  beat: number | null;
  kind: EdlBoundaryKind;
}

/** Seconds kept clear of a source's reported end — container durations can
 *  overshoot the last decodable frame. */
export const SOURCE_END_GUARD = 0.05;
/** Beats that would create a clip shorter than this many frames are merged. */
const MIN_SEGMENT_FRAMES = 2;
/** Detected beats may sit marginally past the probed audio end. */
const BEAT_END_TOLERANCE = 0.5;
const EPS = 1e-9;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function assertValidCutMarks(marks: CutMark[], audioDuration: number): void {
  for (let i = 0; i < marks.length; i++) {
    const t = marks[i]!.time;
    if (!Number.isFinite(t) || t < 0) {
      throw new MusicEditError(422, "INVALID_CUT_TIMES", `Cut #${i} has an invalid timestamp (${t}).`);
    }
    if (i > 0 && t <= marks[i - 1]!.time) {
      throw new MusicEditError(422, "INVALID_CUT_TIMES", `Cut timestamps are not strictly increasing at cut #${i} (${marks[i - 1]!.time} → ${t}).`);
    }
    if (t > audioDuration + BEAT_END_TOLERANCE) {
      throw new MusicEditError(422, "INVALID_CUT_TIMES", `Cut #${i} (${t}s) lies beyond the audio end (${audioDuration}s).`);
    }
  }
}

export function assertValidBeatTimes(times: number[], audioDuration: number): void {
  if (times.length === 0) {
    throw new MusicEditError(422, "NO_BEATS_DETECTED", "No beats were detected in the song; cannot build a beat-aligned edit.");
  }
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (!Number.isFinite(t) || t < 0) {
      throw new MusicEditError(422, "INVALID_BEAT_TIMESTAMPS", `Beat #${i} has an invalid timestamp (${t}).`);
    }
    if (i > 0 && t <= times[i - 1]!) {
      throw new MusicEditError(422, "INVALID_BEAT_TIMESTAMPS", `Beat timestamps are not strictly increasing at beat #${i} (${times[i - 1]} → ${t}).`);
    }
    if (t > audioDuration + BEAT_END_TOLERANCE) {
      throw new MusicEditError(422, "INVALID_BEAT_TIMESTAMPS", `Beat #${i} (${t}s) lies beyond the audio end (${audioDuration}s).`);
    }
  }
}

/** Cut boundaries on the song timeline: 0, the grouped beats, audio end.
 *  `cutMarks` (cut-grid feature) replaces the settings-driven marks. */
export function cutBoundaries(input: Pick<PlanInput, "beatTimes" | "audioDuration" | "settings" | "cutMarks">): Boundary[] {
  const { settings, audioDuration, beatTimes, cutMarks } = input;
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
    throw new MusicEditError(422, "CORRUPT_AUDIO", `Audio duration is invalid (${audioDuration}).`);
  }
  const minGap = MIN_SEGMENT_FRAMES / settings.fps;
  const marks: Boundary[] = [];
  if (cutMarks) {
    assertValidCutMarks(cutMarks, audioDuration);
    for (const m of cutMarks) marks.push({ time: m.time, beat: m.beat, kind: m.kind });
    if (marks.length === 0) {
      throw new MusicEditError(422, "GRID_NO_CUTS", "The selected cut grid produced no cuts.");
    }
  } else if (settings.autoBeats) {
    assertValidBeatTimes(beatTimes, audioDuration);
    for (let i = settings.beatOffset; i < beatTimes.length; i += settings.beatsPerCut) {
      marks.push({ time: beatTimes[i]!, beat: i, kind: "beat" });
    }
    if (marks.length === 0) {
      throw new MusicEditError(422, "NO_BEATS_DETECTED", `Beat offset ${settings.beatOffset} skips every detected beat (${beatTimes.length}).`);
    }
  } else {
    if (!settings.manualBpm) {
      throw new MusicEditError(400, "MANUAL_BPM_REQUIRED", "Automatic beat detection is off — set a manual BPM.");
    }
    const period = (60 / settings.manualBpm) * settings.beatsPerCut;
    for (let k = 0; ; k++) {
      const t = settings.manualOffsetSeconds + k * period;
      if (t >= audioDuration) break;
      marks.push({ time: t, beat: null, kind: "manual_grid" });
    }
  }
  const out: Boundary[] = [{ time: 0, beat: null, kind: "audio_start" }];
  for (const m of marks) {
    if (audioDuration - m.time < minGap) break;
    if (m.time - out[out.length - 1]!.time < minGap) continue;
    out.push(m);
  }
  out.push({ time: audioDuration, beat: null, kind: "audio_end" });
  return out;
}

const ASPECTS: Record<MusicEditSettings["aspect"], number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** Largest output of the requested aspect that at least one source can fill
 *  without upscaling, capped at maxOutputHeight. */
export function outputSize(sources: PlanSource[], settings: MusicEditSettings): { width: number; height: number } {
  const a = ASPECTS[settings.aspect];
  let best = 0;
  for (const s of sources) best = Math.max(best, Math.min(s.height, s.width / a));
  const height = even(Math.min(settings.maxOutputHeight, best));
  return { width: even(Math.round(height * a)), height };
}

interface SourcePick {
  sourceIndex: number;
  start: number;
  consumed: number;
  pieces: Array<{ start: number; end: number }>;
  loops: number;
  restarted: boolean;
}

// --- Intercut (parallel storylines) -------------------------------------------
// Each storyline is an ordered clip list with ONE forward-moving source-time
// cursor: segment N+1 of a storyline always starts where segment N ended
// (modulo clip transitions and storyline-level loops). The rotation assigns
// storylines to slices of `slotsPerSlice` consecutive cut slots; a storyline
// that cannot fill a slot (all remaining clips too short even at maxSlowDown)
// is skipped for that slot — same "skip what can't fit" rule as flat mode.

interface IntercutClip extends PlanSource {
  usable: number; // duration minus the source-end guard
}

interface IntercutState {
  def: PlanStoryline;
  clips: IntercutClip[];
  clipIdx: number; // index into clips — advances only forward
  pos: number; // source-time cursor inside clips[clipIdx]
  loops: number; // storyline restarts so far
  retired: boolean;
  justLooped: boolean; // set when the cursor wrapped to clip 0 — cleared on emit
  played: boolean; // emitted ≥1 segment since the last restart
  segments: number;
}

interface IntercutPick {
  clip: IntercutClip;
  start: number;
  consumed: number;
  restarted: boolean;
  motionShift?: number; // seconds the in-point moved for motion alignment
}

/** alignMotion: pick the strongest motion peak whose adjusted in-point
 *  (peak − lead) lands within ±motionWindow of `start`, without reading past
 *  the clip's usable range. Returns the (possibly shifted) in-point. Clips
 *  with no peaks in range keep `start` — the unshifted cursor. */
function motionInPoint(clip: PlanSource, start: number, consumed: number, settings: MusicEditSettings): number {
  const peaks = clip.motionPeaks;
  if (!settings.alignMotion || !peaks?.length) return start;
  const usable = Math.max(0, clip.duration - SOURCE_END_GUARD);
  const W = settings.motionWindow;
  const lead = settings.motionLead;
  let best = start;
  let bestStrength = -1;
  for (const p of peaks) {
    const ns = p.time - lead;
    if (ns < start - W - EPS || ns > start + W + EPS) continue;
    if (ns < 0 || ns + consumed > usable + EPS) continue;
    if (p.strength > bestStrength) {
      bestStrength = p.strength;
      best = ns;
    }
  }
  return best;
}

/** Try to fill one slot of output duration D from a storyline. Advances the
 *  storyline's clip cursor past too-short tails; on clip-list exhaustion
 *  applies the end-of-material policy (loop = restart, retire = drop out).
 *  Returns "retired" when the storyline was dropped, null when nothing in
 *  the storyline can fill D even at the slow-down clamp. */
function intercutFill(
  st: IntercutState,
  D: number,
  settings: MusicEditSettings,
  endOfMaterial: "loop" | "retire",
): IntercutPick | "retired" | null {
  // Bounded passes: with "loop" a storyline whose clips are all shorter than
  // the slot minimum would otherwise cycle forever.
  const maxIter = st.clips.length * 3 + 2;
  for (let it = 0; it < maxIter; it++) {
    if (st.clipIdx >= st.clips.length) {
      if (endOfMaterial === "retire") {
        st.retired = true;
        return "retired";
      }
      st.clipIdx = 0;
      st.pos = 0;
      if (st.played) {
        st.loops += 1;
        st.played = false;
      }
      st.justLooped = true;
      continue;
    }
    const clip = st.clips[st.clipIdx]!;
    const avail = clip.usable - st.pos;
    if (avail >= D - EPS) {
      // Same clamp rules as the flat planner: absorb a tail up to
      // maxSpeedUp, otherwise trim D at ~normal speed.
      const consumed = avail <= D * settings.maxSpeedUp + EPS ? avail : D;
      const ns = motionInPoint(clip, st.pos, consumed, settings);
      const delta = ns - st.pos;
      const pick = emit(st, clip, ns, consumed);
      if (delta !== 0) pick.motionShift = round6(delta);
      return pick;
    }
    if (avail >= D * settings.maxSlowDown - EPS) {
      // Too short to trim — slow down to fill; emit() sees consumed=avail
      // reach the clip end and advances to the next clip itself.
      const ns = motionInPoint(clip, st.pos, avail, settings);
      const delta = ns - st.pos;
      const pick = emit(st, clip, ns, avail);
      if (delta !== 0) pick.motionShift = round6(delta);
      return pick;
    }
    // Tail too short to be worth a segment — abandon it, next clip.
    st.clipIdx += 1;
    st.pos = 0;
  }
  return null;
}

function emit(st: IntercutState, clip: IntercutClip, start: number, consumed: number): IntercutPick {
  const restarted = st.justLooped;
  st.justLooped = false;
  st.pos = round6(start + consumed);
  if (consumed >= clip.usable - start - EPS) {
    st.clipIdx += 1;
    st.pos = 0;
  }
  st.played = true;
  st.segments += 1;
  return { clip, start: round6(start), consumed: round6(consumed), restarted };
}

function intercutEntries(input: PlanInput, bounds: Boundary[], totalFrames: number): { entries: EdlEntry[]; info: EditPlanIntercut } {
  const { settings, audioDuration } = input;
  const ic = input.intercut!;
  const fps = settings.fps;
  const frame = 1 / fps;
  const S = Math.max(1, Math.round(ic.slotsPerSlice));
  const endOfMaterial = ic.endOfMaterial ?? "loop";

  const states: IntercutState[] = ic.storylines.map((def, si) => ({
    def: { ...def, id: def.id || `sl${si + 1}` },
    clips: def.clips.map((c) => ({ ...c, usable: Math.max(0, c.duration - SOURCE_END_GUARD) })),
    clipIdx: 0,
    pos: 0,
    loops: 0,
    retired: false,
    justLooped: false,
    played: false,
    segments: 0,
  }));
  const active = (): IntercutState[] => states.filter((s) => !s.retired);

  const entries: EdlEntry[] = [];
  let shortSlots = 0;
  for (let k = 0; k < bounds.length - 1; k++) {
    const a = bounds[k]!;
    const b = bounds[k + 1]!;
    const frameStart = k === 0 ? 0 : Math.round(a.time * fps);
    const frameEnd = k === bounds.length - 2 ? totalFrames : Math.round(b.time * fps);
    const frames = frameEnd - frameStart;
    if (frames <= 0) {
      throw new MusicEditError(500, "INVALID_EDIT_PLAN", `Clip #${k} has no frames (${a.time}s → ${b.time}s).`);
    }
    const D = frames / fps;
    if (D < 0.1) shortSlots += 1;

    const act = active();
    if (act.length === 0) {
      if (endOfMaterial === "retire") break; // clips stopped — video ends here
      throw new MusicEditError(
        422,
        "INSUFFICIENT_VIDEO_MATERIAL",
        `Every storyline is exhausted at ${round6(a.time)}s — the song is longer than the combined storyline material.`,
      );
    }

    // Rotation: slice floor(k/S) picks the starting storyline; on a miss the
    // remaining storylines fill in order (same skip rule as flat mode).
    const sliceIdx = Math.floor(k / S);
    const startIdx = sliceIdx % act.length;
    let chosen: { st: IntercutState; pick: IntercutPick } | null = null;
    for (let off = 0; off < act.length && !chosen; off++) {
      const st = act[(startIdx + off) % act.length]!;
      const pick = intercutFill(st, D, settings, endOfMaterial);
      if (pick === "retired") continue;
      if (pick) chosen = { st, pick };
    }

    if (!chosen && settings.allowExtremeRetime) {
      // Same escape hatch as flat mode: longest remaining material anywhere,
      // consumed at whatever speed the clamp-free fallback allows.
      let best: { st: IntercutState; ci: number; avail: number } | null = null;
      for (const st of act) {
        if (st.retired) continue;
        for (let ci = st.clipIdx; ci < st.clips.length; ci++) {
          const avail = st.clips[ci]!.usable - (ci === st.clipIdx ? st.pos : 0);
          if (avail >= frame && (!best || avail > best.avail)) best = { st, ci, avail };
        }
      }
      if (best) {
        const st = best.st;
        const clip = st.clips[best.ci]!;
        const start = best.ci === st.clipIdx ? st.pos : 0;
        const consumed = Math.min(best.avail, D * settings.maxSpeedUp);
        const restarted = st.justLooped;
        st.justLooped = false;
        // Unified cursor advance: exhausted clip → next clip at 0, else pos.
        if (consumed >= best.avail - EPS) {
          st.clipIdx = best.ci + 1;
          st.pos = 0;
        } else {
          st.clipIdx = best.ci;
          st.pos = round6(start + consumed);
        }
        st.played = true;
        st.segments += 1;
        chosen = { st, pick: { clip, start: round6(start), consumed: round6(consumed), restarted } };
      }
    }
    if (!chosen) {
      if (endOfMaterial === "retire") break; // nothing usable left — video ends
      const longest = Math.max(
        ...states.flatMap((s) => s.clips.map((c) => c.usable)),
        0,
      );
      throw new MusicEditError(
        422,
        "INSUFFICIENT_VIDEO_MATERIAL",
        `Clip #${k} (${round6(a.time)}s → ${round6(b.time)}s) needs ${D.toFixed(3)}s of storyline footage; the longest usable clip has ` +
          `${longest.toFixed(3)}s and the slow-down limit (${settings.maxSlowDown}) requires at least ${(D * settings.maxSlowDown).toFixed(3)}s. ` +
          `Use longer clips, enable "Allow extreme retime", or choose fewer beats per cut.`,
      );
    }

    const { st, pick } = chosen;
    const clip = pick.clip;
    const sourceEnd = pick.start + pick.consumed;
    entries.push({
      index: k,
      sourceId: clip.id,
      source: clip.label,
      sourceStart: pick.start,
      sourceEnd: round6(sourceEnd),
      sourceConsumed: pick.consumed,
      sourceLoops: 0,
      pieces: [{ start: pick.start, end: round6(sourceEnd) }],
      speed: round6(pick.consumed / D),
      outputStart: round6(a.time),
      outputEnd: round6(b.time),
      outputDuration: round6(b.time - a.time),
      frameStart,
      frameEnd,
      startBeat: a.beat,
      endBeat: b.beat,
      startKind: a.kind,
      endKind: b.kind,
      restartedSource: pick.restarted,
      storylineId: st.def.id,
      storylineName: st.def.name,
      storylineLoop: st.loops,
      motionShift: pick.motionShift,
    });
  }

  return {
    entries,
    info: {
      slotsPerSlice: S,
      endOfMaterial: ic.endOfMaterial ?? "loop",
      rotation: "roundRobin",
      storylines: states.map((s) => ({
        id: s.def.id,
        name: s.def.name,
        clips: s.clips.length,
        segments: s.segments,
      })),
      shortSlots,
    },
  };
}

export function planEdit(input: PlanInput): EditPlan {
  const { settings, sources } = input;
  if (sources.length === 0) {
    throw new MusicEditError(400, "NO_SOURCE_VIDEOS", "Select at least one source video.");
  }
  if (settings.maxSlowDown > 1 || settings.maxSpeedUp < 1) {
    throw new MusicEditError(400, "INVALID_SETTINGS", "maxSlowDown must be ≤ 1 and maxSpeedUp ≥ 1.");
  }
  const fps = settings.fps;
  const frame = 1 / fps;
  const bounds = cutBoundaries(input);
  const { width, height } = outputSize(sources, settings);
  const totalFrames = Math.ceil(input.audioDuration * fps - 1e-6);

  const timing: EditPlan["timing"] = input.cutMarks ? "cut_grid" : settings.autoBeats ? "detected_beats" : "manual_grid";
  const gridInfo = input.cutMarks && input.grid ? { ...input.grid, cutCount: bounds.length - 2 } : undefined;
  const base = {
    version: 1 as const,
    timing,
    grid: gridInfo,
    beatsPerCut: settings.beatsPerCut,
    bpm: settings.autoBeats ? input.bpm : settings.manualBpm ?? input.bpm,
    beatCount: input.beatTimes.length,
    audioDuration: round6(input.audioDuration),
    fps,
    width,
    height,
    totalFrames,
  };

  if (input.intercut?.storylines.length) {
    const { entries, info } = intercutEntries(input, bounds, totalFrames);
    if (entries.length === 0) {
      throw new MusicEditError(
        422,
        "INSUFFICIENT_VIDEO_MATERIAL",
        `No storyline can fill the first clip (${bounds[1] ? round6(bounds[1].time) : "?"}s). ` +
          `Use longer clips, enable "Allow extreme retime", or choose fewer beats per cut.`,
      );
    }
    const videoDuration = round6(entries[entries.length - 1]!.outputEnd);
    return { ...base, intercut: info, videoDuration, entries, stats: planStats(entries, videoDuration) };
  }

  const usable = sources.map((s) => Math.max(0, s.duration - SOURCE_END_GUARD));
  const cursors = sources.map(() => 0);

  // Trim/retime a contiguous range starting at `start`.
  const fitLinear = (i: number, start: number, D: number): SourcePick | null => {
    const available = usable[i]! - start;
    if (available < frame) return null;
    let consumed: number;
    if (available >= D - EPS) {
      // Absorb a tail up to maxSpeedUp (too short to reuse on its own),
      // otherwise trim to the interval at normal speed.
      consumed = available <= D * settings.maxSpeedUp + EPS ? available : D;
    } else if (available >= D * settings.maxSlowDown - EPS) {
      consumed = available;
    } else {
      return null;
    }
    return { sourceIndex: i, start, consumed, pieces: [{ start, end: start + consumed }], loops: 0, restarted: false };
  };

  const fitLoop = (i: number, start: number, D: number): SourcePick | null => {
    const L = usable[i]!;
    if (L < MIN_SEGMENT_FRAMES * frame) return null;
    const pieces: Array<{ start: number; end: number }> = [];
    let pos = start >= L - frame ? 0 : start;
    const first = pos;
    let remaining = D;
    let loops = 0;
    while (remaining > EPS) {
      const take = Math.min(remaining, L - pos);
      pieces.push({ start: pos, end: pos + take });
      remaining -= take;
      pos += take;
      if (remaining > EPS) {
        pos = 0;
        loops++;
      }
    }
    return { sourceIndex: i, start: first, consumed: D, pieces, loops, restarted: false };
  };

  const pickFor = (i: number, D: number): SourcePick | null => {
    const cursor = cursors[i]!;
    const fromCursor = fitLinear(i, cursor, D);
    if (fromCursor) return fromCursor;
    // loopSource off: fresh material only — restarting from 0 IS looping,
    // and so is the allowExtremeRetime escape below. Exhausted sources make
    // the plan end early instead of replaying footage.
    if (!settings.loopSource) return null;
    const fromZero = fitLinear(i, 0, D);
    if (fromZero) return { ...fromZero, restarted: cursor > 0 };
    return fitLoop(i, cursor, D);
  };

  let rr = 0;
  const entries: EdlEntry[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const a = bounds[k]!;
    const b = bounds[k + 1]!;
    const frameStart = k === 0 ? 0 : Math.round(a.time * fps);
    const frameEnd = k === bounds.length - 2 ? totalFrames : Math.round(b.time * fps);
    const frames = frameEnd - frameStart;
    if (frames <= 0) {
      throw new MusicEditError(500, "INVALID_EDIT_PLAN", `Clip #${k} has no frames (${a.time}s → ${b.time}s).`);
    }
    const D = frames / fps;

    let pick: SourcePick | null = null;
    for (let n = 0; n < sources.length && !pick; n++) pick = pickFor((rr + n) % sources.length, D);
    // allowExtremeRetime is an explicit opt-in to replay a clip at out-of-clamp
    // speed when nothing fits — it still applies with loopSource off (the user
    // chose replay-fill over ending early). When it's off too, we truncate.
    if (!pick && settings.allowExtremeRetime) {
      let bestIdx = -1;
      for (let n = 0; n < sources.length; n++) {
        const i = (rr + n) % sources.length;
        if (usable[i]! >= frame && (bestIdx < 0 || usable[i]! > usable[bestIdx]!)) bestIdx = i;
      }
      if (bestIdx >= 0) {
        const L = usable[bestIdx]!;
        const consumed = Math.min(L, D * settings.maxSpeedUp);
        pick = { sourceIndex: bestIdx, start: 0, consumed, pieces: [{ start: 0, end: consumed }], loops: 0, restarted: cursors[bestIdx]! > 0 };
      }
    }
    if (!pick && !settings.loopSource) {
      // Material exhausted with looping off — the video ends at this cut.
      break;
    }
    if (!pick) {
      const longest = Math.max(...usable);
      throw new MusicEditError(
        422,
        "INSUFFICIENT_VIDEO_MATERIAL",
        `Clip #${k} (${round6(a.time)}s → ${round6(b.time)}s) needs ${D.toFixed(3)}s of footage; the longest usable source has ` +
          `${longest.toFixed(3)}s and the slow-down limit (${settings.maxSlowDown}) requires at least ${(D * settings.maxSlowDown).toFixed(3)}s. ` +
          `Enable "Loop source videos", add longer videos, or choose fewer beats per cut.`,
      );
    }

    // alignMotion: shift single-range picks so a motion peak lands on the
    // cut (looped multi-piece picks are left untouched — shifting would
    // break their wrap contiguity).
    let motionShift: number | undefined;
    if (pick && settings.alignMotion && pick.pieces.length === 1) {
      const clip = sources[pick.sourceIndex]!;
      const ns = motionInPoint(clip, pick.start, pick.consumed, settings);
      if (ns !== pick.start) {
        motionShift = round6(ns - pick.start);
        pick = { ...pick, start: ns, pieces: [{ start: ns, end: ns + pick.consumed }] };
      }
    }

    const i = pick.sourceIndex;
    const last = pick.pieces[pick.pieces.length - 1]!;
    cursors[i] = last.end >= usable[i]! - frame ? usable[i]! : last.end;
    rr = (i + 1) % sources.length;
    entries.push({
      index: k,
      sourceId: sources[i]!.id,
      source: sources[i]!.label,
      sourceStart: round6(pick.start),
      sourceEnd: round6(last.end),
      sourceConsumed: round6(pick.consumed),
      sourceLoops: pick.loops,
      pieces: pick.pieces.map((p) => ({ start: round6(p.start), end: round6(p.end) })),
      speed: round6(pick.consumed / D),
      outputStart: round6(a.time),
      outputEnd: round6(b.time),
      outputDuration: round6(b.time - a.time),
      frameStart,
      frameEnd,
      startBeat: a.beat,
      endBeat: b.beat,
      startKind: a.kind,
      endKind: b.kind,
      restartedSource: pick.restarted,
      motionShift,
    });
  }

  if (entries.length === 0) {
    throw new MusicEditError(
      422,
      "INSUFFICIENT_VIDEO_MATERIAL",
      `No source can fill the first clip (${bounds[1] ? round6(bounds[1].time) : "?"}s). ` +
        `Add longer videos, enable "Loop source videos", or choose fewer beats per cut.`,
    );
  }
  // videoDuration < audioDuration iff the plan truncated on exhausted,
  // non-looped material — the render trims the song to this length.
  const videoDuration = round6(entries[entries.length - 1]!.outputEnd);
  return {
    ...base,
    videoDuration,
    entries,
    stats: planStats(entries, videoDuration),
  };
}

function planStats(entries: EdlEntry[], audioDuration: number): EditPlanStats {
  const durations = entries.map((e) => e.outputDuration);
  const speeds = entries.map((e) => e.speed);
  const sourceUsage: Record<string, number> = {};
  for (const e of entries) sourceUsage[e.sourceId] = (sourceUsage[e.sourceId] ?? 0) + 1;
  return {
    segmentCount: entries.length,
    averageClipDuration: round6(audioDuration / entries.length),
    minClipDuration: Math.min(...durations),
    maxClipDuration: Math.max(...durations),
    retimedCount: entries.filter((e) => Math.abs(e.speed - 1) > 1e-4).length,
    loopedCount: entries.filter((e) => e.sourceLoops > 0).length,
    minSpeed: Math.min(...speeds),
    maxSpeed: Math.max(...speeds),
    sourceUsage,
  };
}
