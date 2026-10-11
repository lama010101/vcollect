// =============================================================================
// Shot routes — MODE A search target list + shot↔asset curation links
//   GET    /api/shots?project=              list shots
//   GET    /api/shots/:id                   shot + assets + shot_assets links
//   POST   /api/shots                       create a shot (manual add-shot form)
//   DELETE /api/shots/:id                   delete a shot
//   PATCH  /api/shots/:id                   X/Y/Z overrides + timeline membership
//   POST   /api/shots/:id/assets            link an asset (idempotent)
//   DELETE /api/shots/:id/assets/:assetId   unlink an asset
//   PATCH  /api/shots/:id/assets/:assetId   flag/unflag the on_rail candidate
// =============================================================================

import type { FastifyInstance } from "fastify";
import {
  createShotSchema,
  MAX_POOL_PER_SHOT,
  PROJECT_ID_ALL,
  sectionFolder,
} from "@twio/shared";
import {
  addAssetToShot,
  createShot,
  deleteShot,
  getAsset,
  getShot,
  getTimeline,
  listAssetsForShot,
  listShots,
  listShotAssets,
  nextShotNumber,
  removeAssetFromShot,
  setShotAssetOnRail,
  setShotTimeRange,
  setShotTimeline,
  updateShotAcquireSettings,
} from "../db/repository.js";
import { getProject } from "../db/projectRepository.js";
import { assetAbsolutePath } from "./folders.js";
import { clampInt, clampNum, projectOfQuery } from "./helpers.js";

export async function registerShotRoutes(app: FastifyInstance): Promise<void> {
  // --- Shots (MODE A search target list) -------------------------------------
  app.get("/api/shots", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    return { shots: listShots(projectId) };
  });
  app.get("/api/shots/:id", async (req) => {
    const { id } = req.params as { id: string };
    const shot = getShot(id);
    const assets = listAssetsForShot(id).map((a) => {
      if (!a.local_path) return a;
      const folder = sectionFolder(shot?.section ?? "SEARCH");
      return {
        ...a,
        absolute_path: assetAbsolutePath(a.local_path),
        folder,
        folder_section: shot?.section ?? null,
      };
    });
    return { shot, assets, shotAssets: listShotAssets(id) };
  });

  // Create a shot (manual add-shot form).
  app.post("/api/shots", async (req, reply) => {
    const parsed = createShotSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { projectId, section, searchQuery, visualDescription, targetDurationSeconds, priority, lyrics, referenceImageUrl } = parsed.data;
    if (projectId === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot create a shot in All Projects" });
    if (!getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const num = nextShotNumber(projectId);
    const id = `${projectId}_SHOT_${String(num).padStart(3, "0")}`;
    const shot = createShot({
      id,
      projectId,
      shotNumber: num,
      section,
      visualDescription,
      searchQuery,
      targetDurationSeconds: targetDurationSeconds ?? null,
      priority: priority ?? 5,
      lyrics: lyrics ?? null,
      referenceImageUrl: referenceImageUrl ?? null,
    });
    return reply.code(201).send({ shot });
  });
  app.delete("/api/shots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getShot(id)) return reply.code(404).send({ error: "shot not found" });
    deleteShot(id);
    return { ok: true, id };
  });

  // Update a shot's per-shot acquisition priority overrides (X/Y/Z) and/or
  // its timeline membership + absolute time range.
  // Body fields are all optional; null clears the override/value.
  app.patch("/api/shots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      minCandidates?: number | null;
      acquireCount?: number | null;
      minAcquireRating?: number | null;
      timelineId?: string | null;
      timeStart?: number | null;
      timeEnd?: number | null;
    };
    const shot = getShot(id);
    if (!shot) return reply.code(404).send({ error: "shot not found" });

    // X/Y/Z acquisition overrides.
    const minCandidates = clampInt(body.minCandidates, 1, MAX_POOL_PER_SHOT, undefined);
    const acquireCount = clampInt(body.acquireCount, 1, 20, undefined);
    const minAcquireRating = clampNum(body.minAcquireRating, 0, 1, undefined);
    // Only write X/Y/Z when the field was actually provided (undefined = leave
    // unchanged; null = clear). This lets the same PATCH update times only.
    if (minCandidates !== undefined || acquireCount !== undefined || minAcquireRating !== undefined) {
      updateShotAcquireSettings(id, {
        minCandidates: minCandidates ?? null,
        acquireCount: acquireCount ?? null,
        minAcquireRating: minAcquireRating ?? null,
      });
    }

    // Timeline membership.
    if (body.timelineId !== undefined) {
      const tlId = body.timelineId === null ? null : String(body.timelineId);
      if (tlId !== null && !getTimeline(tlId, shot.project_id)) {
        return reply.code(400).send({ error: `timeline not found: ${tlId}` });
      }
      setShotTimeline(id, tlId);
    }

    // Absolute timeline position (seconds). end must be >= start when both set.
    if (body.timeStart !== undefined || body.timeEnd !== undefined) {
      const start = (body.timeStart === undefined ? shot.time_start_seconds : clampNum(body.timeStart, 0, 1e9, null)) ?? null;
      const end = (body.timeEnd === undefined ? shot.time_end_seconds : clampNum(body.timeEnd, 0, 1e9, null)) ?? null;
      if (start != null && end != null && end < start) {
        return reply.code(400).send({ error: "timeEnd must be >= timeStart" });
      }
      setShotTimeRange(id, start, end);
    }

    const refreshed = getShot(id)!;
    return {
      ok: true,
      id,
      minCandidates: refreshed.min_candidates,
      acquireCount: refreshed.acquire_count,
      minAcquireRating: refreshed.min_acquire_rating,
      timelineId: refreshed.timeline_id,
      timeStart: refreshed.time_start_seconds,
      timeEnd: refreshed.time_end_seconds,
    };
  });

  // Link an existing asset to a shot (manual curation). Idempotent.
  app.post("/api/shots/:id/assets", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { assetId?: string };
    const assetId = (body.assetId ?? "").toString();
    if (!assetId) return reply.code(400).send({ error: "assetId required" });
    if (!getShot(id)) return reply.code(404).send({ error: "shot not found" });
    if (!getAsset(assetId)) return reply.code(404).send({ error: "asset not found" });
    addAssetToShot(id, assetId);
    return { ok: true, shotId: id, assetId };
  });
  // Unlink an asset from a shot (does not delete the asset row).
  app.delete("/api/shots/:id/assets/:assetId", async (req) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    removeAssetFromShot(id, assetId);
    return { ok: true, shotId: id, assetId };
  });
  // Flag/unflag a linked candidate for the shot's Timeline-page rail
  // ("ADD TO TIMELINE" on Shot Review). The rail always shows on_rail
  // candidates even when they rank beyond its display cap.
  app.patch("/api/shots/:id/assets/:assetId", async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    const body = (req.body ?? {}) as { onRail?: unknown };
    if (typeof body.onRail !== "boolean") return reply.code(400).send({ error: "onRail boolean required" });
    if (!getShot(id)) return reply.code(404).send({ error: "shot not found" });
    if (!setShotAssetOnRail(id, assetId, body.onRail)) {
      return reply.code(404).send({ error: "asset not linked to shot" });
    }
    return { ok: true, shotId: id, assetId, onRail: body.onRail };
  });
}
