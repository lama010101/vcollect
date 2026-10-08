// =============================================================================
// Video keying — engine-baked VP9-alpha "keyed" WebMs for the AI cutout method.
//
// `ensureKeyedVideo` maps (asset file, key params) → OUTPUT_ROOT/cache/keys/
// key-<hash>.webm via the Python engine's `key_video` RPC. The hash is
// content-addressed (path+size+mtime+params), so identical requests share one
// artifact across projects — like cache/beats and cache/engine. The WebM
// carries the alpha in the pixels themselves, so the browser preview (<video>
// element) and the MP4 export (libvpx decoder → rgba) composite the identical
// frames — parity by construction.
//
// Jobs are in-memory (like render jobs) so the UI can poll progress; the same
// cache key dedupes concurrent requests for identical params.
// =============================================================================

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VizVideoKeyConfig } from "@twio/shared";
import { OUTPUT_ROOT } from "../config.js";
import { engineClient } from "../python/engineClient.js";
import { engineStatus } from "../python/pythonService.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { fileUrl } from "../musicEdit/service.js";
import { VisualizerError } from "./errors.js";

const KEYING_VERSION = 1; // bump when params↔output mapping changes
const MODELS_DIR = resolve(OUTPUT_ROOT, "cache", "models");
const KEYS_DIR = resolve(OUTPUT_ROOT, "cache", "keys");

export interface KeyedVideoResult {
  path: string;
  url: string;
  cached: boolean;
  keyId: string;
}

interface KeyJobProgress {
  done: number;
  total: number;
}

export interface VizKeyJob {
  id: string;
  keyId: string;
  projectId: string;
  status: "running" | "done" | "failed" | "cancelled";
  progress: KeyJobProgress;
  error: { code: string; message: string } | null;
  url: string | null;
  /** Absolute path of the produced keyed WebM (when done). */
  path: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, VizKeyJob & { controller: AbortController }>();
const jobsByKey = new Map<string, string>(); // keyId → jobId (running only)
const inflight = new Map<string, Promise<KeyedVideoResult>>();

function publicJob(j: VizKeyJob & { controller: AbortController }): VizKeyJob {
  const { controller: _c, ...rest } = j;
  return rest;
}

/** Deterministic cache identity for (video file content-token, key params). */
function keyHash(srcPath: string, key: VizVideoKeyConfig): string {
  const st = statSync(srcPath);
  const h = createHash("sha1");
  h.update(srcPath);
  h.update(String(st.size));
  h.update(String(st.mtimeMs));
  h.update(JSON.stringify({
    v: KEYING_VERSION,
    method: key.method,
    model: key.model,
    despill: key.despill,
    feather: key.feather,
  }));
  return h.digest("hex").slice(0, 24);
}

function mapEngineError(e: unknown): never {
  const err = e as Error & { code?: string };
  const code = err.code ?? "ENGINE_ERROR";
  if (code === "MISSING_DEP") {
    throw new VisualizerError(503, "ENGINE_UNAVAILABLE", `Python engine is missing dependencies: ${err.message}`);
  }
  if (
    code === "ENGINE_DISABLED" || code === "ENGINE_NO_PYTHON" || code === "ENGINE_VENV_FAILED" ||
    code === "ENGINE_DEPS_FAILED" || code === "WORKER_SPAWN_FAILED" || code === "WORKER_DIED"
  ) {
    throw new VisualizerError(503, "ENGINE_UNAVAILABLE", err.message);
  }
  if (code === "CANCELLED" || err.name === "AbortError") {
    throw new VisualizerError(499, "RENDER_CANCELLED", "Keying cancelled.");
  }
  if (code === "MODEL_UNKNOWN" || code === "BAD_PARAMS") {
    throw new VisualizerError(400, code, err.message);
  }
  if (code === "MODEL_DOWNLOAD_FAILED" || code === "MODEL_HASH_MISMATCH" || code === "CORRUPT_VIDEO") {
    throw new VisualizerError(422, code, err.message);
  }
  throw new VisualizerError(500, code, err.message);
}

/** Build (or fetch from cache) the keyed WebM for a video + key config.
 *  Throws ENGINE_REQUIRED (422) when the engine isn't provisioned — same
 *  contract as the spectrum mode. */
export async function ensureKeyedVideo(
  projectId: string,
  srcAbsPath: string,
  key: VizVideoKeyConfig,
  opts: { signal?: AbortSignal; onProgress?: (p: KeyJobProgress) => void } = {},
): Promise<KeyedVideoResult> {
  const keyId = keyHash(srcAbsPath, key);
  const outPath = join(KEYS_DIR, `key-${keyId}.webm`);
  if (existsSync(outPath)) return { path: outPath, url: fileUrl(outPath), cached: true, keyId };

  // Share one in-flight build per cache key across callers/jobs.
  const existing = inflight.get(keyId);
  if (existing) return existing;

  const run = (async (): Promise<KeyedVideoResult> => {
    const status = await engineStatus();
    if (!status.ok) {
      throw new VisualizerError(
        422,
        "ENGINE_REQUIRED",
        'AI cutout needs the Python engine. Run POST /api/engine/setup first (the UI shows a Setup button when it isn\'t provisioned).',
      );
    }
    // The engine writes `<out>.part` then os.replace()s it into place — the
    // target must live on the same volume as the final file, so we pass the
    // real outPath (never a tempdir) and clean strays on failure.
    mkdirSync(KEYS_DIR, { recursive: true });
    const progressPath = outPath + ".progress";
    rmSync(progressPath, { force: true });
    const poll = setInterval(() => {
      try {
        if (existsSync(progressPath)) {
          const p = JSON.parse(readFileSync(progressPath, "utf8")) as KeyJobProgress;
          if (Number.isFinite(p.done)) opts.onProgress?.({ done: p.done, total: p.total ?? 0 });
        }
      } catch {
        /* progress file mid-write — skip */
      }
    }, 300);
    try {
      await engineClient.call(
        "key_video",
        {
          video_path: srcAbsPath,
          out_path: outPath,
          ffmpeg_path: ffmpegService.ffmpegPath(),
          models_dir: MODELS_DIR,
          model: key.model,
          despill: key.despill,
          feather: key.feather,
          progress_path: progressPath,
        },
        { signal: opts.signal },
      );
      opts.onProgress?.({ done: 1, total: 1 });
      return { path: outPath, url: fileUrl(outPath), cached: false, keyId };
    } catch (e) {
      // Abort kills the worker → the pending call rejects as WORKER_KILLED;
      // surface the caller's intent, not the transport detail.
      if (opts.signal?.aborted) throw new VisualizerError(499, "RENDER_CANCELLED", "Keying cancelled.");
      mapEngineError(e);
    } finally {
      clearInterval(poll);
      rmSync(outPath + ".part", { force: true });
      rmSync(progressPath, { force: true });
      inflight.delete(keyId);
    }
  })();
  inflight.set(keyId, run);
  try {
    return await run;
  } finally {
    // Keep the map entry only until the settled promise is consumed.
    inflight.delete(keyId);
  }
}

/** Fire-and-poll variant for the UI: returns a tracked job immediately. */
export function startKeyJob(projectId: string, srcAbsPath: string, key: VizVideoKeyConfig): VizKeyJob {
  const keyId = keyHash(srcAbsPath, key);
  const outPath = join(KEYS_DIR, `key-${keyId}.webm`);
  if (existsSync(outPath)) {
    return {
      id: "cached",
      keyId,
      projectId,
      status: "done",
      progress: { done: 1, total: 1 },
      error: null,
      url: fileUrl(outPath),
      path: outPath,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
  const running = jobsByKey.get(keyId);
  if (running) {
    const j = jobs.get(running);
    if (j && j.status === "running") return publicJob(j);
  }
  const job: VizKeyJob & { controller: AbortController } = {
    id: randomUUID(),
    keyId,
    projectId,
    status: "running",
    progress: { done: 0, total: 0 },
    error: null,
    url: null,
    path: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  jobsByKey.set(keyId, job.id);
  ensureKeyedVideo(projectId, srcAbsPath, key, {
    signal: job.controller.signal,
    onProgress: (p) => (job.progress = p),
  })
    .then((r) => {
      job.status = "done";
      job.url = r.url;
      job.path = r.path;
    })
    .catch((e: Error & { code?: string }) => {
      job.status = job.controller.signal.aborted || e.name === "AbortError" ? "cancelled" : "failed";
      job.error = { code: e.code ?? "KEYING_FAILED", message: e.message };
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      jobsByKey.delete(keyId);
    });
  return publicJob(job);
}

export function getKeyJob(id: string): VizKeyJob {
  const j = jobs.get(id);
  if (!j) throw new VisualizerError(404, "KEY_JOB_NOT_FOUND", `Keying job not found: ${id}`);
  return publicJob(j);
}

export function cancelKeyJob(id: string): VizKeyJob {
  const j = jobs.get(id);
  if (!j) throw new VisualizerError(404, "KEY_JOB_NOT_FOUND", `Keying job not found: ${id}`);
  if (j.status === "running") j.controller.abort();
  return publicJob(j);
}
