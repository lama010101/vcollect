// =============================================================================
// Timeline routes — project-scoped timelines + background candidate fetch
//   GET    /api/timelines?project=             timelines + shot counts
//   POST   /api/timelines                      create { name, projectId? }
//   PATCH  /api/timelines/:id?project=         rename
//   DELETE /api/timelines/:id?project=         delete
//   GET    /api/timelines/:id/shots?project=   shots + ranked candidates
//   POST   /api/timelines/:id/fetch?project=   background fetch for all shots
//   GET    /api/timelines/:id/fetch/progress   fetch job progress
//   POST   /api/timelines/:id/fetch/cancel     cancel the fetch job
//   POST   /api/timelines/:id/fetch/pause      pause the fetch job
//   POST   /api/timelines/:id/fetch/resume     resume the fetch job
// =============================================================================

import type { FastifyInstance } from "fastify";
import { DEFAULT_PROJECT_ID, PROJECT_ID_ALL } from "@twio/shared";
import {
  createTimeline,
  deleteTimeline,
  getTimeline,
  listShotsByTimeline,
  listShotsWithoutTimeline,
  listTimelineCandidates,
  listTimelinesWithCounts,
  renameTimeline,
  type ShotCandidateRow,
} from "../db/repository.js";
import { getProject } from "../db/projectRepository.js";
import {
  cancelTimelineFetch,
  fetchTimelineBackground,
  pauseTimelineFetch,
  resumeTimelineFetch,
  timelineFetchProgress,
} from "../acquisition/pipeline.js";
import { projectOfQuery } from "./helpers.js";

export async function registerTimelineRoutes(app: FastifyInstance): Promise<void> {
  // --- Timelines (project-scoped) --------------------------------------------
  app.get("/api/timelines", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    const timelines = listTimelinesWithCounts(projectId).map((t) => ({
      id: t.id,
      name: t.name,
      project_id: t.project_id,
      created_at: t.created_at,
      updated_at: t.updated_at,
      shotCount: t.shotCount ?? 0,
    }));
    const unassigned = listShotsWithoutTimeline(projectId).length;
    return { timelines, unassignedShotCount: unassigned };
  });
  app.post("/api/timelines", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; projectId?: string };
    const name = (body.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const projectId = body.projectId ?? DEFAULT_PROJECT_ID;
    if (projectId === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot create a timeline in All Projects" });
    if (!getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const id = `TL_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const tl = createTimeline(id, name, projectId);
    return reply.code(201).send({ timeline: tl });
  });
  app.patch("/api/timelines/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    if (!getTimeline(id, projectId)) return reply.code(404).send({ error: "timeline not found" });
    renameTimeline(id, name);
    return { ok: true, id, name };
  });
  app.delete("/api/timelines/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (!getTimeline(id, projectId)) return reply.code(404).send({ error: "timeline not found" });
    deleteTimeline(id);
    return { ok: true, id };
  });
  // Shots belonging to a timeline (ordered by time_start then shot_number).
  // Each shot carries a `candidates` array (its shot_assets links, ranked) so
  // the Timeline page can render the per-title video rail without N requests.
  app.get("/api/timelines/:id/shots", async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    const tl = getTimeline(id, projectId);
    if (!tl) return reply.code(404).send({ error: "timeline not found" });
    const byShot = new Map<string, ShotCandidateRow[]>();
    for (const c of listTimelineCandidates(id)) {
      const list = byShot.get(c.link_shot_id) ?? [];
      list.push(c);
      byShot.set(c.link_shot_id, list);
    }
    const shots = listShotsByTimeline(id, projectId).map((s) => ({ ...s, candidates: byShot.get(s.id) ?? [] }));
    return { timeline: tl, shots };
  });

  // Timeline "fetch videos": run candidate discovery (search + persist, no
  // downloads) for every shot on the timeline, capped at maxPerShot per shot.
  app.post("/api/timelines/:id/fetch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (!getTimeline(id, projectId)) return reply.code(404).send({ error: "timeline not found" });
    const body = (req.body ?? {}) as { maxPerShot?: unknown };
    const n = Number(body.maxPerShot);
    const maxPerShot = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.floor(n))) : 5;
    const r = fetchTimelineBackground(id, maxPerShot);
    if ("alreadyRunning" in r) return { alreadyRunning: true, progress: timelineFetchProgress };
    return r;
  });
  app.get("/api/timelines/:id/fetch/progress", async (req) => {
    const { id } = req.params as { id: string };
    return { ...timelineFetchProgress, requestedTimelineId: id };
  });
  app.post("/api/timelines/:id/fetch/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return cancelTimelineFetch(id);
  });
  app.post("/api/timelines/:id/fetch/pause", async (req) => {
    const { id } = req.params as { id: string };
    return pauseTimelineFetch(id);
  });
  app.post("/api/timelines/:id/fetch/resume", async (req) => {
    const { id } = req.params as { id: string };
    return resumeTimelineFetch(id);
  });
}
