// =============================================================================
// Task routes — concurrent download tasks (parallel searches + downloads)
//   GET    /api/tasks                 list all tracked tasks
//   GET    /api/tasks/config          concurrency config
//   PUT    /api/tasks/config          { maxConcurrent }
//   POST   /api/tasks/pause-all       pause every active session
//   POST   /api/tasks/resume-all      resume every paused session
//   POST   /api/tasks/cancel-all      cancel every active session
//   GET    /api/tasks/:id             one task
//   DELETE /api/tasks/:id             remove a finished task
//   POST   /api/tasks/:id/pause       pause one task
//   POST   /api/tasks/:id/resume      resume one task
//   POST   /api/tasks/:id/cancel      cancel one task
//   POST   /api/tasks/acquire-asset   { assetId } → single-asset download task
//   POST   /api/tasks/acquire-shot    { shotId } → single-shot acquire task
//   POST   /api/tasks/acquire-batch   { assetIds[] } → batch download task
// =============================================================================

import type { FastifyInstance } from "fastify";
import { getAsset, getShot } from "../db/repository.js";
import {
  cancelAllTasks,
  cancelTask,
  getTask,
  getTaskConfig,
  listTasks,
  pauseAllTasks,
  pauseTask,
  removeTask,
  resumeAllTasks,
  resumeTask,
  setMaxConcurrent,
  startAcquireAssetTask,
  startAcquireBatchTask,
  startAcquireShotTask,
} from "../acquisition/tasks.js";

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
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
}
