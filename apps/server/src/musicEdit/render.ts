// =============================================================================
// Renderer — turns an EditPlan into an MP4 through the shared FFmpeg service.
//
// Each EDL entry is encoded once, straight from the source file, into an
// identically-parameterised raw H.264 part (trim → retime → fps → scale/crop).
// Parts are byte-joined into one Annex-B stream and muxed at a constant frame
// rate, so frame n sits exactly at n / fps (no per-part timestamp drift). The original
// song is muxed untouched (copied when already AAC, otherwise AAC-encoded
// with no tempo/pitch change) and cut at the audio end.
// =============================================================================

import { cpus } from "node:os";
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import type { EditPlan, EdlEntry } from "@twio/shared";
import { ffmpegService } from "../video/ffmpeg.js";
import { probe, probeAudio } from "../video/ffprobe.js";
import { MusicEditError } from "./errors.js";

export interface RenderSource {
  path: string;
  duration: number;
}

export interface RenderProgress {
  phase: "segments" | "mux" | "verify";
  done: number;
  total: number;
}

export interface RenderOptions {
  songPath: string;
  audioCodec: string;
  outPath: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
}

export interface RenderResult {
  outPath: string;
  durationSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
}

const fmt = (n: number): string => n.toFixed(6);

/** FFmpeg args that render one EDL entry to exactly `frames` output frames. */
export function segmentArgs(entry: EdlEntry, src: RenderSource, plan: EditPlan, outFile: string): string[] {
  const frames = entry.frameEnd - entry.frameStart;
  const frame = 1 / plan.fps;
  const inputs: string[] = [];
  entry.pieces.forEach((p) => {
    // A little read-ahead so the last output frame always has a source frame,
    // clamped to the source's own duration.
    const end = Math.min(src.duration, p.end + frame * entry.speed);
    inputs.push("-ss", fmt(p.start), "-t", fmt(end - p.start), "-i", src.path);
  });
  const n = entry.pieces.length;
  const joined = n === 1 ? "[0:v]" : `${entry.pieces.map((_, i) => `[${i}:v]`).join("")}concat=n=${n}:v=1:a=0,`;
  const chain =
    `setpts=(PTS-STARTPTS)/${entry.speed.toFixed(6)},fps=${plan.fps},` +
    `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase:flags=bicubic,` +
    `crop=${plan.width}:${plan.height},setsar=1,format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=${fmt(frame * 2)}`;
  const filter = `${joined}${chain}[v]`;
  return [
    "-v", "error", "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[v]",
    "-an", "-sn", "-dn",
    "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-bf", "0",
    "-pix_fmt", "yuv420p", "-r", String(plan.fps),
    "-f", "h264",
    outFile,
  ];
}

async function pool<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < items.length) {
      const idx = next++;
      try {
        await fn(items[idx]!, idx);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== null) throw failed;
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export async function renderEdit(
  plan: EditPlan,
  sources: Map<string, RenderSource>,
  opts: RenderOptions,
): Promise<RenderResult> {
  if (plan.entries.length === 0) throw new MusicEditError(422, "INVALID_EDIT_PLAN", "The edit plan has no clips.");
  for (const e of plan.entries) {
    if (!sources.has(e.sourceId)) throw new MusicEditError(422, "VIDEO_NOT_FOUND", `Source ${e.sourceId} is missing.`);
  }
  const outPath = resolve(opts.outPath);
  const workDir = `${outPath}.parts`;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const concurrency = opts.concurrency ?? Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
  const total = plan.entries.length;
  const partFiles = plan.entries.map((e) => join(workDir, `part_${String(e.index).padStart(5, "0")}.h264`));
  try {
    let done = 0;
    opts.onProgress?.({ phase: "segments", done, total });
    await pool(plan.entries, concurrency, async (entry, idx) => {
      if (aborted(opts.signal)) throw new MusicEditError(499, "RENDER_CANCELLED", "Render cancelled.");
      const src = sources.get(entry.sourceId)!;
      const r = await ffmpegService.ffmpegExec(segmentArgs(entry, src, plan, partFiles[idx]!), undefined, { signal: opts.signal });
      if (aborted(opts.signal)) throw new MusicEditError(499, "RENDER_CANCELLED", "Render cancelled.");
      if (r.exitCode !== 0) {
        throw new MusicEditError(
          500,
          "FFMPEG_FAILED",
          `FFmpeg failed on clip #${entry.index} (${entry.source} ${entry.sourceStart}s→${entry.sourceEnd}s): ${r.stderr.trim().slice(-600)}`,
        );
      }
      done++;
      opts.onProgress?.({ phase: "segments", done, total });
    });

    opts.onProgress?.({ phase: "mux", done: total, total });
    const videoPath = join(workDir, "video.h264");
    await pipeline(async function* () {
      for (const f of partFiles) yield* createReadStream(f);
    }, createWriteStream(videoPath));
    const audioArgs = opts.audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "320k"];
    // The song is trimmed to the video length — shorter than audioDuration
    // when a non-looped plan ended early on exhausted material.
    const outDur = plan.videoDuration ?? plan.audioDuration;
    const mux = await ffmpegService.ffmpegExec(
      [
        "-v", "error", "-y",
        "-fflags", "+genpts", "-f", "h264", "-framerate", String(plan.fps), "-i", videoPath,
        "-i", resolve(opts.songPath),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", ...audioArgs,
        "-t", fmt(outDur),
        "-movflags", "+faststart",
        outPath,
      ],
      "music-edit-mux",
      { signal: opts.signal },
    );
    if (aborted(opts.signal)) throw new MusicEditError(499, "RENDER_CANCELLED", "Render cancelled.");
    if (mux.exitCode !== 0) {
      throw new MusicEditError(500, "FFMPEG_FAILED", `FFmpeg failed while muxing the final video: ${mux.stderr.trim().slice(-600)}`);
    }

    opts.onProgress?.({ phase: "verify", done: total, total });
    const v = await probe(outPath);
    const a = await probeAudio(outPath);
    const videoDur = Number(v.video?.duration ?? v.durationSeconds ?? 0);
    const tolerance = 2 / plan.fps + 0.05;
    if (Math.abs(a.durationSeconds - outDur) > tolerance || Math.abs(videoDur - outDur) > tolerance) {
      throw new MusicEditError(
        500,
        "OUTPUT_DURATION_MISMATCH",
        `Rendered durations (video ${videoDur.toFixed(3)}s, audio ${a.durationSeconds.toFixed(3)}s) do not match the plan output (${outDur.toFixed(3)}s).`,
      );
    }
    return {
      outPath,
      durationSeconds: v.durationSeconds ?? videoDur,
      videoDurationSeconds: videoDur,
      audioDurationSeconds: a.durationSeconds,
    };
  } catch (e) {
    rmSync(outPath, { force: true });
    if (aborted(opts.signal)) throw new MusicEditError(499, "RENDER_CANCELLED", "Render cancelled.");
    throw e;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
