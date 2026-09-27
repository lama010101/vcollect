import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Task, type TaskItem, type TaskStatus, type TaskConfig } from "../api.js";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case "running": return "text-sky-400";
    case "paused": return "text-amber-400";
    case "queued": return "text-slate-400";
    case "done": return "text-emerald-400";
    case "failed": return "text-rose-400";
    case "cancelled": return "text-slate-400";
    default: return "text-slate-400";
  }
}

function progressBar(pct: number, color = "bg-sky-500"): JSX.Element {
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
      <div className={`${color} h-full transition-all`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

/** A single download row within a session. */
function DownloadRow({ item }: { item: TaskItem }) {
  const pct = item.progress?.pct ?? 0;
  return (
    <div className="rounded bg-slate-800/60 border border-slate-700/60 px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="truncate text-slate-300" title={item.label}>{item.label}</span>
        <span className={`shrink-0 ${statusColor(item.status)}`}>{item.status}</span>
      </div>
      {(item.status === "running" || item.status === "paused") && item.progress && (
        <>
          {progressBar(pct, item.status === "paused" ? "bg-amber-500" : "bg-sky-500")}
          <div className="text-[10px] text-slate-400 mt-0.5 flex justify-between">
            <span>{pct}%</span>
            <span>{fmtBytes(item.progress.receivedBytes)}{item.progress.totalBytes > 0 ? ` / ${fmtBytes(item.progress.totalBytes)}` : ""}</span>
          </div>
        </>
      )}
      {item.status === "queued" && (
        <div className="text-[10px] text-slate-500 mt-0.5">waiting for slot…</div>
      )}
      {item.error && (
        <div className="text-[10px] text-rose-400 mt-0.5 truncate" title={item.error}>{item.error}</div>
      )}
    </div>
  );
}

/** A session card: header with per-session controls + grouped downloads. */
function SessionCard({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const isQueued = task.status === "queued";
  const isActive = task.status === "running" || task.status === "paused";
  const isFinished = task.status === "done" || task.status === "failed" || task.status === "cancelled";
  const isBatch = task.kind === "batch";
  const batchPct = task.total && task.total > 0 ? Math.round(((task.completed ?? 0) / task.total) * 100) : 0;

  async function call(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); } catch (e) { console.error(`[tasks] action failed: ${(e as Error).message}`); }
    finally { setBusy(false); onChanged(); }
  }

  const doneCount = task.items.filter((i) => i.status === "done").length;
  const failedCount = task.items.filter((i) => i.status === "failed").length;
  const runningCount = task.items.filter((i) => i.status === "running" || i.status === "paused").length;
  const queuedCount = task.items.filter((i) => i.status === "queued").length;

  return (
    <div className={`rounded bg-slate-900 border overflow-hidden ${isQueued ? "border-slate-600/40 border-dashed" : "border-slate-700"}`}>
      {/* Session header */}
      <div className="px-3 py-2 bg-slate-800/80">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-slate-400 text-[10px] w-4 shrink-0 hover:text-slate-200"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? "▾" : "▸"}
            </button>
            <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">{task.kind}</span>
            <span className="truncate text-slate-200 text-xs font-medium" title={task.label}>{task.label}</span>
          </div>
          <span className={`text-[10px] shrink-0 ${statusColor(task.status)}`}>{task.status}</span>
        </div>

        {/* Queued indicator */}
        {isQueued && (
          <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse-soft" />
            Waiting for a concurrency slot…
          </div>
        )}

        {/* Aggregate progress */}
        {isActive && !isBatch && task.progress && (
          <div className="mb-1">
            {progressBar(task.progress.pct)}
            <div className="text-[10px] text-slate-400 mt-0.5 flex justify-between">
              <span>{task.progress.pct}%</span>
              <span>{fmtBytes(task.progress.receivedBytes)}{task.progress.totalBytes > 0 ? ` / ${fmtBytes(task.progress.totalBytes)}` : ""}</span>
            </div>
          </div>
        )}
        {isActive && isBatch && (
          <div className="mb-1">
            {progressBar(batchPct)}
            <div className="text-[10px] text-slate-400 mt-0.5 flex justify-between">
              <span>{task.completed ?? 0} / {task.total} ({batchPct}%)</span>
              <span>
                {doneCount > 0 && <span className="text-emerald-400">{doneCount} done </span>}
                {failedCount > 0 && <span className="text-rose-400">{failedCount} failed </span>}
                {runningCount > 0 && <span className="text-sky-400">{runningCount} active </span>}
                {queuedCount > 0 && <span className="text-slate-400">{queuedCount} queued</span>}
              </span>
            </div>
          </div>
        )}
        {isFinished && isBatch && (
          <div className="text-[10px] text-slate-400 mb-1">
            {task.completed ?? 0} / {task.total}
            {doneCount > 0 && <span className="text-emerald-400 ml-2">{doneCount} done</span>}
            {failedCount > 0 && <span className="text-rose-400 ml-2">{failedCount} failed</span>}
          </div>
        )}
        {task.error && (
          <div className="text-[10px] text-rose-400 mb-1 truncate" title={task.error}>{task.error}</div>
        )}

        {/* Per-session controls */}
        <div className="flex gap-1 flex-wrap">
          {task.status === "running" && (
            <button onClick={() => call(() => api.pauseTask(task.id))} disabled={busy}
              className="px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-[10px]">
              Pause
            </button>
          )}
          {task.status === "paused" && (
            <button onClick={() => call(() => api.resumeTask(task.id))} disabled={busy}
              className="px-2 py-0.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-[10px]">
              Resume
            </button>
          )}
          {isQueued && (
            <button onClick={() => call(() => api.cancelTask(task.id))} disabled={busy}
              className="px-2 py-0.5 rounded bg-rose-800 hover:bg-rose-700 disabled:opacity-50 text-white text-[10px]">
              Cancel
            </button>
          )}
          {isActive && (
            <button onClick={() => call(() => api.cancelTask(task.id))} disabled={busy}
              className="px-2 py-0.5 rounded bg-rose-800 hover:bg-rose-700 disabled:opacity-50 text-white text-[10px]">
              Cancel
            </button>
          )}
          {isFinished && (
            <button onClick={() => call(() => api.removeTask(task.id))} disabled={busy}
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px]">
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Grouped downloads */}
      {expanded && task.items.length > 0 && (
        <div className="p-2 space-y-1.5 bg-slate-900/40">
          {task.items.map((it) => (
            <DownloadRow key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Global floating panel showing every concurrent download session, with the
 * individual downloads grouped under each session. Provides global Pause All /
 * Resume All / Cancel All plus per-session Pause / Resume / Cancel.
 * Shows the concurrency limit and allows adjusting it. Polls /api/tasks while
 * mounted. Renders nothing when there are no tasks.
 */
export function TasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [config, setConfig] = useState<TaskConfig | null>(null);
  const [open, setOpen] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [taskRes, cfgRes] = await Promise.all([api.tasks(), api.getTaskConfig()]);
      setTasks(taskRes.tasks);
      setConfig(cfgRes.config);
    } catch (e) {
      console.error(`[tasks] poll failed: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  const queued = tasks.filter((t) => t.status === "queued");
  const active = tasks.filter((t) => t.status === "running" || t.status === "paused");
  const finished = tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
  const ordered = [
    ...active.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    ...queued.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    ...finished.sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt)),
  ];

  if (tasks.length === 0) return null;

  const runningCount = active.filter((t) => t.status === "running").length;
  const pausedCount = active.filter((t) => t.status === "paused").length;
  const queuedCount = queued.length;
  const anyActive = active.length > 0 || queuedCount > 0;
  const anyPaused = pausedCount > 0;
  const anyRunning = runningCount > 0;

  async function bulk(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { console.error(`[tasks] bulk failed: ${(e as Error).message}`); }
    finally { refresh(); }
  }

  async function adjustConcurrency(delta: number) {
    if (!config) return;
    const next = Math.max(1, Math.min(20, config.maxConcurrent + delta));
    try { await api.setTaskConfig(next); } catch (e) { console.error(`[tasks] set config failed: ${(e as Error).message}`); }
    finally { refresh(); }
  }

  return (
    <div className="fixed bottom-3 right-3 z-50 w-96 max-w-[calc(100vw-1.5rem)]">
      <div className="rounded-lg bg-slate-800 border border-slate-600 shadow-xl overflow-hidden">
        {/* Header: title + global controls */}
        <div className="bg-slate-800">
          <button
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-750 text-left"
          >
            <span className="text-xs font-semibold text-slate-200 flex items-center gap-2">
              Downloads
              {runningCount > 0 && <span className="text-sky-400">{runningCount} running</span>}
              {pausedCount > 0 && <span className="text-amber-400">{pausedCount} paused</span>}
              {queuedCount > 0 && <span className="text-slate-400">{queuedCount} queued</span>}
              {runningCount === 0 && pausedCount === 0 && queuedCount === 0 && <span className="text-slate-400">{finished.length} recent</span>}
            </span>
            <span className="text-slate-400 text-xs">{open ? "▾" : "▸"}</span>
          </button>

          {/* Concurrency limit control + global bulk controls */}
          {open && (
            <div className="px-3 pb-2 space-y-2">
              {/* Concurrency limit adjuster */}
              {config && (
                <div className="flex items-center justify-between gap-2 bg-slate-900/60 rounded-lg px-2 py-1.5 border border-slate-700/40">
                  <span className="text-[10px] text-slate-400">Max concurrent</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => adjustConcurrency(-1)}
                      disabled={config.maxConcurrent <= 1}
                      className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-xs flex items-center justify-center"
                      title="Decrease max concurrent downloads"
                    >−</button>
                    <span className="text-xs font-bold text-slate-200 w-6 text-center">{config.maxConcurrent}</span>
                    <button
                      onClick={() => adjustConcurrency(+1)}
                      disabled={config.maxConcurrent >= 20}
                      className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-xs flex items-center justify-center"
                      title="Increase max concurrent downloads"
                    >+</button>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {config.running}/{config.maxConcurrent} active
                    {config.queued > 0 && <span className="text-slate-400"> · {config.queued} queued</span>}
                  </span>
                </div>
              )}

              {/* Global bulk controls */}
              {anyActive && (
                <div className="flex gap-1 flex-wrap">
                  <button
                    onClick={() => bulk(() => api.pauseAllTasks())}
                    disabled={!anyRunning}
                    className="px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-white text-[10px] font-semibold"
                    title="Pause every running session"
                  >
                    Pause All
                  </button>
                  <button
                    onClick={() => bulk(() => api.resumeAllTasks())}
                    disabled={!anyPaused && queuedCount === 0}
                    className="px-2 py-0.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-white text-[10px] font-semibold"
                    title="Resume every paused/queued session"
                  >
                    Resume All
                  </button>
                  <button
                    onClick={() => bulk(() => api.cancelAllTasks())}
                    className="px-2 py-0.5 rounded bg-rose-800 hover:bg-rose-700 text-white text-[10px] font-semibold"
                    title="Cancel every active/queued session"
                  >
                    Cancel All
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {open && (
          <div className="p-2 space-y-2 max-h-[60vh] overflow-y-auto">
            {ordered.map((t) => (
              <SessionCard key={t.id} task={t} onChanged={refresh} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
