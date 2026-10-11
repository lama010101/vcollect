// =============================================================================
// Visualizer routes — /api/visualizer/*
//   GET    stems?project=            list project audio stems
//   POST   stems?project=&name=      upload a stem (raw body)
//   DELETE stems/:name?project=      remove a stem
//   POST   render?project=           { renderSettings, globalVisuals, stems }
//   GET    render/:id                job progress / result
//   POST   render/:id/cancel
//   GET    renders?project=          rendered MP4s + config sidecars
//   POST   video-key?project=        { assetId, key } → engine-baked keyed WebM
//   GET    video-key/:id             keying job progress / result
//   POST   video-key/:id/cancel
//   GET    sessions?project=         list saved sessions (metadata)
//   POST   sessions?project=         { name, payload } → create + snapshot media
//   GET    sessions/:id?project=     read one session (with payload)
//   PUT    sessions/:id?project=     { name?, payload? } rename / overwrite
//   DELETE sessions/:id?project=     delete a session
//   POST   sessions/:id/load?project=  restore its media, return the payload
//   POST   sessions/:id/timeline?project=  build a timeline: one shot per layer/stem
//   POST   split-stems?project=&name=&quality=  upload a full song (raw body) →
//                                            engine separates it into stems
//   GET    split-jobs/:id              split job progress / result
//   POST   split-jobs/:id/cancel
//   GET    sep-status                  HQ separation setup state
//   POST   sep-setup                   install torch-cpu + demucs (~600 MB)
// =============================================================================

import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_PROJECT_ID, visualizerRenderSchema, vizSessionSaveSchema, vizSessionUpdateSchema, vizVideoKeySchema } from "@twio/shared";
import { getAsset } from "../db/repository.js";
import { VisualizerError } from "../visualizer/errors.js";
import { kickSeparationSetup, sepStatus } from "../python/pythonService.js";
import { cancelKeyJob, getKeyJob, startKeyJob } from "../visualizer/keying.js";
import { deleteSession, getSession, listSessions, loadSession, saveSession, sessionToTimeline, updateSession } from "../visualizer/sessions.js";
import { stemSignalPayload, stemSignalPhase } from "../visualizer/signals.js";
import { assetAbsolutePath, revealInExplorer } from "./folders.js";
import {
  cancelRenderJob,
  cancelSplitJob,
  deleteStem,
  getRenderJob,
  getSplitJob,
  listRenders,
  listStems,
  MAX_SONG_BYTES,
  saveStem,
  startRenderJob,
  startSplitJob,
  stemPath,
  visualizerDir,
  type VizSplitQuality,
} from "../visualizer/service.js";

function projectOf(query: unknown): string {
  const q = ((query as Record<string, unknown>).project as string | undefined)?.trim();
  return q || DEFAULT_PROJECT_ID;
}

export async function registerVisualizerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/visualizer/stems", async (req) => ({ stems: await listStems(projectOf(req.query)) }));

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ["application/octet-stream", "audio/*"],
      { parseAs: "buffer", bodyLimit: MAX_SONG_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.post("/api/visualizer/stems", async (req) => {
      const name = String((req.query as Record<string, unknown>).name ?? "");
      if (!Buffer.isBuffer(req.body)) {
        throw new VisualizerError(400, "MISSING_AUDIO", "Upload the stem as the raw request body (Content-Type: application/octet-stream).");
      }
      return { stem: await saveStem(projectOf(req.query), name, req.body) };
    });

    // Upload a full song → the engine separates it into stems (lands in the
    // stems pool as "<song> <part>.wav" + the normalized "<song>.wav" mix).
    scope.post("/api/visualizer/split-stems", async (req) => {
      const q = req.query as Record<string, unknown>;
      const name = String(q.name ?? "");
      const quality = q.quality === "hq" ? "hq" : "fast";
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new VisualizerError(400, "MISSING_AUDIO", "Upload the song as the raw request body (Content-Type: application/octet-stream).");
      }
      return { job: await startSplitJob(projectOf(req.query), name, req.body, quality as VizSplitQuality) };
    });
  });

  app.delete("/api/visualizer/stems/:name", async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    deleteStem(projectOf(req.query), name);
    return { ok: true, name };
  });

  // Binary signal payload for the browser preview — the same peaks/env the
  // server renderer consumes, plus engine features when available. Built once
  // per stem content and cached on disk (see visualizer/signals.ts).
  // Layout: [u32 LE metaLen][meta JSON][peaks][env][bands][featEnv][onsetEnv].
  app.get("/api/visualizer/stems/:name/signal", async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const path = stemPath(projectOf(req.query), name);
    const { payload } = await stemSignalPayload(path);
    reply.header("content-type", "application/octet-stream").send(payload);
  });

  // Coarse build phase of the in-flight signal analysis (null when nothing is
  // building — either already cached or never requested).
  app.get("/api/visualizer/stems/:name/signal/status", async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    return { phase: stemSignalPhase(stemPath(projectOf(req.query), name)) };
  });

  app.post("/api/visualizer/render", async (req) => {
    const r = visualizerRenderSchema.safeParse(req.body);
    if (!r.success) throw new VisualizerError(400, "INVALID_REQUEST", r.error.message);
    return { job: startRenderJob(projectOf(req.query), r.data) };
  });

  app.get("/api/visualizer/render/:id", async (req) => ({ job: getRenderJob((req.params as { id: string }).id) }));

  app.post("/api/visualizer/render/:id/cancel", async (req) => ({ job: cancelRenderJob((req.params as { id: string }).id) }));

  app.get("/api/visualizer/renders", async (req) => ({ renders: listRenders(projectOf(req.query)) }));

  // Split-job polling + cancellation (one at a time — the worker serializes).
  app.get("/api/visualizer/split-jobs/:id", async (req) => ({ job: getSplitJob((req.params as { id: string }).id) }));

  app.post("/api/visualizer/split-jobs/:id/cancel", async (req) => ({ job: cancelSplitJob((req.params as { id: string }).id) }));

  // HQ separation extras — the stamp file says installed; setup installs
  // torch-cpu + demucs into the engine venv in the background.
  app.get("/api/visualizer/sep-status", async () => ({ sep: sepStatus() }));

  app.post("/api/visualizer/sep-setup", async () => {
    kickSeparationSetup();
    return { sep: sepStatus() };
  });

  // AI cutout ("keyed") WebM generation — idempotent: a cached build for the
  // same (asset, key params) returns a finished job immediately.
  app.post("/api/visualizer/video-key", async (req) => {
    const projectId = projectOf(req.query);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const assetId = typeof body.assetId === "string" ? body.assetId : "";
    if (!assetId) throw new VisualizerError(400, "MISSING_ASSET", "assetId is required.");
    const parsed = vizVideoKeySchema.safeParse(body.key ?? {});
    if (!parsed.success) throw new VisualizerError(400, "INVALID_REQUEST", parsed.error.message);
    if (parsed.data.method !== "cutout") {
      throw new VisualizerError(400, "INVALID_REQUEST", 'video-key only applies to the "cutout" method.');
    }
    const a = getAsset(assetId);
    if (!a || a.project_id !== projectId) {
      throw new VisualizerError(404, "VIDEO_ASSET_NOT_FOUND", `Video asset not found in this project: ${assetId}`);
    }
    if (!a.local_path) {
      throw new VisualizerError(422, "VIDEO_NOT_DOWNLOADED", `Asset "${a.title ?? a.id}" has no downloaded file — download it first.`);
    }
    const abs = assetAbsolutePath(a.local_path);
    if (!existsSync(abs)) {
      throw new VisualizerError(404, "VIDEO_FILE_MISSING", `The asset's file is missing on disk: ${a.local_path}`);
    }
    return { job: startKeyJob(projectId, abs, parsed.data) };
  });

  app.get("/api/visualizer/video-key/:id", async (req) => ({ job: getKeyJob((req.params as { id: string }).id) }));

  app.post("/api/visualizer/video-key/:id/cancel", async (req) => ({ job: cancelKeyJob((req.params as { id: string }).id) }));

  // Open the renders folder (or a specific rendered file selected) in the OS
  // file explorer — basename() keeps the path inside the renders dir.
  app.post("/api/visualizer/reveal", async (req) => {
    const name = String((req.query as Record<string, unknown>).name ?? "");
    const dir = visualizerDir(projectOf(req.query), "renders");
    return revealInExplorer(name ? join(dir, basename(name)) : dir);
  });

  // --- Sessions (named setups — save/restore settings AND media) ---------------
  app.get("/api/visualizer/sessions", async (req) => ({ sessions: listSessions(projectOf(req.query)) }));

  app.post("/api/visualizer/sessions", async (req) => {
    const r = vizSessionSaveSchema.safeParse(req.body);
    if (!r.success) throw new VisualizerError(400, "INVALID_REQUEST", r.error.message);
    return { session: await saveSession(projectOf(req.query), r.data.name, r.data.payload) };
  });

  app.get("/api/visualizer/sessions/:id", async (req) => ({
    session: getSession(projectOf(req.query), (req.params as { id: string }).id),
  }));

  app.put("/api/visualizer/sessions/:id", async (req) => {
    const r = vizSessionUpdateSchema.safeParse(req.body);
    if (!r.success) throw new VisualizerError(400, "INVALID_REQUEST", r.error.message);
    return { session: await updateSession(projectOf(req.query), (req.params as { id: string }).id, r.data) };
  });

  app.delete("/api/visualizer/sessions/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    deleteSession(projectOf(req.query), id);
    return { ok: true, id };
  });

  // Restores the session's media (stems copied back into the pool, deleted
  // layer files re-registered as local assets) and returns the payload for
  // the client to apply.
  app.post("/api/visualizer/sessions/:id/load", async (req) =>
    loadSession(projectOf(req.query), (req.params as { id: string }).id),
  );

  // Builds a real timeline from the session — one shot per layer-stack row
  // (top→bottom) plus one per stem — so the setup appears on the Timeline
  // page. Media shots get their asset linked onto the shot rail.
  app.post("/api/visualizer/sessions/:id/timeline", async (req) =>
    sessionToTimeline(projectOf(req.query), (req.params as { id: string }).id),
  );
}
