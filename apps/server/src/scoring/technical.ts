// =============================================================================
// Technical filter + technical score (PRD §11, §12)
// =============================================================================

import {
  MIN_DURATION_SECONDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  TECHNICAL_SCORE_WEIGHTS,
} from "@twio/shared";
import type { AspectFlag, Orientation } from "@twio/shared";
import type { ProbeResult } from "../video/ffprobe.js";

export interface TechnicalFilterResult {
  passed: boolean;
  reasons: string[];
  aspectFlag: AspectFlag;
  orientation: Orientation;
}

const SUPPORTED_CODECS = new Set([
  "h264",
  "hevc",
  "h265",
  "vp8",
  "vp9",
  "av1",
  "mpeg4",
  "mpeg2video",
  "msmpeg4v3",
  "theora",
]);

export function technicalFilter(probe: ProbeResult): TechnicalFilterResult {
  const reasons: string[] = [];
  const w = probe.width ?? 0;
  const h = probe.height ?? 0;
  const dur = probe.durationSeconds ?? 0;

  if (w < MIN_WIDTH) reasons.push(`resolution_too_low: width ${w} < ${MIN_WIDTH}`);
  if (h < MIN_HEIGHT) reasons.push(`resolution_too_low: height ${h} < ${MIN_HEIGHT}`);
  if (dur < MIN_DURATION_SECONDS) reasons.push(`duration_too_short: ${dur.toFixed(1)}s < ${MIN_DURATION_SECONDS}s`);
  if (probe.codec && !SUPPORTED_CODECS.has(probe.codec)) {
    reasons.push(`unsupported_codec: ${probe.codec}`);
  }
  if (!probe.video) reasons.push("no_video_stream");

  // Aspect / orientation
  const ratio = w && h ? w / h : 1;
  let orientation: Orientation = "landscape";
  if (ratio < 0.95) orientation = "portrait";
  else if (ratio >= 0.95 && ratio <= 1.1) orientation = "square";
  let aspectFlag: AspectFlag = "STANDARD";
  // 16:9 ≈ 1.78; flag anything notably off as non-standard.
  if (Math.abs(ratio - 16 / 9) > 0.2) aspectFlag = "NON_STANDARD_ASPECT";

  return { passed: reasons.length === 0, reasons, aspectFlag, orientation };
}

// --- Technical score (PRD §12) ---
// technical_score = resolution*0.40 + duration*0.20 + fps*0.10 + aspect*0.20 + source*0.10

function resolutionScore(w: number, h: number): number {
  const px = w * h;
  if (px >= 3840 * 2160) return 1.0;
  if (px >= 1920 * 1080) return 0.85;
  if (px >= 1280 * 720) return 0.5;
  if (px >= 854 * 480) return 0.3;
  return 0.1;
}

function durationScore(dur: number, target?: number): number {
  if (target && target > 0) {
    // Best when duration is close to (or a bit above) target.
    const ratio = dur / target;
    if (ratio >= 1 && ratio <= 3) return 1.0;
    if (ratio >= 0.5 && ratio < 1) return 0.8;
    if (ratio > 3 && ratio <= 6) return 0.7;
  }
  // Fallback absolute scoring.
  if (dur >= 3 && dur <= 15) return 0.9;
  if (dur >= 2 && dur < 3) return 0.6;
  if (dur > 15 && dur <= 30) return 0.6;
  return 0.3;
}

function fpsScore(fps: number | null): number {
  if (fps === null) return 0.7; // unknown — neutral
  if (fps >= 24) return 1.0;
  if (fps >= 15) return 0.7;
  return 0.4;
}

function aspectScore(orientation: Orientation, aspectFlag: AspectFlag, preferred: Orientation): number {
  let s = orientation === preferred ? 1.0 : orientation === "landscape" ? 0.8 : 0.5;
  if (aspectFlag === "NON_STANDARD_ASPECT") s *= 0.7;
  return s;
}

export function technicalScore(
  probe: ProbeResult,
  orientation: Orientation,
  aspectFlag: AspectFlag,
  preferredOrientation: Orientation = "landscape",
  targetDuration?: number,
): number {
  const w = probe.width ?? 0;
  const h = probe.height ?? 0;
  const dur = probe.durationSeconds ?? 0;
  const fps = probe.fps;
  const r = resolutionScore(w, h);
  const d = durationScore(dur, targetDuration);
  const f = fpsScore(fps);
  const a = aspectScore(orientation, aspectFlag, preferredOrientation);
  // source_quality: assume 1.0 for direct provider downloads (no re-encode).
  const sq = 1.0;
  const score =
    r * TECHNICAL_SCORE_WEIGHTS.resolution +
    d * TECHNICAL_SCORE_WEIGHTS.duration +
    f * TECHNICAL_SCORE_WEIGHTS.fps +
    a * TECHNICAL_SCORE_WEIGHTS.aspect +
    sq * TECHNICAL_SCORE_WEIGHTS.sourceQuality;
  return Math.max(0, Math.min(1, score));
}
