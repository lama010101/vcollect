// =============================================================================
// Core routes — whole-project acquire, review actions, dashboard, LLM status,
// health. Small endpoints that don't merit their own module.
//   POST /api/acquire?project=            background full-project discovery
//   GET  /api/acquire/progress            poll progress
//   POST /api/acquire/reserve?project=    acquire the reserve pool
//   POST /api/review/:shotId/:assetId     KEEP / REJECT / ... (PRD §23)
//   GET  /api/dashboard?project=          license/rights summary (PRD §24)
//   GET  /api/llm-status                  LLM script-parser availability
//   GET  /api/health                      liveness probe
// =============================================================================

import type { FastifyInstance } from "fastify";
import { DEFAULT_PROJECT_ID, PROJECT_ID_ALL, reviewRequestSchema } from "@twio/shared";
import { acquireAll, acquireAllProgress } from "../acquisition/pipeline.js";
import { acquireReserve } from "../acquisition/runner.js";
import {
  cancelTasksForAsset,
  hasActiveTaskForAsset,
  startAcquireAssetTask,
} from "../acquisition/tasks.js";
import { getAsset } from "../db/repository.js";
import { checkLlmStatus } from "../import/llmParser.js";
import { getDashboard } from "./dashboard.js";
import { applyReview } from "./review.js";
import { projectOfQuery } from "./helpers.js";

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  // --- MODE C: acquire -------------------------------------------------------
  // Per-shot / per-asset / batch acquisition runs as tracked tasks via the
  // /api/tasks/* routes below (concurrent, pause/resume/cancel per task).
  // Full acquisition runs in the background; client polls /api/acquire/progress.
  app.post("/api/acquire", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (acquireAllProgress.running) {
      return { alreadyRunning: true, progress: acquireAllProgress };
    }
    // Fire-and-forget — the client polls progress.
    acquireAll(undefined, projectId).catch((e) => console.error("[acquire] fatal:", e));
    return { started: true, total: 100, projectId };
  });
  app.get("/api/acquire/progress", async () => acquireAllProgress);
  app.post("/api/acquire/reserve", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    return acquireReserve(projectId === PROJECT_ID_ALL ? DEFAULT_PROJECT_ID : projectId);
  });

  // --- MODE B: review (PRD §23) ----------------------------------------------
  app.post("/api/review/:shotId/:assetId", async (req, reply) => {
    const { shotId, assetId } = req.params as { shotId: string; assetId: string };
    const parsed = reviewRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const r = applyReview(shotId, assetId, parsed.data);
    // Acquire only discovers candidates — KEEP is what downloads the clip.
    // The download runs as a tracked task (pause / resume / cancel from the
    // tasks panel). REJECT cancels a pending kept-download for that asset.
    if (r.ok && parsed.data.action === "KEEP") {
      const a = getAsset(assetId);
      if (a && !a.local_path && a.download_url && !hasActiveTaskForAsset(assetId)) {
        startAcquireAssetTask(assetId);
      }
    }
    if (r.ok && parsed.data.action === "REJECT") {
      cancelTasksForAsset(assetId);
    }
    return r;
  });

  // --- Dashboard (PRD §24) ---------------------------------------------------
  app.get("/api/dashboard", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    return getDashboard(projectId);
  });

  // --- LLM status (for the script import UI toggle) --------------------------
  app.get("/api/llm-status", async () => {
    const status = await checkLlmStatus();
    return status;
  });

  // --- Health ----------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));
}
