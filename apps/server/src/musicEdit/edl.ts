// =============================================================================
// Edit decision list planner — pure and deterministic.
//
// Cut boundaries come from the detected beat timestamps (start = beat[i],
// end = beat[i + N]); the song start and end close the first/last clip.
// Sources are consumed round-robin (V1 → V2 → … → V1) with a per-source
// cursor so long clips are progressively used. Each clip is trimmed and, only
// within [maxSlowDown, maxSpeedUp], retimed so it exactly fills its interval.
// =============================================================================

import type { EditPlan, EditPlanStats, EdlBoundaryKind, EdlEntry, MusicEditSettings } from "@twio/shared";
import { MusicEditError } from "./errors.js";

export interface PlanSource {
  id: string;
  label: string;
  duration: number; // seconds (probed)
  width: number;
  height: number;
}

export interface PlanInput {
  beatTimes: number[];
  bpm: number;
  audioDuration: number;
  sources: PlanSource[];
  settings: MusicEditSettings;
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

/** Cut boundaries on the song timeline: 0, the grouped beats, audio end. */
export function cutBoundaries(input: Pick<PlanInput, "beatTimes" | "audioDuration" | "settings">): Boundary[] {
  const { settings, audioDuration, beatTimes } = input;
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
    throw new MusicEditError(422, "CORRUPT_AUDIO", `Audio duration is invalid (${audioDuration}).`);
  }
  const minGap = MIN_SEGMENT_FRAMES / settings.fps;
  const marks: Boundary[] = [];
  if (settings.autoBeats) {
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
  const usable = sources.map((s) => Math.max(0, s.duration - SOURCE_END_GUARD));
  const cursors = sources.map(() => 0);
  const totalFrames = Math.ceil(input.audioDuration * fps - 1e-6);

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
    const fromCursor = cursor > 0 ? fitLinear(i, cursor, D) : null;
    if (fromCursor) return fromCursor;
    const fromZero = fitLinear(i, 0, D);
    if (fromZero) return { ...fromZero, restarted: cursor > 0 };
    if (settings.loopSource) return fitLoop(i, cursor, D);
    return null;
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
    });
  }

  return {
    version: 1,
    timing: settings.autoBeats ? "detected_beats" : "manual_grid",
    beatsPerCut: settings.beatsPerCut,
    bpm: settings.autoBeats ? input.bpm : settings.manualBpm ?? input.bpm,
    beatCount: input.beatTimes.length,
    audioDuration: round6(input.audioDuration),
    fps,
    width,
    height,
    totalFrames,
    entries,
    stats: planStats(entries, input.audioDuration),
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
