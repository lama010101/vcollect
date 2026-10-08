// =============================================================================
// World Cam remote client — talks to inspatio_worker.py running on a GPU host
// (Kaggle + cloudflared quick tunnel; see docs/inspatio-kaggle-setup.md).
//
// The endpoint URL comes from config.inspatioEndpoint (INSPATIO_ENDPOINT) or a
// runtime override set via PUT /api/world/endpoint — trycloudflare URLs rotate
// every Kaggle session, so the override avoids editing .env.local mid-flight.
// An optional shared bearer token (INSPATIO_TOKEN) is sent on every request.
// =============================================================================

import { openAsBlob, createWriteStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { WorldError } from "./errors.js";

// --- Endpoint resolution --------------------------------------------------------

let endpointOverride: string | null = null;

/** Normalize an endpoint URL (strip trailing slashes). Throws on bad input. */
export function normalizeEndpoint(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) {
    throw new WorldError(400, "BAD_ENDPOINT", `Endpoint must be an http(s) URL, got "${raw}".`);
  }
  return s;
}

export function worldEndpoint(): string {
  const ep = endpointOverride ?? (config.inspatioEndpoint ? normalizeEndpoint(config.inspatioEndpoint) : "");
  if (!ep) {
    throw new WorldError(
      503,
      "WORLD_NOT_CONFIGURED",
      "No InSpatio worker endpoint configured. Set INSPATIO_ENDPOINT in .env.local (or save the tunnel URL on the World Cam tab) — see docs/inspatio-kaggle-setup.md.",
    );
  }
  return ep;
}

export function setWorldEndpoint(url: string | null): void {
  endpointOverride = url ? normalizeEndpoint(url) : null;
}

export function worldEndpointInfo(): { endpoint: string; source: "override" | "env" | null } {
  if (endpointOverride) return { endpoint: endpointOverride, source: "override" };
  if (config.inspatioEndpoint) return { endpoint: normalizeEndpoint(config.inspatioEndpoint), source: "env" };
  return { endpoint: "", source: null };
}

function authHeaders(): Record<string, string> {
  return config.inspatioToken ? { Authorization: `Bearer ${config.inspatioToken}` } : {};
}

async function parseError(r: Response, what: string): Promise<never> {
  let detail = r.statusText;
  try {
    const body = (await r.json()) as { error?: string; detail?: string };
    detail = body.error ?? body.detail ?? detail;
  } catch {
    /* non-JSON body */
  }
  const status = r.status === 401 || r.status === 403 ? 502 : r.status;
  const code =
    r.status === 409 ? "WORKER_BUSY"
    : r.status === 404 ? "WORKER_JOB_NOT_FOUND"
    : r.status === 401 || r.status === 403 ? "WORKER_AUTH_FAILED"
    : "WORKER_ERROR";
  throw new WorldError(status, code, `${what} failed (${r.status}): ${detail}`);
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ep = worldEndpoint();
  let r: Response;
  try {
    r = await fetch(`${ep}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch (e) {
    throw new WorldError(502, "WORKER_UNREACHABLE", `Cannot reach the InSpatio worker at ${ep} — is the GPU host and cloudflared tunnel up? [${(e as Error).message}]`);
  }
  return r;
}

// --- API -------------------------------------------------------------------------

export interface RemoteHealth {
  ok: boolean;
  gpu?: string;
  cuda?: string;
  torch?: string;
  checkpoints?: Record<string, boolean>;
  busy?: boolean;
  root?: string;
}

export async function workerHealth(): Promise<RemoteHealth> {
  const r = await fetchWorker("/health");
  if (!r.ok) return parseError(r, "health check");
  return (await r.json()) as RemoteHealth;
}

export interface SubmitJobParams {
  videoPath: string;
  trajectoryTxt: string;
  prompt: string;
  outputId: string;
  seed: number;
  trajScale: number;
  depthMode: "auto" | "existing" | "estimate";
}

/** Upload video + trajectory and start a remote inference job. */
export async function submitWorkerJob(p: SubmitJobParams, signal?: AbortSignal): Promise<{ jobId: string }> {
  const form = new FormData();
  let videoBlob: Blob;
  try {
    videoBlob = await openAsBlob(p.videoPath);
  } catch {
    videoBlob = new Blob([await readFile(p.videoPath)]);
  }
  form.set("video", videoBlob, basename(p.videoPath));
  form.set("trajectory", new Blob([p.trajectoryTxt], { type: "text/plain" }), "target_tcw.txt");
  form.set("prompt", p.prompt);
  form.set("output_id", p.outputId);
  form.set("seed", String(p.seed));
  form.set("traj_scale", String(p.trajScale));
  form.set("depth_mode", p.depthMode);

  let r: Response;
  try {
    r = await fetch(`${worldEndpoint()}/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
      signal: signal ?? null,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new WorldError(499, "CANCELLED", "Upload cancelled.");
    }
    throw new WorldError(502, "WORKER_UNREACHABLE", `Upload to the InSpatio worker failed: ${(e as Error).message}`);
  }
  if (!r.ok) return parseError(r, "job submit");
  const body = (await r.json()) as { job_id?: string };
  if (!body.job_id) throw new WorldError(502, "WORKER_BAD_RESPONSE", "Worker did not return a job_id.");
  return { jobId: body.job_id };
}

export interface RemoteJobStatus {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  phase?: string;
  log_tail?: string;
  error?: string | null;
}

export async function workerJobStatus(jobId: string, signal?: AbortSignal): Promise<RemoteJobStatus> {
  const r = await fetchWorker(`/jobs/${encodeURIComponent(jobId)}`, { signal: signal ?? null });
  if (!r.ok) return parseError(r, "job status");
  return (await r.json()) as RemoteJobStatus;
}

/** Stream a result file (pred.mp4 / render.mp4 / …) to a local path. */
export async function downloadWorkerResult(jobId: string, file: string, outPath: string, signal?: AbortSignal): Promise<number> {
  const r = await fetchWorker(`/jobs/${encodeURIComponent(jobId)}/result?file=${encodeURIComponent(file)}`, {
    signal: signal ?? null,
  });
  if (!r.ok) return parseError(r, "result download");
  if (!r.body) throw new WorldError(502, "WORKER_BAD_RESPONSE", "Empty result body.");
  await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), createWriteStream(outPath));
  return statSync(outPath).size;
}

export async function cancelWorkerJob(jobId: string): Promise<void> {
  try {
    const r = await fetchWorker(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    if (!r.ok) await parseError(r, "job cancel").catch(() => {});
  } catch {
    /* best-effort */
  }
}
