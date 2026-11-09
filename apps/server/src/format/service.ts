// =============================================================================
// Format service — reframe a downloaded asset to a fixed aspect (16:9 / 9:16 /
// 1:1) via the shared FFmpeg service. The reframe is a pure CENTER CROP to the
// target aspect (the same cover-fit convention the layer zoomPan and the EDL
// renderer use — content outside the target frame is cut, never letterboxed)
// at the largest size the source can supply without upscaling. Audio is kept
// (AAC copied, anything else re-encoded) and the MP4 lands in
// OUTPUT_ROOT/<slug>/format/.
// =============================================================================

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { FormatAspect } from "@twio/shared";
import { projectPaths } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { getAsset } from "../db/repository.js";
import { fileUrl } from "../musicEdit/service.js";
import { assetAbsolutePath } from "../routes/folders.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { probe } from "../video/ffprobe.js";
import { FormatError } from "./errors.js";

/** Standard output frames — shrunk to the source when it's smaller. */
const FRAMES: Record<FormatAspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

export function projectFormatDir(projectId: string): string {
  const project = getProject(projectId);
  if (!project || project.isVirtual) throw new FormatError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  const dir = resolve(projectPaths(project.slug).output, "format");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Round down to the nearest even int (x264 + yuv420p need even dims). */
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

export interface FormatResult {
  name: string;
  url: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSeconds: number | null;
}

/**
 * Reframe one downloaded asset. Output dims = the biggest target-aspect rect
 * that fits inside the (oriented) source, capped at the standard frame — so
 * the crop window IS the output size and no resampling happens at all.
 */
export async function convertAsset(
  projectId: string,
  assetId: string,
  aspect: FormatAspect,
  range?: { start?: number; end?: number },
): Promise<FormatResult> {
  const a = getAsset(assetId);
  if (!a || a.project_id !== projectId) throw new FormatError(404, "VIDEO_NOT_FOUND", `Video asset not found: ${assetId}`);
  if (!a.local_path) throw new FormatError(422, "VIDEO_NOT_DOWNLOADED", `Video "${a.title ?? assetId}" has not been downloaded.`);
  const src = assetAbsolutePath(a.local_path);
  if (!existsSync(src)) throw new FormatError(404, "VIDEO_FILE_MISSING", `Video file is missing: ${a.local_path}`);

  let p;
  try {
    p = await probe(src);
  } catch (e) {
    throw new FormatError(422, "CORRUPT_VIDEO", `Cannot read video "${a.title ?? assetId}": ${(e as Error).message}`);
  }
  if (!p.width || !p.height) throw new FormatError(422, "CORRUPT_VIDEO", `Video "${a.title ?? assetId}" has no usable dimensions.`);

  // Trim window — clamped to the probed duration; absent = whole video.
  const dur = p.durationSeconds ?? 0;
  const start = Math.max(0, Math.min(range?.start ?? 0, dur > 0 ? dur : Number.MAX_VALUE));
  const end = dur > 0 ? Math.min(range?.end ?? dur, dur) : range?.end;
  if (end !== undefined && end <= start) {
    throw new FormatError(422, "INVALID_RANGE", `Trim end (${end}s) must be after trim start (${start}s).`);
  }
  const outDuration = end !== undefined ? end - start : (p.durationSeconds ?? null);
  // ffmpeg autorotates on decode — the filter graph sees the ORIENTED raster.
  const [sw, sh] = p.rotation === 90 || p.rotation === 270 ? [p.height, p.width] : [p.width, p.height];

  // Biggest target-aspect rect inside the source, capped at the preset frame:
  // bound the box by both limits, then shrink the overflowing axis to AR.
  const { w: tw, h: th } = FRAMES[aspect];
  const ar = tw / th;
  let ow = Math.min(tw, sw);
  let oh = Math.min(th, sh);
  if (ow / oh > ar) ow = (oh * ar);
  else oh = (ow / ar);
  const outW = even(ow);
  const outH = even(oh);

  const outDir = projectFormatDir(projectId);
  const stem = basename(a.local_path, extname(a.local_path)).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "video";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outName = `${stem}-${aspect.replace(":", "x")}-${stamp}.mp4`;
  const outPath = join(outDir, outName);

  // Center crop straight to the output size (no scale filter — the crop
  // window and the frame are the same dims), square pixels, tv gamma.
  const vf = `crop=${outW}:${outH},setsar=1,format=yuv420p`;
  const audio = p.streams.find((s) => s.codec_type === "audio");
  const audioArgs = !audio ? ["-an"] : audio.codec_name === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];
  const r = await ffmpegService.ffmpegExec(
    [
      "-v", "error", "-y",
      // Input seek — frame-accurate for re-encode in modern ffmpeg.
      ...(start > 0 ? ["-ss", start.toFixed(6)] : []),
      "-i", src,
      ...(end !== undefined ? ["-t", (end - start).toFixed(6)] : []),
      "-map", "0:v:0",
      ...(audio ? ["-map", "0:a:0"] : []),
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      ...audioArgs,
      "-movflags", "+faststart",
      outPath,
    ],
    "format-convert",
  );
  if (r.exitCode !== 0 || !existsSync(outPath)) {
    throw new FormatError(500, "FFMPEG_FAILED", `FFmpeg failed while reframing: ${r.stderr.trim().slice(-600)}`);
  }
  const st = statSync(outPath);
  return { name: outName, url: fileUrl(outPath), sizeBytes: st.size, width: outW, height: outH, durationSeconds: outDuration };
}

export interface FormatRenderedFile {
  name: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
}

export function listRenders(projectId: string): FormatRenderedFile[] {
  const dir = projectFormatDir(projectId);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      return { name: f, url: fileUrl(p), sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
