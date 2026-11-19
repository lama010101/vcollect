// =============================================================================
// Engine routes — /api/engine/*
//   GET  status   → interpreter/venv/deps status + setup phase (non-blocking)
//   POST setup    → kick managed-venv provisioning in the background
//   POST call     → { method, params } → CONSTRAINED worker RPC (diagnostics)
//
// /api/engine/call is not a raw passthrough: only whitelisted worker methods
// are accepted, every path param must resolve inside OUTPUT_ROOT, and the
// ffmpeg binary / model dir are always server-chosen (never client-supplied).
// Real features (keying, stem signals, separation jobs) go through their own
// routes which build params themselves.
// =============================================================================

import type { FastifyInstance } from "fastify";
import { resolve, sep } from "node:path";
import { OUTPUT_ROOT } from "../config.js";
import { MODELS_DIR } from "../visualizer/keying.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { engineClient } from "../python/engineClient.js";
import { engineStatus, kickEngineSetup } from "../python/pythonService.js";

class EngineRouteError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

/** Methods the diagnostic route may invoke. `shutdown` is excluded (it just
 *  kills the worker — the next call respawns it anyway). */
const ALLOWED_METHODS = new Set(["ping", "sep_status", "analyze_stem", "key_video", "separate_stems"]);

/** Resolve a caller-supplied path and require it to stay inside OUTPUT_ROOT —
 *  the engine worker writes output files wherever it's pointed, so paths are
 *  the sandbox boundary. Case-insensitive compare on win32. */
function insideOutputRoot(raw: unknown, what: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new EngineRouteError(400, `${what} is required`);
  }
  const abs = resolve(raw.trim());
  const root = OUTPUT_ROOT.toLowerCase();
  const lower = abs.toLowerCase();
  if (lower !== root && !lower.startsWith(root + sep.toLowerCase())) {
    throw new EngineRouteError(400, `${what} must resolve inside OUTPUT_ROOT`);
  }
  return abs;
}

function numIn(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

function intIn(v: unknown, min: number, max: number): number | undefined {
  const n = numIn(v, min, max);
  return n === undefined ? undefined : Math.round(n);
}

/** Build safe params for a whitelisted method — client params are read
 *  selectively; anything not listed here is dropped. */
function buildParams(method: string, raw: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case "ping":
    case "sep_status":
      return {};
    case "analyze_stem": {
      const sr = intIn(raw.sr, 1000, 384000);
      if (sr === undefined) throw new EngineRouteError(400, "sr is required (sample rate in Hz)");
      const p: Record<string, unknown> = {
        pcm_path: insideOutputRoot(raw.pcm_path, "pcm_path"),
        out_dir: insideOutputRoot(raw.out_dir, "out_dir"),
        sr,
      };
      if (raw.progress_path != null) p.progress_path = insideOutputRoot(raw.progress_path, "progress_path");
      return p;
    }
    case "key_video": {
      const p: Record<string, unknown> = {
        video_path: insideOutputRoot(raw.video_path, "video_path"),
        out_path: insideOutputRoot(raw.out_path, "out_path"),
        // Server-chosen — a client-supplied ffmpeg_path would be arbitrary
        // command execution inside the worker.
        ffmpeg_path: ffmpegService.ffmpegPath(),
        models_dir: MODELS_DIR,
      };
      if (typeof raw.model === "string" && raw.model) p.model = raw.model.slice(0, 40);
      if (typeof raw.despill === "boolean") p.despill = raw.despill;
      const feather = numIn(raw.feather, 0, 20); if (feather !== undefined) p.feather = feather;
      const smooth = numIn(raw.smooth, 0, 1); if (smooth !== undefined) p.smooth = smooth;
      const maxDim = intIn(raw.max_dim, 16, 7680); if (maxDim !== undefined) p.max_dim = maxDim;
      if (raw.progress_path != null) p.progress_path = insideOutputRoot(raw.progress_path, "progress_path");
      return p;
    }
    case "separate_stems": {
      const p: Record<string, unknown> = {
        src_path: insideOutputRoot(raw.src_path, "src_path"),
        out_dir: insideOutputRoot(raw.out_dir, "out_dir"),
        quality: raw.quality === "hq" ? "hq" : "fast",
      };
      if (raw.progress_path != null) p.progress_path = insideOutputRoot(raw.progress_path, "progress_path");
      return p;
    }
    default:
      throw new EngineRouteError(400, `method must be one of: ${[...ALLOWED_METHODS].join(", ")}`);
  }
}

export async function registerEngineRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/engine/status", async () => engineStatus());

  app.post("/api/engine/setup", async () => {
    kickEngineSetup();
    return engineStatus();
  });

  app.post("/api/engine/call", async (req, reply) => {
    const body = (req.body ?? {}) as { method?: string; params?: Record<string, unknown>; timeoutMs?: number };
    if (!body.method || typeof body.method !== "string") {
      return reply.code(400).send({ error: "method is required" });
    }
    if (!ALLOWED_METHODS.has(body.method)) {
      return reply.code(400).send({ error: `method must be one of: ${[...ALLOWED_METHODS].join(", ")}` });
    }
    try {
      // ffmpegPath() throws until ensure() has resolved the binary once.
      await ffmpegService.ensure();
      const params = buildParams(body.method, body.params ?? {});
      const result = await engineClient.call(body.method, params, {
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return { ok: true, result };
    } catch (e) {
      if (e instanceof EngineRouteError) {
        return reply.code(e.statusCode).send({ error: e.message });
      }
      const err = e as Error & { code?: string };
      return reply.code(502).send({ ok: false, error: { code: err.code ?? "ENGINE_ERROR", message: err.message } });
    }
  });
}
