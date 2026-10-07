// =============================================================================
// Visualizer routes — /api/visualizer/*
//   GET    stems?project=            list project audio stems
//   POST   stems?project=&name=      upload a stem (raw body)
//   DELETE stems/:name?project=      remove a stem
//   POST   render?project=           { renderSettings, globalVisuals, stems }
//   GET    render/:id                job progress / result
//   POST   render/:id/cancel
//   GET    renders?project=          rendered MP4s + config sidecars
// =============================================================================

import type { FastifyInstance } from "fastify";
import { basename, join } from "node:path";
import { DEFAULT_PROJECT_ID, visualizerRenderSchema } from "@twio/shared";
import { VisualizerError } from "../visualizer/errors.js";
import { stemSignalPayload, stemSignalPhase } from "../visualizer/signals.js";
import { revealInExplorer } from "./folders.js";
import {
  cancelRenderJob,
  deleteStem,
  getRenderJob,
  listRenders,
  listStems,
  MAX_SONG_BYTES,
  saveStem,
  startRenderJob,
  stemPath,
  visualizerDir,
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

  // Open the renders folder (or a specific rendered file selected) in the OS
  // file explorer — basename() keeps the path inside the renders dir.
  app.post("/api/visualizer/reveal", async (req) => {
    const name = String((req.query as Record<string, unknown>).name ?? "");
    const dir = visualizerDir(projectOf(req.query), "renders");
    return revealInExplorer(name ? join(dir, basename(name)) : dir);
  });
}
