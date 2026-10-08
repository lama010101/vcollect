// =============================================================================
// World Cam routes — /api/world/*
//   GET  status              endpoint config + remote worker health
//   PUT  endpoint            { endpoint } — runtime override (tunnel URLs rotate)
//   GET  presets             camera-move preset descriptors
//   GET  videos?project=     downloadable video assets (source picker)
//   POST jobs?project=       { assetId, prompt, preset, strength, seed, ... }
//   GET  jobs?project=       job list (active first)
//   GET  jobs/:id            job progress / result
//   POST jobs/:id/cancel
// =============================================================================

import type { FastifyInstance } from "fastify";
import { DEFAULT_PROJECT_ID } from "@twio/shared";
import { WorldError } from "../world/errors.js";
import { setWorldEndpoint, worldEndpointInfo } from "../world/client.js";
import {
  cancelWorldJob,
  getWorldJob,
  listWorldJobs,
  listWorldVideos,
  startWorldJob,
  worldPresets,
  worldStatus,
} from "../world/service.js";

function projectOf(query: unknown): string {
  const q = ((query as Record<string, unknown>).project as string | undefined)?.trim();
  return q || DEFAULT_PROJECT_ID;
}

export async function registerWorldRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/world/status", async () => ({ status: await worldStatus() }));

  app.put("/api/world/endpoint", async (req) => {
    const body = (req.body ?? {}) as { endpoint?: string };
    const raw = typeof body.endpoint === "string" ? body.endpoint : "";
    setWorldEndpoint(raw || null);
    const info = worldEndpointInfo();
    return { ok: true, endpoint: info.endpoint, source: info.source, status: await worldStatus() };
  });

  app.get("/api/world/presets", async () => worldPresets());

  app.get("/api/world/videos", async (req) => ({ videos: listWorldVideos(projectOf(req.query)) }));

  app.post("/api/world/jobs", async (req) => {
    const job = startWorldJob(projectOf(req.query), req.body);
    return { job };
  });

  app.get("/api/world/jobs", async (req) => ({ jobs: listWorldJobs(projectOf(req.query)) }));

  app.get("/api/world/jobs/:id", async (req) => ({ job: getWorldJob((req.params as { id: string }).id) }));

  app.post("/api/world/jobs/:id/cancel", async (req) => ({ job: cancelWorldJob((req.params as { id: string }).id) }));
}

// Re-exported so tests can assert the error type without importing internals.
export { WorldError };
