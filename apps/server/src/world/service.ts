// =============================================================================
// World Cam service — camera-path re-render jobs (InSpatio-World on a remote
// GPU worker). Mirrors visualizer/service.ts: jobs are in-memory +
// AbortController; one job at a time since the remote GPU serializes anyway.
//
// Lifecycle: validate → (optional ffmpeg trim) → generate target trajectory
// from the preset (shared math) → upload to the worker → poll status →
// download pred.mp4 into <slug>/assets/world/ → syncProjectAssets registers
// it as a normal 'local' asset (Library / Folders / visualizer layers).
// =============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  computeCameraTrajectory,
  serializeTrajectoryTxt,
  worldCamRequestSchema,
  WORLD_CAM_PRESETS,
  type WorldCamPresetId,
  type WorldCamRequest,
} from "@twio/shared";
import { OUTPUT_ROOT, projectAssetDir, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { sha256File, syncProjectAssets } from "../db/assetSync.js";
import { getProject } from "../db/projectRepository.js";
import { getAsset, listAllAssets } from "../db/repository.js";
import { fileUrl } from "../musicEdit/service.js";
import { assetAbsolutePath } from "../routes/folders.js";
import { probe } from "../video/ffprobe.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { WorldError } from "./errors.js";
import {
  cancelWorkerJob,
  downloadWorkerResult,
  submitWorkerJob,
  workerHealth,
  workerJobStatus,
  worldEndpointInfo,
  type RemoteHealth,
} from "./client.js";

const POLL_MS = 2500;
const CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "world");

// --- Project videos for the source picker -----------------------------------------

export interface WorldVideo {
  assetId: string;
  title: string;
  fileUrl: string;
  thumbUrl: string;
  durationSeconds: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
}

/** Project assets that are playable downloaded videos — the source pool. */
export function listWorldVideos(projectId: string): WorldVideo[] {
  const project = getProject(projectId);
  if (!project || project.isVirtual) {
    throw new WorldError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }
  return listAllAssets(projectId)
    .filter((a) => a.local_path && VIDEO_FILE_EXTENSIONS.has(extname(a.local_path).toLowerCase()))
    .map((a) => ({
      assetId: a.id,
      title: a.title ?? a.provider_asset_id ?? a.id,
      fileUrl: `/api/assets/${a.id}/file`,
      thumbUrl: `/api/assets/${a.id}/thumb`,
      durationSeconds: a.duration_seconds ?? null,
      fps: a.fps ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
    }));
}

// --- Endpoint status for the UI ----------------------------------------------------

export interface WorldStatus {
  configured: boolean;
  endpoint: string;
  endpointSource: "override" | "env" | null;
  reachable: boolean;
  worker: RemoteHealth | null;
}

export async function worldStatus(): Promise<WorldStatus> {
  const info = worldEndpointInfo();
  const base: WorldStatus = {
    configured: info.endpoint !== "",
    endpoint: info.endpoint,
    endpointSource: info.source,
    reachable: false,
    worker: null,
  };
  if (!base.configured) return base;
  try {
    base.worker = await workerHealth();
    base.reachable = !!base.worker.ok;
  } catch {
    /* unreachable — worker field stays null */
  }
  return base;
}

// --- Jobs ---------------------------------------------------------------------------

export type WorldJobStatus =
  | "preparing"   // trim + trajectory generation
  | "uploading"   // multipart POST in flight
  | "running"     // remote worker processing
  | "downloading" // fetching pred.mp4
  | "done"
  | "failed"
  | "cancelled";

export interface WorldJob {
  id: string;
  projectId: string;
  status: WorldJobStatus;
  /** Remote worker phase (preparing/depth/render/inference) when running. */
  remotePhase: string | null;
  logTail: string;
  error: { code: string; message: string } | null;
  request: WorldCamRequest;
  sourceAssetId: string;
  remoteJobId: string | null;
  resultAssetId: string | null;
  resultUrl: string | null;
  /** Absolute filesystem path of the produced MP4 (for "show in folder"). */
  resultPath: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, WorldJob & { controller: AbortController }>();

function publicJob(j: WorldJob & { controller: AbortController }): WorldJob {
  const { controller: _c, ...rest } = j;
  return rest;
}

export function listWorldJobs(projectId: string): WorldJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(publicJob);
}

export function getWorldJob(id: string): WorldJob {
  const j = jobs.get(id);
  if (!j) throw new WorldError(404, "JOB_NOT_FOUND", `No such World Cam job: ${id}`);
  return publicJob(j);
}

export function cancelWorldJob(id: string): WorldJob {
  const j = jobs.get(id);
  if (!j) throw new WorldError(404, "JOB_NOT_FOUND", `No such World Cam job: ${id}`);
  if (j.status === "done" || j.status === "failed" || j.status === "cancelled") return publicJob(j);
  j.controller.abort();
  return publicJob(j);
}

// --- Frame counting (trajectory rows must match the video's real frame count) -------

/** Exact frame count via ffprobe: stream nb_frames first, then packet count,
 *  then duration×fps as a last resort. */
async function videoFrameCount(absPath: string, probed: { fps: number | null; durationSeconds: number | null }): Promise<number> {
  const stream = await ffmpegService.ffprobeExec(
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "json", absPath],
    "world-frames",
  );
  try {
    const parsed = JSON.parse(stream.stdout) as { streams?: Array<{ nb_frames?: string }> };
    const n = Number(parsed.streams?.[0]?.nb_frames);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through to packet counting */
  }
  const packets = await ffmpegService.ffprobeExec(
    ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "json", absPath],
    "world-frames",
  );
  try {
    const parsed = JSON.parse(packets.stdout) as { streams?: Array<{ nb_read_packets?: string }> };
    const n = Number(parsed.streams?.[0]?.nb_read_packets);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through to duration estimate */
  }
  if (probed.fps && probed.durationSeconds) {
    return Math.max(1, Math.round(probed.durationSeconds * probed.fps));
  }
  throw new WorldError(422, "CORRUPT_VIDEO", "Could not determine the video's frame count.");
}

/** Cut the source clip with ffmpeg when the request asks for a trim.
 *  Re-encodes so the cut is frame-exact (a stream copy would snap to
 *  keyframes and break the trajectory's frame count). */
async function trimSource(src: string, jobId: string, startSec: number, durationSec: number | undefined, signal: AbortSignal): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const out = join(CACHE_DIR, `${jobId}-src.mp4`);
  const args = ["-nostdin", "-y", "-ss", String(startSec), "-i", src];
  if (durationSec !== undefined) args.push("-t", String(durationSec));
  args.push("-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", out);
  const r = await ffmpegService.ffmpegExec(args, "world-trim", { signal });
  if (r.exitCode !== 0 || !existsSync(out)) {
    throw new WorldError(422, "TRIM_FAILED", `Trimming the source clip failed: ${r.stderr.slice(-400)}`);
  }
  return out;
}

function finish(j: WorldJob & { controller: AbortController }, status: WorldJobStatus, error?: { code: string; message: string }): void {
  j.status = status;
  j.error = error ?? null;
  j.finishedAt = new Date().toISOString();
}

function abortError(j: WorldJob & { controller: AbortController }): boolean {
  if (!j.controller.signal.aborted) return false;
  finish(j, "cancelled", { code: "CANCELLED", message: "Job cancelled." });
  return true;
}

async function runWorldJob(j: WorldJob & { controller: AbortController }, srcAbs: string, fps: number | null): Promise<void> {
  const { request } = j;
  const signal = j.controller.signal;
  let uploadPath = srcAbs;
  try {
    // 1. Optional trim → probe the actual file for fps + frame count.
    j.status = "preparing";
    if (request.startSec !== undefined || request.durationSec !== undefined) {
      uploadPath = await trimSource(srcAbs, j.id, request.startSec ?? 0, request.durationSec, signal);
    }
    if (abortError(j)) return;
    const p = await probe(uploadPath);
    const effectiveFps = p.fps ?? fps;
    if (!effectiveFps || effectiveFps <= 0) {
      throw new WorldError(422, "CORRUPT_VIDEO", "Could not determine the video's frame rate.");
    }
    const frames = await videoFrameCount(uploadPath, { fps: effectiveFps, durationSeconds: p.durationSeconds });

    // 2. Generate the target trajectory from the preset — the same shared
    //    math that drew the UI preview.
    const mats = computeCameraTrajectory(request.preset as WorldCamPresetId, { frames, strength: request.strength });
    const trajTxt = serializeTrajectoryTxt(mats);
    const trajPath = join(CACHE_DIR, `${j.id}-traj.txt`);
    writeFileSync(trajPath, trajTxt);
    if (abortError(j)) return;

    // 3. Upload + start the remote job.
    j.status = "uploading";
    const { jobId } = await submitWorkerJob(
      {
        videoPath: uploadPath,
        trajectoryTxt: trajTxt,
        prompt: request.prompt,
        outputId: `twio_${j.id.replace(/-/g, "")}`,
        seed: request.seed,
        trajScale: request.trajScale,
        depthMode: "auto",
      },
      signal,
    );
    j.remoteJobId = jobId;
    j.status = "running";
    if (abortError(j)) {
      await cancelWorkerJob(jobId);
      return;
    }

    // 4. Poll until the worker finishes (or the job is cancelled locally).
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (abortError(j)) {
        await cancelWorkerJob(jobId);
        return;
      }
      const st = await workerJobStatus(jobId, signal).catch((e) => {
        // Transient network blips shouldn't kill a long GPU job — keep
        // polling, but surface the last error in the log tail.
        j.logTail = `status poll failed: ${(e as Error).message}`;
        return null;
      });
      if (!st) continue;
      j.remotePhase = st.phase ?? j.remotePhase;
      if (st.log_tail) j.logTail = st.log_tail.slice(-2000);
      if (st.status === "done") break;
      if (st.status === "failed" || st.status === "cancelled") {
        throw new WorldError(502, "WORKER_JOB_FAILED", st.error || `Remote job ${st.status} — check the worker log tail.`);
      }
    }

    // 5. Download pred.mp4 into the project's assets folder and register it
    //    like any other local media (content-addressed, probed, thumbnailed).
    j.status = "downloading";
    const project = getProject(j.projectId)!;
    const dir = projectAssetDir(project.slug, "world");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outPath = join(dir, `worldcam-${request.preset}-${stamp}.mp4`);
    await downloadWorkerResult(jobId, "pred.mp4", outPath, signal);
    const sha = await sha256File(outPath);
    await syncProjectAssets(j.projectId);
    const resultAssetId = `LOCAL_${j.projectId}_${sha.slice(0, 16)}`;
    j.resultAssetId = getAsset(resultAssetId) ? resultAssetId : null;
    j.resultPath = outPath;
    j.resultUrl = fileUrl(outPath);
    finish(j, "done");
  } catch (e) {
    if (abortError(j)) return;
    const err = e as WorldError;
    finish(j, "failed", { code: err.code ?? "WORLD_ERROR", message: err.message });
  } finally {
    // Upload staging is single-use — clean the trimmed clip + trajectory.
    if (uploadPath !== srcAbs) {
      try { unlinkSync(uploadPath); } catch { /* already gone */ }
    }
    try { unlinkSync(join(CACHE_DIR, `${j.id}-traj.txt`)); } catch { /* already gone */ }
  }
}

export function startWorldJob(projectId: string, raw: unknown): WorldJob {
  for (const j of jobs.values()) {
    if (j.status !== "done" && j.status !== "failed" && j.status !== "cancelled") {
      throw new WorldError(409, "JOB_IN_PROGRESS", "Another World Cam job is already running.");
    }
  }
  const parsed = worldCamRequestSchema.safeParse(raw);
  if (!parsed.success) throw new WorldError(400, "INVALID_REQUEST", parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;

  const project = getProject(projectId);
  if (!project || project.isVirtual) throw new WorldError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);

  const a = getAsset(request.assetId);
  if (!a || a.project_id !== projectId) {
    throw new WorldError(404, "ASSET_NOT_FOUND", `Video asset not found in this project: ${request.assetId}`);
  }
  if (!a.local_path) {
    throw new WorldError(422, "VIDEO_NOT_DOWNLOADED", `Asset "${a.title ?? a.id}" has no downloaded file — download it first.`);
  }
  const srcAbs = assetAbsolutePath(a.local_path);
  if (!existsSync(srcAbs)) {
    throw new WorldError(404, "VIDEO_FILE_MISSING", `The asset's file is missing on disk: ${a.local_path}`);
  }

  const job: WorldJob & { controller: AbortController } = {
    id: randomUUID(),
    projectId,
    status: "preparing",
    remotePhase: null,
    logTail: "",
    error: null,
    request,
    sourceAssetId: a.id,
    remoteJobId: null,
    resultAssetId: null,
    resultUrl: null,
    resultPath: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  void runWorldJob(job, srcAbs, a.fps ?? null);
  return publicJob(job);
}

/** Convenience for the route layer: everything the presets endpoint emits. */
export function worldPresets() {
  return { presets: WORLD_CAM_PRESETS };
}
