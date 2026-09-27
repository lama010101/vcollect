// =============================================================================
// Concurrent download task registry with automatic concurrency scheduling
//
// Replaces the single-slot background acquire model with a registry that allows
// multiple downloads to run in parallel, up to a configurable concurrency limit.
// When the limit is reached, new tasks are queued and automatically started as
// running tasks finish, are paused, or are cancelled.
//
// Each task (a "session") is independently observable (per-task progress +
// per-download items) and controllable (pause / resume / cancel), both
// individually and in bulk.
//
// A task wraps one of the pipeline runners (acquireAssetById / acquireShot /
// a batch of acquireAssetById) and threads a DownloadController (AbortSignal +
// PauseGate) into every download performed within that task.
//
// The registry is process-local and in-memory — tasks do not survive a server
// restart. That matches the existing acquire*Progress globals it replaces.
// =============================================================================

import { acquireAssetById, acquireShot } from "./pipeline.js";
import { PauseGate, type DownloadController } from "../video/download.js";

export type TaskKind = "asset" | "shot" | "batch";
export type TaskStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface TaskProgress {
  receivedBytes: number;
  totalBytes: number;
  pct: number; // 0–100 (0 when total unknown)
}

/** A single download within a session. Asset/shot tasks have one; batch tasks
 *  have one per asset id. Each item has its own status + byte progress. */
export interface TaskItem {
  id: string; // assetId for asset/batch items; synthetic for shot items
  label: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  error: string | null;
}

/** Public, serialisable view of a task (no controller / promise internals). */
export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  // Batch-only aggregate counters.
  total: number | null;
  completed: number | null;
  succeeded: number | null;
  failed: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  // For asset/shot tasks: the subject id (assetId / shotId). For batch tasks:
  // the list of asset ids being processed.
  assetId: string | null;
  shotId: string | null;
  assetIds: string[] | null;
  // Per-download items grouped under this session.
  items: TaskItem[];
}

/** Concurrency configuration returned to the UI. */
export interface TaskConfig {
  maxConcurrent: number;
  running: number;
  queued: number;
}

interface TaskEntry {
  task: Task;
  abort: AbortController;
  gate: PauseGate;
  controller: DownloadController;
  /** The runner closure — only invoked once a concurrency slot is granted. */
  runner?: () => Promise<void>;
  /** Whether the runner has been launched (to avoid double-start). */
  launched: boolean;
}

// --- concurrency config -----------------------------------------------------

/** Maximum number of tasks that may be in "running" status simultaneously. */
let maxConcurrent = 3;

export function getMaxConcurrent(): number {
  return maxConcurrent;
}

export function setMaxConcurrent(n: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(n) || n < 1) return { ok: false, error: "maxConcurrent must be >= 1" };
  if (n > 20) return { ok: false, error: "maxConcurrent must be <= 20" };
  maxConcurrent = Math.floor(n);
  // Changing the limit may free slots or require queueing. Re-schedule.
  schedule();
  return { ok: true };
}

export function getTaskConfig(): TaskConfig {
  let running = 0;
  let queued = 0;
  for (const e of tasks.values()) {
    if (e.task.status === "running") running++;
    else if (e.task.status === "queued") queued++;
  }
  return { maxConcurrent, running, queued };
}

// --- registry ---------------------------------------------------------------

const tasks = new Map<string, TaskEntry>();

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicTask(e: TaskEntry): Task {
  // Shallow-copy + clone the items array so callers can't mutate internals.
  return { ...e.task, items: e.task.items.map((it) => ({ ...it, progress: it.progress ? { ...it.progress } : null })) };
}

function makeEntry(kind: TaskKind, label: string, init: Partial<Task> = {}): TaskEntry {
  const abort = new AbortController();
  const gate = new PauseGate(abort.signal);
  const controller: DownloadController = {
    signal: abort.signal,
    isPaused: () => gate.isPaused(),
    waitIfPaused: () => gate.waitIfPaused(),
  };
  const task: Task = {
    id: newId(kind),
    kind,
    label,
    status: "queued", // start as queued; scheduler will flip to running
    progress: null,
    total: null,
    completed: null,
    succeeded: null,
    failed: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    assetId: null,
    shotId: null,
    assetIds: null,
    items: [],
    ...init,
  };
  return { task, abort, gate, controller, launched: false };
}

function setProgress(e: TaskEntry, receivedBytes: number, totalBytes: number): void {
  e.task.progress = {
    receivedBytes,
    totalBytes,
    pct: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0,
  };
}

function clearProgress(e: TaskEntry): void {
  e.task.progress = null;
}

function finish(e: TaskEntry, status: TaskStatus, error: string | null = null): void {
  e.task.status = status;
  e.task.finishedAt = new Date().toISOString();
  e.task.error = error;
  e.task.progress = null;
  // Mark any still-queued/running items as cancelled when the session ends
  // cancelled, or as done/failed to match the session outcome otherwise.
  for (const it of e.task.items) {
    if (it.status === "queued" || it.status === "running") {
      it.status = status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "done";
      if (it.status !== "done") it.progress = null;
    }
  }
  e.gate.dispose();
  // A slot freed up — try to start the next queued task.
  schedule();
}

// --- per-download item helpers ----------------------------------------------

function itemForId(e: TaskEntry, id: string): TaskItem | undefined {
  return e.task.items.find((it) => it.id === id);
}

function upsertItem(e: TaskEntry, id: string, label: string, status: TaskStatus): TaskItem {
  let it = itemForId(e, id);
  if (!it) {
    it = { id, label, status, progress: null, error: null };
    e.task.items.push(it);
  } else {
    it.label = label || it.label;
    it.status = status;
    if (status === "running") it.error = null;
  }
  return it;
}

function setItemProgress(e: TaskEntry, id: string, receivedBytes: number, totalBytes: number): void {
  const it = itemForId(e, id);
  if (!it) return;
  it.progress = {
    receivedBytes,
    totalBytes,
    pct: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0,
  };
}

function finishItem(e: TaskEntry, id: string, status: TaskStatus, error: string | null = null): void {
  const it = itemForId(e, id);
  if (!it) return;
  it.status = status;
  it.error = error;
  if (status !== "running" && status !== "paused") it.progress = null;
}

// --- concurrency scheduler --------------------------------------------------

/** Count tasks currently in "running" status. */
function countRunning(): number {
  let n = 0;
  for (const e of tasks.values()) if (e.task.status === "running") n++;
  return n;
}

/**
 * The scheduler. Iterates through tasks in insertion order (Map preserves it)
 * and launches queued tasks until the concurrency limit is reached.
 *
 * Called after every state transition that may free or require a slot:
 *   - task creation
 *   - task finish (done / failed / cancelled)
 *   - manual pause (frees a slot)
 *   - manual resume (consumes a slot)
 *   - cancel (frees a slot)
 *   - maxConcurrent change
 */
function schedule(): void {
  const running = countRunning();
  if (running >= maxConcurrent) return;
  let slots = maxConcurrent - running;
  for (const e of tasks.values()) {
    if (slots <= 0) break;
    if (e.task.status === "queued" && !e.launched && e.runner) {
      e.task.status = "running";
      e.launched = true;
      // Launch the runner asynchronously.
      e.runner();
      slots--;
    }
  }
}

// --- public registry operations ---------------------------------------------

export function listTasks(): Task[] {
  return Array.from(tasks.values()).map(publicTask);
}

export function getTask(id: string): Task | null {
  const e = tasks.get(id);
  return e ? publicTask(e) : null;
}

/** Remove a finished task from the registry. Only allowed when not active. */
export function removeTask(id: string): { ok: boolean; error?: string } {
  const e = tasks.get(id);
  if (!e) return { ok: false, error: "task not found" };
  if (e.task.status === "running" || e.task.status === "paused" || e.task.status === "queued") {
    return { ok: false, error: "cancel the task before removing it" };
  }
  tasks.delete(id);
  return { ok: true };
}

export function pauseTask(id: string): { ok: boolean; error?: string } {
  const e = tasks.get(id);
  if (!e) return { ok: false, error: "task not found" };
  if (e.task.status !== "running") return { ok: false, error: `task is ${e.task.status}` };
  e.gate.pause();
  e.task.status = "paused";
  for (const it of e.task.items) if (it.status === "running") it.status = "paused";
  // Pausing frees a concurrency slot — start the next queued task.
  schedule();
  return { ok: true };
}

export function resumeTask(id: string): { ok: boolean; error?: string } {
  const e = tasks.get(id);
  if (!e) return { ok: false, error: "task not found" };
  if (e.task.status !== "paused" && e.task.status !== "queued") {
    return { ok: false, error: `task is ${e.task.status}` };
  }
  // If there's no free slot, move to queued (or keep queued) and wait.
  if (countRunning() >= maxConcurrent) {
    if (e.task.status === "paused") {
      // Was paused, now no slot — re-queue.
      e.task.status = "queued";
      for (const it of e.task.items) if (it.status === "paused") it.status = "queued";
    }
    return { ok: true }; // will auto-start when a slot opens
  }
  // Slot available — resume.
  e.gate.resume();
  e.task.status = "running";
  for (const it of e.task.items) if (it.status === "paused" || it.status === "queued") it.status = "running";
  // If the runner was never launched (queued from the start), launch it now.
  if (!e.launched && e.runner) {
    e.launched = true;
    e.runner();
  }
  return { ok: true };
}

export function cancelTask(id: string): { ok: boolean; error?: string } {
  const e = tasks.get(id);
  if (!e) return { ok: false, error: "task not found" };
  if (e.task.status === "done" || e.task.status === "failed" || e.task.status === "cancelled") {
    return { ok: false, error: `task is already ${e.task.status}` };
  }
  // Wake any paused loop so it can observe the abort and exit.
  e.gate.resume();
  e.abort.abort();
  // Status is set to "cancelled" by the runner when it observes the abort;
  // but set it optimistically so the UI reflects intent immediately. The
  // runner will keep it as cancelled (or failed if it already errored).
  e.task.status = "cancelled";
  e.task.finishedAt = new Date().toISOString();
  for (const it of e.task.items) {
    if (it.status === "running" || it.status === "paused" || it.status === "queued") {
      it.status = "cancelled";
      it.progress = null;
    }
  }
  // Cancelling frees a concurrency slot — start the next queued task.
  schedule();
  return { ok: true };
}

// --- bulk operations --------------------------------------------------------

/** Pause every currently-running task. Returns the ids that were paused. */
export function pauseAllTasks(): { paused: string[] } {
  const paused: string[] = [];
  for (const [id, e] of tasks) {
    if (e.task.status === "running") {
      e.gate.pause();
      e.task.status = "paused";
      for (const it of e.task.items) if (it.status === "running") it.status = "paused";
      paused.push(id);
    }
  }
  return { paused };
}

/** Resume every paused or queued task (respecting the concurrency limit). */
export function resumeAllTasks(): { resumed: string[] } {
  const resumed: string[] = [];
  for (const [id, e] of tasks) {
    if (e.task.status === "paused" || e.task.status === "queued") {
      // Try to resume; resumeTask handles slot checking.
      const r = resumeTask(id);
      if (r.ok) resumed.push(id);
    }
  }
  return { resumed };
}

/** Cancel every active (running, paused, or queued) task. */
/** True when a task covering this asset is queued / running / paused —
 *  used to avoid duplicate downloads when a candidate is KEEPed twice. */
export function hasActiveTaskForAsset(assetId: string): boolean {
  for (const e of tasks.values()) {
    const s = e.task.status;
    if (s !== "queued" && s !== "running" && s !== "paused") continue;
    if (e.task.assetId === assetId) return true;
    if (e.task.assetIds?.includes(assetId)) return true;
    if (e.task.items.some((it) => it.id === assetId)) return true;
  }
  return false;
}

/** Cancel active single-asset ("asset" kind) download tasks for an asset —
 *  called when a candidate is REJECTED so a kept-then-rejected download
 *  doesn't keep running. Batch tasks are left alone (they cover other assets). */
export function cancelTasksForAsset(assetId: string): number {
  let n = 0;
  for (const e of [...tasks.values()]) {
    if (e.task.kind !== "asset" || e.task.assetId !== assetId) continue;
    const s = e.task.status;
    if (s === "queued" || s === "running" || s === "paused") {
      cancelTask(e.task.id);
      n++;
    }
  }
  return n;
}

export function cancelAllTasks(): { cancelled: string[] } {
  const cancelled: string[] = [];
  for (const [id, e] of tasks) {
    if (e.task.status === "running" || e.task.status === "paused" || e.task.status === "queued") {
      e.gate.resume();
      e.abort.abort();
      e.task.status = "cancelled";
      e.task.finishedAt = new Date().toISOString();
      for (const it of e.task.items) {
        if (it.status === "running" || it.status === "paused" || it.status === "queued") {
          it.status = "cancelled";
          it.progress = null;
        }
      }
      cancelled.push(id);
    }
  }
  return { cancelled };
}

// --- task runners -----------------------------------------------------------

/** Start a single-asset download as a tracked task. */
export function startAcquireAssetTask(assetId: string): Task {
  const label = `Acquire asset ${assetId}`;
  const entry = makeEntry("asset", label, { assetId });
  upsertItem(entry, assetId, label, "queued");
  entry.runner = () => runAcquireAssetTask(entry, assetId);
  tasks.set(entry.task.id, entry);
  schedule();
  return publicTask(entry);
}

async function runAcquireAssetTask(entry: TaskEntry, assetId: string): Promise<void> {
  try {
    const r = await acquireAssetById(assetId, (p) => {
      if (p) {
        setProgress(entry, p.receivedBytes, p.totalBytes);
        setItemProgress(entry, assetId, p.receivedBytes, p.totalBytes);
      } else {
        clearProgress(entry);
      }
    }, entry.controller);
    if (entry.controller.signal.aborted) {
      finishItem(entry, assetId, "cancelled");
      finish(entry, "cancelled", null);
    } else if (r.status === "failed") {
      finishItem(entry, assetId, "failed", r.error ?? "failed");
      finish(entry, "failed", r.error ?? "failed");
    } else {
      finishItem(entry, assetId, "done");
      finish(entry, "done", null); // downloaded / already_downloaded / rejected
    }
  } catch (e) {
    if (entry.controller.signal.aborted) {
      finishItem(entry, assetId, "cancelled");
      finish(entry, "cancelled", null);
    } else {
      finishItem(entry, assetId, "failed", (e as Error).message);
      finish(entry, "failed", (e as Error).message);
    }
  }
}

/** Start a single-shot acquisition (search + download) as a tracked task. */
export function startAcquireShotTask(shotId: string): Task {
  const label = `Acquire shot ${shotId}`;
  const entry = makeEntry("shot", label, { shotId });
  entry.runner = () => runAcquireShotTask(entry, shotId);
  tasks.set(entry.task.id, entry);
  schedule();
  return publicTask(entry);
}

async function runAcquireShotTask(entry: TaskEntry, shotId: string): Promise<void> {
  let currentItemId: string | null = null;
  try {
    await acquireShot(shotId, undefined, (p) => {
      if (p) {
        // A new download started — mark the previous item as done if the id
        // changed (the pipeline sends null between assets, but be defensive).
        if (currentItemId && currentItemId !== p.assetId) {
          finishItem(entry, currentItemId, "done");
        }
        currentItemId = p.assetId;
        upsertItem(entry, p.assetId, p.assetName || p.assetId, "running");
        setProgress(entry, p.receivedBytes, p.totalBytes);
        setItemProgress(entry, p.assetId, p.receivedBytes, p.totalBytes);
      } else {
        // null marks the end of the current asset's download.
        if (currentItemId) {
          finishItem(entry, currentItemId, "done");
          currentItemId = null;
        }
        clearProgress(entry);
      }
    }, entry.controller);
    if (currentItemId) finishItem(entry, currentItemId, "done");
    if (entry.controller.signal.aborted) finish(entry, "cancelled", null);
    else finish(entry, "done", null);
  } catch (e) {
    if (currentItemId) finishItem(entry, currentItemId, entry.controller.signal.aborted ? "cancelled" : "failed");
    if (entry.controller.signal.aborted) finish(entry, "cancelled", null);
    else finish(entry, "failed", (e as Error).message);
  }
}

/** Start a batch asset download as a single tracked task. */
export function startAcquireBatchTask(assetIds: string[]): Task {
  const label = `Acquire ${assetIds.length} asset${assetIds.length === 1 ? "" : "s"}`;
  const entry = makeEntry("batch", label, { assetIds, total: assetIds.length, completed: 0, succeeded: 0, failed: 0 });
  // Pre-create all items as queued so the UI can show the full group upfront.
  for (const id of assetIds) upsertItem(entry, id, id, "queued");
  entry.runner = () => runAcquireBatchTask(entry, assetIds);
  tasks.set(entry.task.id, entry);
  schedule();
  return publicTask(entry);
}

async function runAcquireBatchTask(entry: TaskEntry, assetIds: string[]): Promise<void> {
  let succeeded = 0;
  let failed = 0;
  try {
    for (const id of assetIds) {
      if (entry.controller.signal.aborted) throw new Error("cancelled");
      // Block between assets while paused.
      await entry.controller.waitIfPaused();
      if (entry.controller.signal.aborted) throw new Error("cancelled");
      entry.task.progress = null;
      upsertItem(entry, id, id, "running");
      try {
        const r = await acquireAssetById(id, (p) => {
          if (p) {
            setProgress(entry, p.receivedBytes, p.totalBytes);
            setItemProgress(entry, id, p.receivedBytes, p.totalBytes);
          } else {
            entry.task.progress = null;
          }
        }, entry.controller);
        if (r.status === "downloaded" || r.status === "already_downloaded" || r.status === "rejected") {
          succeeded++;
          finishItem(entry, id, "done");
        } else {
          failed++;
          finishItem(entry, id, "failed", r.error ?? r.reason ?? "failed");
        }
      } catch (e) {
        if (entry.controller.signal.aborted) {
          finishItem(entry, id, "cancelled");
          throw e;
        }
        failed++;
        finishItem(entry, id, "failed", (e as Error).message);
        console.warn(`[task-batch] asset ${id} failed: ${(e as Error).message}`);
      }
      entry.task.completed = (entry.task.completed ?? 0) + 1;
      entry.task.succeeded = succeeded;
      entry.task.failed = failed;
    }
    finish(entry, "done", null);
  } catch (e) {
    if (entry.controller.signal.aborted) finish(entry, "cancelled", null);
    else finish(entry, "failed", (e as Error).message);
  }
}
