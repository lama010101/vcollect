// =============================================================================
// Fastify server — REST API for MODES A–E (PRD §5) + static asset serving
//
// Multi-project: most endpoints accept a `?project=<id>` query param that
// scopes the query to a project. The virtual id "__ALL__" aggregates every
// project. Defaults to the seeded "THE_WORLD_IS_OURS" project for backwards
// compatibility.
// =============================================================================

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { config, OUTPUT_ROOT, projectPaths } from "./config.js";
import { ffmpegService } from "./video/ffmpeg.js";
import { migrate } from "./db/migrate.js";
import { db } from "./db/client.js";
import type { ShotRow } from "./db/schema.js";
import type { ShotCandidateRow } from "./db/repository.js";
import {
  getAsset,
  listAssetsForShot,
  listShots,
  listShotAssets,
  setAssetRating,
  setAssetReady,
  updateShotAcquireSettings,
  // Timeline + asset-search/assignment
  listTimelines,
  listTimelinesWithCounts,
  getTimeline,
  createTimeline,
  renameTimeline,
  deleteTimeline,
  listShotsByTimeline,
  listTimelineCandidates,
  listShotsWithoutTimeline,
  setShotTimeline,
  setShotTimeRange,
  searchAssets,
  searchAssetsAdvanced,
  type AssetSearchFilters,
  type AssetSortKey,
  addAssetToShot,
  removeAssetFromShot,
  setShotAssetOnRail,
  persistStandaloneCandidate,
  // Shot CRUD
  createShot,
  deleteShot,
  deleteShotsForProject,
  nextShotNumber,
  getShot,
} from "./db/repository.js";
import { resolveProviders } from "./providers/factory.js";
import {
  listProjects,
  getProject,
  createProject,
  renameProject,
  deleteProject,
  projectCounts,
  updateProjectSettings,
} from "./db/projectRepository.js";
import { copyAssetToProject } from "./db/assetCopy.js";
import { acquireAll, acquireAllProgress, acquireShot, acquireShotBackground, acquireShotProgress, cancelShotAcquire, pauseShotAcquire, resumeShotAcquire, acquireAssetBackground, acquireAssetProgress, acquireAssetsBatchBackground, acquireBatchProgress, fetchTimelineBackground, timelineFetchProgress, cancelTimelineFetch, pauseTimelineFetch, resumeTimelineFetch } from "./acquisition/pipeline.js";
import { acquireReserve } from "./acquisition/runner.js";
import {
  listTasks,
  getTask,
  removeTask,
  pauseTask,
  resumeTask,
  cancelTask,
  pauseAllTasks,
  resumeAllTasks,
  cancelAllTasks,
  startAcquireAssetTask,
  startAcquireShotTask,
  hasActiveTaskForAsset,
  cancelTasksForAsset,
  startAcquireBatchTask,
  getTaskConfig,
  setMaxConcurrent,
} from "./acquisition/tasks.js";
import { getDashboard } from "./routes/dashboard.js";
import { applyReview } from "./routes/review.js";
import { registerMusicEditRoutes } from "./routes/musicEdit.js";
import { assetAbsolutePath, getFolders, revealInExplorer, getProjectRow } from "./routes/folders.js";
import { generateFootageManifest, generateLicenseManifest } from "./manifests/csv.js";
import { generateJsonManifest } from "./manifests/json.js";
import { generateContactSheetHtml, generateContactSheetJpeg, generateHtmlReport } from "./manifests/html.js";
import {
  reviewRequestSchema,
  createProjectSchema,
  updateProjectSchema,
  createShotSchema,
  importScriptSchema,
  MAX_POOL_PER_SHOT,
  PROJECT_ID_ALL,
  DEFAULT_PROJECT_ID,
  sectionFolder,
  type AssetCandidate,
  type SearchOptions,
} from "@twio/shared";
import { parseScript } from "./import/scriptParser.js";
import { parseScriptWithLlm, checkLlmStatus } from "./import/llmParser.js";

// Coerce an optional request field to a clamped integer.
//   undefined input  → returns `def` (caller decides: null = clear, undefined = unchanged)
//   null input       → returns `def`
//   invalid input    → returns `def`
function clampInt(v: unknown, min: number, max: number, def: number | null | undefined): number | null | undefined {
  if (v == null) return def;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function clampNum(v: unknown, min: number, max: number, def: number | null | undefined): number | null | undefined {
  if (v == null) return def;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Extract the `?project=` query param, defaulting to the seeded project. */
function projectOfQuery(query: Record<string, unknown>): string {
  const q = (query.project as string | undefined)?.trim();
  return q || DEFAULT_PROJECT_ID;
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(fastifyCors, { origin: true });

  // Global error handler — catches unhandled exceptions in route handlers and
  // returns a clean 500 instead of crashing the process.
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      statusCode,
      error: error.code ?? "Internal Server Error",
      message: error.message,
    });
  });

  // Serve generated thumbnails / contact sheets / footage statically. The root
  // is OUTPUT_ROOT so per-project files are served as /files/<slug>/footage/...
  await app.register(fastifyStatic, {
    root: OUTPUT_ROOT,
    prefix: "/files/",
    decorateReply: false,
  });

  // --- Music edit (beat-aligned music-video editor) ---------------------------
  await registerMusicEditRoutes(app);

  // --- Projects (multi-project management) ------------------------------------
  app.get("/api/projects", async () => {
    const projects = listProjects().map((p) => {
      if (p.isVirtual) return { ...p, counts: projectCounts(p.id) };
      return { ...p, counts: projectCounts(p.id) };
    });
    return { projects };
  });
  app.post("/api/projects", async (req, reply) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const p = createProject(parsed.data);
    return reply.code(201).send({ project: p });
  });
  app.patch("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot edit All Projects" });
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!getProject(id)) return reply.code(404).send({ error: "project not found" });
    // Update name/description if provided.
    if (parsed.data.name !== undefined || parsed.data.description !== undefined) {
      const existing = getProject(id)!;
      renameProject(id, parsed.data.name ?? existing.name, parsed.data.description);
    }
    // Update acquisition settings if any are provided.
    const settings: Record<string, unknown> = {};
    if (parsed.data.acquireCount !== undefined) settings.acquireCount = parsed.data.acquireCount;
    if (parsed.data.enforceAcquireCount !== undefined) settings.enforceAcquireCount = parsed.data.enforceAcquireCount;
    if (parsed.data.minCandidates !== undefined) settings.minCandidates = parsed.data.minCandidates;
    if (parsed.data.enforceMinCandidates !== undefined) settings.enforceMinCandidates = parsed.data.enforceMinCandidates;
    if (parsed.data.minAcquireRating !== undefined) settings.minAcquireRating = parsed.data.minAcquireRating;
    if (parsed.data.enforceMinAcquireRating !== undefined) settings.enforceMinAcquireRating = parsed.data.enforceMinAcquireRating;
    if (parsed.data.candidatesPerProvider !== undefined) settings.candidatesPerProvider = parsed.data.candidatesPerProvider;
    if (Object.keys(settings).length > 0) {
      updateProjectSettings(id, settings);
    }
    return { ok: true, project: getProject(id) };
  });
  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      deleteProject(id);
      return { ok: true, id };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // --- MODE E: manifest generation -------------------------------------------
  app.post("/api/manifests/generate", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    // Manifests are per-project (they write into a project's manifests folder).
    // For __ALL__, fall back to the default project's folder.
    const proj = projectId === PROJECT_ID_ALL ? getProject(DEFAULT_PROJECT_ID) : getProject(projectId);
    const slug = proj?.slug ?? DEFAULT_PROJECT_ID;
    const paths = projectPaths(slug);
    const csv1 = generateFootageManifest(projectId, paths);
    const csv2 = generateLicenseManifest(projectId, paths);
    const json = generateJsonManifest(projectId, paths, proj?.name);
    const html = generateHtmlReport({ projectId, paths, projectName: proj?.name, projectDescription: proj?.description ?? undefined });
    const csh = generateContactSheetHtml({ projectId, paths, projectName: proj?.name });
    const csj = await generateContactSheetJpeg({ projectId, paths });
    return { footage_manifest_csv: csv1, license_manifest_csv: csv2, footage_manifest_json: json, rights_report_html: html, contact_sheet_html: csh, contact_sheet_jpg: csj };
  });

  app.get("/api/manifests/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    const proj = projectId === PROJECT_ID_ALL ? getProject(DEFAULT_PROJECT_ID) : getProject(projectId);
    const slug = proj?.slug ?? DEFAULT_PROJECT_ID;
    const paths = projectPaths(slug);
    const dest = resolve(paths.manifests, file);
    if (!existsSync(dest)) return reply.code(404).send({ error: "not found" });
    reply.type(file.endsWith(".html") ? "text/html" : file.endsWith(".json") ? "application/json" : "text/csv");
    return reply.send(createReadStream(dest));
  });

  // --- Shots (MODE A search target list) -------------------------------------
  app.get("/api/shots", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    return { shots: listShots(projectId) };
  });
  app.get("/api/shots/:id", async (req) => {
    const { id } = req.params as { id: string };
    const shot = getShot(id);
    const projectId = shot?.project_id ?? DEFAULT_PROJECT_ID;
    const proj = getProject(projectId);
    const slug = proj?.slug ?? DEFAULT_PROJECT_ID;
    const assets = listAssetsForShot(id).map((a) => {
      if (!a.local_path) return a;
      const folder = sectionFolder(shot?.section ?? "SEARCH");
      return {
        ...a,
        absolute_path: assetAbsolutePath(a.local_path, slug),
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
  app.delete("/api/shots/:id", async (req) => {
    const { id } = req.params as { id: string };
    deleteShot(id);
    return { ok: true, id };
  });

  // --- Script import (bulk shot + timeline creation from text) ---------------
  // Parses a conventional music-video script (regex/line-based, NO AI) and
  // creates shots + optionally a timeline with computed time ranges.
  app.post("/api/projects/:id/import-script", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot import into All Projects" });
    if (!getProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = importScriptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { script, timelineName, replace, useLlm } = parsed.data;

    // Use LLM parser if requested (and configured); fall back to conventional.
    let result;
    try {
      result = useLlm ? await parseScriptWithLlm(script) : parseScript(script);
    } catch (e) {
      return reply.code(500).send({ error: `Parse failed: ${(e as Error).message}` });
    }
    if (result.errors.length > 0) {
      return reply.code(400).send({
        error: "Script has parse errors",
        parseErrors: result.errors,
      });
    }
    if (result.shots.length === 0) {
      return reply.code(400).send({ error: "Script contains no shots" });
    }

    // Replace + timeline + shot creation run in one transaction so a failure
    // mid-import can't leave the project half-deleted or half-populated.
    let timelineId: string | null = null;
    const createdShots: ShotRow[] = [];
    db.transaction(() => {
      if (replace) deleteShotsForProject(id);

      if (timelineName) {
        const tlId = `TL_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        createTimeline(tlId, timelineName, id, script);
        timelineId = tlId;
      }

      // Create all shots from the parsed script.
      for (const ps of result.shots) {
        const num = nextShotNumber(id);
        const shotId = `${id}_SHOT_${String(num).padStart(3, "0")}`;
        const shot = createShot({
          id: shotId,
          projectId: id,
          shotNumber: num,
          section: ps.section,
          visualDescription: ps.visualDescription,
          searchQuery: ps.searchQuery,
          targetDurationSeconds: ps.targetDurationSeconds,
          priority: ps.priority,
          lyrics: ps.lyrics,
          referenceImageUrl: ps.referenceImageUrl,
        });
        // Assign to timeline + set time range if a timeline was created.
        if (timelineId) {
          setShotTimeline(shotId, timelineId);
          setShotTimeRange(shotId, ps.timeStartSeconds, ps.timeEndSeconds);
        }
        createdShots.push(shot);
      }
    });

    return reply.code(201).send({
      ok: true,
      projectId: id,
      timelineId,
      shotsCreated: createdShots.length,
      totalDurationSeconds: result.totalDurationSeconds,
      sections: result.sections.map((s) => ({
        name: s.name,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        shotCount: s.shots.length,
        lyrics: s.lyrics,
      })),
    });
  });

  // --- Preview script (parse without committing) -----------------------------
  app.post("/api/projects/:id/preview-script", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot preview for All Projects" });
    if (!getProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = importScriptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const result = parseScript(parsed.data.script);
    return {
      shots: result.shots,
      sections: result.sections.map((s) => ({
        name: s.name,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        shotCount: s.shots.length,
        lyrics: s.lyrics,
      })),
      totalDurationSeconds: result.totalDurationSeconds,
      errors: result.errors,
    };
  });

  // --- Preview script with LLM (parse without committing, using AI) ----------
  app.post("/api/projects/:id/preview-script-llm", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot preview for All Projects" });
    if (!getProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = importScriptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const result = await parseScriptWithLlm(parsed.data.script);
      return {
        shots: result.shots,
        sections: result.sections.map((s) => ({
          name: s.name,
          startSeconds: s.startSeconds,
          endSeconds: s.endSeconds,
          shotCount: s.shots.length,
          lyrics: s.lyrics,
        })),
        totalDurationSeconds: result.totalDurationSeconds,
        errors: result.errors,
      };
    } catch (e) {
      return reply.code(500).send({ error: `LLM parse failed: ${(e as Error).message}` });
    }
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
  app.delete("/api/timelines/:id", async (req) => {
    const { id } = req.params as { id: string };
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

  // --- Asset search + manual shot/asset assignment ----------------------------
  // Search the discovered/downloaded asset pool. Supports two modes:
  //   1. Legacy free-text: ?q=...&limit=...&project=... (backward compatible)
  //   2. Structured filters: any of provider/creator/tag/title/minDuration/
  //      maxDuration/minWidth/minHeight/maxWidth/maxHeight/orientation/
  //      downloadedOnly/discoveredOnly/commercialStatus/rightsReviewStatus/
  //      sourceLicense/minRating/maxRating/minScore/maxScore/discoveredAfter/
  //      discoveredBefore/downloadedAfter/downloadedBefore/sort/limit/project
  //
  // When any structured filter (other than q/limit/project) is present, the
  // structured path is used; otherwise the legacy free-text path runs.
  app.get("/api/assets/search", async (req) => {
    const query = req.query as Record<string, unknown>;
    const projectId = projectOfQuery(query);
    const limit = clampInt(query.limit, 1, 500, 50) ?? 50;
    const q = ((query.q as string | undefined) ?? "").toString().trim();

    // Detect whether any structured filter is present (excluding the legacy
    // params q/limit/project). If so, take the structured path.
    const structuredKeys = [
      "provider", "creator", "tag", "title",
      "minDuration", "maxDuration", "minWidth", "minHeight", "maxWidth", "maxHeight",
      "orientation", "downloadedOnly", "discoveredOnly",
      "commercialStatus", "rightsReviewStatus", "sourceLicense",
      "minRating", "maxRating", "minScore", "maxScore",
      "discoveredAfter", "discoveredBefore", "downloadedAfter", "downloadedBefore",
      "sort",
    ];
    const hasStructured = structuredKeys.some((k) => query[k] != null && query[k] !== "");

    if (!hasStructured) {
      return { query: q, assets: searchAssets(q, projectId, limit) };
    }

    const num = (v: unknown): number | undefined => {
      if (v == null || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (v: unknown): string | undefined => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s === "" ? undefined : s;
    };
    const bool = (v: unknown): boolean | undefined => {
      if (v == null || v === "") return undefined;
      if (v === true || v === 1 || v === "1" || v === "true" || v === "True") return true;
      if (v === false || v === 0 || v === "0" || v === "false" || v === "False") return false;
      return undefined;
    };

    const filters: AssetSearchFilters = {
      q: q || undefined,
      provider: str(query.provider),
      creator: str(query.creator),
      tag: str(query.tag),
      title: str(query.title),
      minDuration: num(query.minDuration),
      maxDuration: num(query.maxDuration),
      minWidth: num(query.minWidth),
      minHeight: num(query.minHeight),
      maxWidth: num(query.maxWidth),
      maxHeight: num(query.maxHeight),
      orientation: str(query.orientation),
      downloadedOnly: bool(query.downloadedOnly),
      discoveredOnly: bool(query.discoveredOnly),
      commercialStatus: str(query.commercialStatus),
      rightsReviewStatus: str(query.rightsReviewStatus),
      sourceLicense: str(query.sourceLicense),
      minRating: num(query.minRating),
      maxRating: num(query.maxRating),
      minScore: num(query.minScore),
      maxScore: num(query.maxScore),
      discoveredAfter: str(query.discoveredAfter),
      discoveredBefore: str(query.discoveredBefore),
      downloadedAfter: str(query.downloadedAfter),
      downloadedBefore: str(query.downloadedBefore),
      sort: str(query.sort) as AssetSortKey | undefined,
      limit,
    };
    const assets = searchAssetsAdvanced(filters, projectId);
    return { query: q, filters, count: assets.length, assets };
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

  // --- Copy asset to another project (multi-project) -------------------------
  app.post("/api/assets/:id/copy", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { toProjectId?: string; targetShotId?: string | null };
    const toProjectId = (body.toProjectId ?? "").toString();
    if (!toProjectId) return reply.code(400).send({ error: "toProjectId required" });
    if (toProjectId === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot copy to All Projects" });
    try {
      const r = copyAssetToProject({ assetId: id, toProjectId, targetShotId: body.targetShotId ?? null });
      return { ok: true, result: r };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // --- MODE A: search (no download) ------------------------------------------
  app.post("/api/shots/:id/search", async (req) => {
    const { id } = req.params as { id: string };
    // Reuse the pipeline's search step by acquiring; for a pure search we
    // would refactor — here we run the full shot acquire which searches too.
    const p = await acquireShot(id);
    return p;
  });

  // --- MODE C: acquire -------------------------------------------------------
  // Single-shot acquire runs in the background; client polls progress.
  app.post("/api/acquire/:id", async (req) => {
    const { id } = req.params as { id: string };
    return acquireShotBackground(id);
  });
  app.get("/api/acquire/:id/progress", async (req) => {
    const { id } = req.params as { id: string };
    return { ...acquireShotProgress, requestedShotId: id };
  });
  // Pause / resume / cancel the running single-shot acquire (search phase).
  app.post("/api/acquire/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return cancelShotAcquire(id);
  });
  app.post("/api/acquire/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    return pauseShotAcquire(id);
  });
  app.post("/api/acquire/:id/resume", async (req) => {
    const { id } = req.params as { id: string };
    return resumeShotAcquire(id);
  });
  // Full acquisition runs in the background; client polls /api/acquire/progress.
  app.post("/api/acquire", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (acquireAllProgress.running) {
      return { alreadyRunning: true, progress: acquireAllProgress };
    }
    if (acquireShotProgress.running) {
      return { alreadyRunning: true, progress: acquireShotProgress };
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

  // --- Assets ----------------------------------------------------------------
  app.get("/api/folders", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    return getFolders(projectId);
  });

  app.post("/api/assets/:id/reveal", async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = getAsset(id);
    if (!a?.local_path) return reply.code(404).send({ ok: false, error: "no local file" });
    const proj = getProjectRow(a.project_id);
    const slug = proj?.slug ?? DEFAULT_PROJECT_ID;
    const abs = assetAbsolutePath(a.local_path, slug);
    return revealInExplorer(abs);
  });

  app.post("/api/assets/:id/ready", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { ready?: boolean } | null;
    const a = getAsset(id);
    if (!a) return reply.code(404).send({ ok: false, error: "asset not found" });
    const ready = body?.ready ?? !(a.ready !== 0);
    setAssetReady(id, ready);
    return { ok: true, id, ready };
  });

  app.post("/api/assets/:id/rating", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { rating?: number | null } | null;
    const a = getAsset(id);
    if (!a) return reply.code(404).send({ ok: false, error: "asset not found" });
    const raw = body?.rating ?? null;
    const rating = raw == null ? null : Math.max(0, Math.min(10, Math.round(raw)));
    setAssetRating(id, rating);
    return { ok: true, id, rating };
  });

  app.get("/api/assets/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getAsset(id) ?? { error: "not found" };
  });
  app.get("/api/assets/:id/file", async (req, reply) => {
    const a = getAsset((req.params as { id: string }).id);
    if (!a?.local_path) return reply.code(404).send({ error: "no local file" });
    const abs = resolve(OUTPUT_ROOT, a.local_path);
    if (!existsSync(abs)) return reply.code(404).send({ error: "file missing" });
    reply.type("video/mp4");
    return reply.send(createReadStream(abs));
  });
  app.get("/api/assets/:id/thumb", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { THUMBNAILS_DIR } = await import("./config.js");
    const dest = resolve(THUMBNAILS_DIR, `${id}.jpg`);
    if (!existsSync(dest)) return reply.code(404).send({ error: "no thumbnail" });
    reply.type("image/jpeg");
    return reply.send(createReadStream(dest));
  });

  // --- Acquire a single discovered asset by id (search-page acquisition) ------
  // Downloads + post-processes an already-discovered asset. Runs in the
  // background; client polls /api/assets/:id/acquire/progress.
  app.post("/api/assets/:id/acquire", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getAsset(id)) return reply.code(404).send({ error: "asset not found" });
    const r = acquireAssetBackground(id);
    return r;
  });
  app.get("/api/assets/:id/acquire/progress", async (req) => {
    const { id } = req.params as { id: string };
    return { ...acquireAssetProgress, requestedAssetId: id };
  });

  // --- Acquire multiple discovered assets (Acquire All on search page) --------
  // Accepts { assetIds: string[] }. Runs sequentially in the background; client
  // polls /api/assets/acquire-batch/progress for overall progress.
  app.post("/api/assets/acquire-batch", async (req, reply) => {
    const body = req.body as { assetIds?: unknown } | null;
    const ids = body?.assetIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "assetIds must be an array of strings" });
    }
    if (ids.length === 0) return reply.code(400).send({ error: "assetIds must not be empty" });
    const r = acquireAssetsBatchBackground(ids);
    return r;
  });
  app.get("/api/assets/acquire-batch/progress", async () => {
    return acquireBatchProgress;
  });

  // --- Concurrent download tasks (parallel searches + downloads) -------------
  // These endpoints replace the single-slot acquire*Background model with a
  // registry that allows many downloads to run at once. Each task is tracked
  // independently with its own progress and can be paused / resumed / cancelled.
  // Searches (provider + local pool) remain stateless concurrent HTTP requests
  // and are never blocked by downloads.
  app.get("/api/tasks", async () => ({ tasks: listTasks() }));
  // Concurrency configuration.
  app.get("/api/tasks/config", async () => ({ config: getTaskConfig() }));
  app.put("/api/tasks/config", async (req, reply) => {
    const body = req.body as { maxConcurrent?: number } | undefined;
    const n = body?.maxConcurrent;
    if (n == null) return reply.code(400).send({ error: "maxConcurrent is required" });
    const r = setMaxConcurrent(n);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, config: getTaskConfig(), tasks: listTasks() };
  });
  // Bulk operations across every active session.
  app.post("/api/tasks/pause-all", async () => {
    const r = pauseAllTasks();
    return { ok: true, ...r, tasks: listTasks() };
  });
  app.post("/api/tasks/resume-all", async () => {
    const r = resumeAllTasks();
    return { ok: true, ...r, tasks: listTasks() };
  });
  app.post("/api/tasks/cancel-all", async () => {
    const r = cancelAllTasks();
    return { ok: true, ...r, tasks: listTasks() };
  });
  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = getTask(id);
    if (!t) return reply.code(404).send({ error: "task not found" });
    return { task: t };
  });
  app.delete("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = removeTask(id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, id };
  });
  app.post("/api/tasks/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = pauseTask(id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, id, task: getTask(id) };
  });
  app.post("/api/tasks/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = resumeTask(id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, id, task: getTask(id) };
  });
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = cancelTask(id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, id, task: getTask(id) };
  });
  // Start a single-asset download task (does not block on other downloads).
  app.post("/api/tasks/acquire-asset", async (req, reply) => {
    const body = (req.body ?? {}) as { assetId?: unknown };
    const assetId = (body.assetId as string | undefined)?.toString();
    if (!assetId) return reply.code(400).send({ error: "assetId required" });
    if (!getAsset(assetId)) return reply.code(404).send({ error: "asset not found" });
    const task = startAcquireAssetTask(assetId);
    return reply.code(201).send({ task });
  });
  // Start a single-shot acquisition task (search + download).
  app.post("/api/tasks/acquire-shot", async (req, reply) => {
    const body = (req.body ?? {}) as { shotId?: unknown };
    const shotId = (body.shotId as string | undefined)?.toString();
    if (!shotId) return reply.code(400).send({ error: "shotId required" });
    if (!getShot(shotId)) return reply.code(404).send({ error: "shot not found" });
    const task = startAcquireShotTask(shotId);
    return reply.code(201).send({ task });
  });
  // Start a batch asset download task.
  app.post("/api/tasks/acquire-batch", async (req, reply) => {
    const body = (req.body ?? {}) as { assetIds?: unknown };
    const ids = body.assetIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "assetIds must be an array of strings" });
    }
    if (ids.length === 0) return reply.code(400).send({ error: "assetIds must not be empty" });
    const task = startAcquireBatchTask(ids);
    return reply.code(201).send({ task });
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

  // --- Providers (attribution links — PRD §3) --------------------------------
  app.get("/api/providers", async () => {
    const rows = db.all(`SELECT id, name, api_enabled, license_url, attribution_url, active FROM providers`) as Array<{
      id: string; name: string; api_enabled: number; license_url: string | null; attribution_url: string | null; active: number;
    }>;
    return { providers: rows };
  });

  // --- Live provider search (discover new assets from Pexels/Pixabay) ---------
  // Searches the live provider APIs for new candidates (not yet persisted).
  // Body: { query, orientation?, minWidth?, minHeight?, provider? }
  // When provider is omitted, searches both pexels + pixabay and merges.
  app.post("/api/providers/search", async (req, reply) => {
    const body = (req.body ?? {}) as {
      query?: unknown; orientation?: unknown;
      minWidth?: unknown; minHeight?: unknown; provider?: unknown;
    };
    const query = (body.query as string | undefined)?.trim();
    if (!query) return reply.code(400).send({ error: "query required" });
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (projectId === PROJECT_ID_ALL) {
      return reply.code(400).send({ error: "select a specific project before searching providers" });
    }

    const opts: SearchOptions = {};
    const orient = (body.orientation as string | undefined)?.trim();
    if (orient === "landscape" || orient === "portrait" || orient === "square") opts.orientation = orient;
    const mw = body.minWidth;
    if (mw != null && mw !== "") { const n = Number(mw); if (Number.isFinite(n)) opts.minWidth = n; }
    const mh = body.minHeight;
    if (mh != null && mh !== "") { const n = Number(mh); if (Number.isFinite(n)) opts.minHeight = n; }

    const { pexels, pixabay } = resolveProviders();
    const providerFilter = (body.provider as string | undefined)?.trim();
    const providerList = providerFilter === "pexels" ? [pexels]
      : providerFilter === "pixabay" ? [pixabay]
      : [pexels, pixabay];

    const failures: string[] = [];
    const pool: AssetCandidate[] = [];
    for (const p of providerList) {
      try {
        pool.push(...(await p.search(query, opts)));
      } catch (e) {
        failures.push(`${p.id}: ${(e as Error).message}`);
      }
    }
    if (failures.length > 0 && pool.length === 0) {
      return reply.code(502).send({ error: `provider search failed: ${failures.join(" | ")}` });
    }
    // Dedupe by provider:providerAssetId.
    const seen = new Set<string>();
    const deduped = pool.filter((c) => {
      const key = `${c.provider}:${c.providerAssetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { query, count: deduped.length, candidates: deduped };
  });

  // --- Acquire a provider candidate (persist + download) ----------------------
  // Persists the candidate as a standalone asset (no shot link) in the given
  // project, then triggers background download + post-processing.
  // Body: { candidate: AssetCandidate, projectId: string }
  app.post("/api/providers/acquire", async (req, reply) => {
    const body = (req.body ?? {}) as { candidate?: unknown; projectId?: unknown };
    const candidate = body.candidate as AssetCandidate | undefined;
    const projectId = (body.projectId as string | undefined)?.trim();
    if (!candidate) return reply.code(400).send({ error: "candidate required" });
    if (!projectId || projectId === PROJECT_ID_ALL) {
      return reply.code(400).send({ error: "a specific projectId is required" });
    }
    if (!getProject(projectId)) return reply.code(404).send({ error: "project not found" });

    const { assetId } = persistStandaloneCandidate(candidate, projectId);
    const asset = getAsset(assetId);
    if (asset?.local_path) {
      return { assetId, alreadyDownloaded: true, started: false };
    }
    // Start a concurrent download task (does not block on other downloads).
    const task = startAcquireAssetTask(assetId);
    return { assetId, started: true, task };
  });

  // --- Health ----------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));

  return app;
}

export async function startServer(): Promise<void> {
  await ffmpegService.ensure();
  migrate();
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}

// Run directly when invoked as `tsx src/index.ts` / `node dist/index.js`.
startServer().catch((err) => {
  console.error("server failed to start:", err);
  process.exit(1);
});
