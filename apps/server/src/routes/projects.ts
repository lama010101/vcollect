// =============================================================================
// Project routes — multi-project management + script import
//   GET    /api/projects                        list projects (+ counts/covers)
//   POST   /api/projects                        create a project
//   PATCH  /api/projects/:id                    rename / update acquire settings
//   DELETE /api/projects/:id                    delete a project
//   POST   /api/projects/:id/import-script      bulk shot + timeline creation
//   POST   /api/projects/:id/preview-script     parse without committing
//   POST   /api/projects/:id/preview-script-llm LLM parse without committing
// =============================================================================

import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import type { ShotRow } from "../db/schema.js";
import {
  createShot,
  createTimeline,
  deleteShotsForProject,
  nextShotNumber,
  setShotTimeRange,
  setShotTimeline,
} from "../db/repository.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectCounts,
  renameProject,
  updateProjectSettings,
} from "../db/projectRepository.js";
import { parseScript } from "../import/scriptParser.js";
import { parseScriptWithLlm } from "../import/llmParser.js";
import {
  createProjectSchema,
  importScriptSchema,
  PROJECT_ID_ALL,
  updateProjectSchema,
} from "@twio/shared";

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  // --- Projects (multi-project management) ------------------------------------
  app.get("/api/projects", async () => {
    const projects = listProjects().map((p) => {
      const { coverAssetId, ...counts } = projectCounts(p.id);
      return { ...p, counts, coverAssetId };
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
}
