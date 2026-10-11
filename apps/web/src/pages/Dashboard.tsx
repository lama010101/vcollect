import { useEffect, useState, useRef, useCallback } from "react";
import { api, type Dashboard as Dash, type Provider, type Task, type TaskConfig, type Shot } from "../api.js";
import { Card, StatCard, Button, Badge, ProgressBar, SectionTitle, EmptyState, Spinner } from "../components/ui.js";
import { ProjectsPanel } from "../components/ProjectsPanel.js";

interface DashboardProps {
  projectId: string;
  onToast: (text: string, tone?: "info" | "success" | "error") => void;
  onNavigate: (v: { name: "dashboard" } | { name: "library" } | { name: "timeline" } | { name: "folders" } | { name: "import" } | { name: "help" }) => void;
  onSwitchProject: (id: string) => void;
  onProjectsChanged: () => void;
}

export function Dashboard({ projectId, onToast, onNavigate, onSwitchProject, onProjectsChanged }: DashboardProps) {
  const [d, setD] = useState<Dash | null>(null);
  const [provs, setProvs] = useState<Provider[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCfg, setTaskCfg] = useState<TaskConfig | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [dash, provRes, taskRes, shotRes, cfgRes] = await Promise.all([
        api.dashboard(projectId),
        api.providers(),
        api.tasks(),
        api.shots(projectId),
        api.getTaskConfig(),
      ]);
      setD(dash);
      setProvs(provRes.providers);
      setTasks(taskRes.tasks);
      setShots(shotRes.shots);
      setTaskCfg(cfgRes.config);
    } catch (e) {
      onToast(`Failed to load dashboard: ${(e as Error).message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, onToast]);

  useEffect(() => {
    setLoading(true);
    load();
    // Poll tasks + dashboard every 3s for live updates.
    pollRef.current = setInterval(load, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  async function runAcquireAll() {
    setActionLoading(true);
    try {
      const r = await api.acquireAll(projectId);
      if (r.alreadyRunning) {
        onToast("Acquisition is already running.", "info");
      } else {
        onToast("Acquisition started — downloading candidates for all shots.", "success");
      }
      setTimeout(load, 500);
    } catch (e) {
      onToast(`Acquire failed: ${(e as Error).message}`, "error");
    } finally {
      setActionLoading(false);
    }
  }

  async function genManifests() {
    setActionLoading(true);
    try {
      await api.generateManifests(projectId);
      onToast("Manifests generated successfully.", "success");
    } catch (e) {
      onToast(`Manifests failed: ${(e as Error).message}`, "error");
    } finally {
      setActionLoading(false);
    }
  }

  async function runReserve() {
    setActionLoading(true);
    try {
      await api.acquireReserve(projectId);
      onToast("Reserve pool acquisition complete.", "success");
      setTimeout(load, 500);
    } catch (e) {
      onToast(`Reserve pool failed: ${(e as Error).message}`, "error");
    } finally {
      setActionLoading(false);
    }
  }

  const pauseAll = async () => {
    try { await api.pauseAllTasks(); onToast("All downloads paused.", "info"); } catch (e) { onToast(`Pause failed: ${(e as Error).message}`, "error"); }
  };
  const resumeAll = async () => {
    try { await api.resumeAllTasks(); onToast("All downloads resumed.", "info"); } catch (e) { onToast(`Resume failed: ${(e as Error).message}`, "error"); }
  };
  const cancelAll = async () => {
    try { await api.cancelAllTasks(); onToast("All downloads cancelled.", "info"); } catch (e) { onToast(`Cancel failed: ${(e as Error).message}`, "error"); }
  };

  if (loading && !d) return <div className="flex items-center justify-center py-20"><Spinner className="w-8 h-8 text-sky-500" /></div>;
  if (!d) return <EmptyState title="No data" description="Could not load dashboard data." />;

  const downloadPct = d.total > 0 ? Math.round((d.downloaded / d.total) * 100) : 0;
  const confirmedPct = d.total > 0 ? Math.round((d.confirmed / d.total) * 100) : 0;
  const approvedPct = d.total > 0 ? Math.round((d.approved / d.total) * 100) : 0;
  const activeTasks = tasks.filter((t) => t.status === "running" || t.status === "paused" || t.status === "queued");
  const runningTasks = tasks.filter((t) => t.status === "running");
  const pausedTasks = tasks.filter((t) => t.status === "paused");
  const queuedTasks = tasks.filter((t) => t.status === "queued");

  // Shot status breakdown
  const shotStatuses = shots.reduce((acc, s) => {
    const st = s.status ?? "SEARCH_PENDING";
    acc[st] = (acc[st] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const shotDone = shotStatuses["DONE"] ?? 0;
  const shotReview = shotStatuses["REVIEW"] ?? 0;
  const shotFailed = shotStatuses["FAILED"] ?? 0;
  const shotPending = shots.length - shotDone - shotReview - shotFailed;
  const shotProgressPct = shots.length > 0 ? Math.round((shotDone / shots.length) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* ===== Projects: select / create / manage ===== */}
      <ProjectsPanel
        onChanged={onProjectsChanged}
        onSwitch={onSwitchProject}
        onImport={(pid) => { onSwitchProject(pid); onNavigate({ name: "import" }); }}
        activeProjectId={projectId}
      />

      {/* ===== Hero stats row ===== */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Total assets" value={d.total} icon="◆" tone="info" />
        <StatCard label="Downloaded" value={d.downloaded} icon="↓" tone="good" progress={downloadPct} sublabel={`${downloadPct}% of pool — view all`} onClick={() => onNavigate({ name: "folders" })} />
        <StatCard label="License confirmed" value={d.confirmed} icon="✓" tone="good" progress={confirmedPct} />
        <StatCard label="Needs review" value={d.review} icon="!" tone="warn" />
        <StatCard label="Rejected" value={d.rejected} icon="✕" tone="bad" />
        <StatCard label="Approved" value={d.approved} icon="★" tone="good" progress={approvedPct} />
      </div>

      {/* ===== Two-column: Quick actions + Active downloads ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Quick actions */}
        <Card className="p-4 lg:col-span-1">
          <SectionTitle icon="⚡" className="mb-3">Quick Actions</SectionTitle>
          <div className="space-y-2">
            <Button variant="primary" onClick={runAcquireAll} disabled={actionLoading} className="w-full">
              {actionLoading ? <Spinner className="w-4 h-4" /> : "↓"} Run acquisition (all shots)
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={genManifests} disabled={actionLoading} className="w-full">
                📋 Manifests
              </Button>
              <Button variant="secondary" onClick={runReserve} disabled={actionLoading} className="w-full">
                🎯 Reserve pool
              </Button>
            </div>
            <div className="pt-2 border-t border-slate-700/40 space-y-1.5">
              <button onClick={() => onNavigate({ name: "library" })} className="w-full text-left text-sm text-slate-400 hover:text-sky-400 transition-colors py-1.5 px-2 rounded hover:bg-slate-800/40">
                ⌕ Browse the library →
              </button>
              <button onClick={() => onNavigate({ name: "timeline" })} className="w-full text-left text-sm text-slate-400 hover:text-sky-400 transition-colors py-1.5 px-2 rounded hover:bg-slate-800/40">
                ▬ Open 3D timeline & review shots →
              </button>
              <button onClick={() => onNavigate({ name: "folders" })} className="w-full text-left text-sm text-slate-400 hover:text-sky-400 transition-colors py-1.5 px-2 rounded hover:bg-slate-800/40">
                ▤ Browse downloaded folders →
              </button>
            </div>
          </div>
        </Card>

        {/* Active downloads */}
        <Card className="p-4 lg:col-span-2">
          <SectionTitle
            icon="↓"
            className="mb-3"
            action={
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onNavigate({ name: "folders" })}
                  className="text-xs text-sky-400 hover:underline"
                  title="Show all downloaded assets"
                >
                  All downloaded →
                </button>
                {taskCfg && (
                  <span className="text-[10px] text-slate-500">
                    {taskCfg.running}/{taskCfg.maxConcurrent} active
                    {taskCfg.queued > 0 && <span className="text-slate-400"> · {taskCfg.queued} queued</span>}
                  </span>
                )}
                {activeTasks.length > 0 && (
                  <div className="flex gap-1">
                    {runningTasks.length > 0 && <Button size="sm" variant="ghost" onClick={pauseAll}>Pause all</Button>}
                    {(pausedTasks.length > 0 || queuedTasks.length > 0) && <Button size="sm" variant="ghost" onClick={resumeAll}>Resume all</Button>}
                    <Button size="sm" variant="ghost" onClick={cancelAll}>Cancel all</Button>
                  </div>
                )}
              </div>
            }
          >
            Active Downloads
          </SectionTitle>

          {activeTasks.length === 0 ? (
            <EmptyState icon="↓" title="No active downloads" description="Start an acquisition or download assets from the Library page." />
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {activeTasks.map((t) => {
                const isBatch = t.kind === "batch";
                const batchPct = t.total && t.total > 0 ? Math.round(((t.completed ?? 0) / t.total) * 100) : 0;
                const isQueued = t.status === "queued";
                return (
                  <div key={t.id} className={`rounded-lg border p-3 ${isQueued ? "bg-slate-900/20 border-slate-700/30 border-dashed" : "bg-slate-900/40 border-slate-700/40"}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge tone={t.status === "running" ? "info" : t.status === "paused" ? "warn" : "default"}>{t.status}</Badge>
                        <span className="text-xs text-slate-300 truncate">{t.label}</span>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {t.status === "running" && <Button size="sm" variant="ghost" onClick={() => api.pauseTask(t.id).then(load)}>Pause</Button>}
                        {t.status === "paused" && <Button size="sm" variant="ghost" onClick={() => api.resumeTask(t.id).then(load)}>Resume</Button>}
                        <Button size="sm" variant="ghost" onClick={() => api.cancelTask(t.id).then(load)}>Cancel</Button>
                      </div>
                    </div>
                    {isQueued ? (
                      <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse-soft" />
                        Waiting for a concurrency slot…
                      </div>
                    ) : isBatch ? (
                      <>
                        <ProgressBar value={t.completed ?? 0} max={t.total ?? 1} />
                        <div className="text-[10px] text-slate-500 mt-1 flex justify-between">
                          <span>{t.completed ?? 0} / {t.total}</span>
                          <span>{t.succeeded ?? 0} done · {t.failed ?? 0} failed</span>
                        </div>
                      </>
                    ) : t.progress ? (
                      <>
                        <ProgressBar value={t.progress.pct} />
                        <div className="text-[10px] text-slate-500 mt-1">{t.progress.pct}%</div>
                      </>
                    ) : (
                      <div className="text-[10px] text-slate-500">preparing…</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ===== Shot progress + License status ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Shot progress */}
        <Card className="p-4">
          <SectionTitle icon="▬" className="mb-3" action={<button onClick={() => onNavigate({ name: "timeline" })} className="text-xs text-sky-400 hover:underline">Open 3D timeline →</button>}>
            Shot Progress
          </SectionTitle>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Completion</span>
                <span className="text-slate-300">{shotDone} / {shots.length} done ({shotProgressPct}%)</span>
              </div>
              <ProgressBar value={shotDone} max={shots.length} color="bg-emerald-500" height="h-3" />
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="text-center rounded-lg bg-slate-900/40 border border-slate-700/40 py-2">
                <div className="text-lg font-bold text-emerald-400">{shotDone}</div>
                <div className="text-[10px] text-slate-500">Done</div>
              </div>
              <div className="text-center rounded-lg bg-slate-900/40 border border-slate-700/40 py-2">
                <div className="text-lg font-bold text-amber-400">{shotReview}</div>
                <div className="text-[10px] text-slate-500">Review</div>
              </div>
              <div className="text-center rounded-lg bg-slate-900/40 border border-slate-700/40 py-2">
                <div className="text-lg font-bold text-slate-400">{shotPending}</div>
                <div className="text-[10px] text-slate-500">Pending</div>
              </div>
              <div className="text-center rounded-lg bg-slate-900/40 border border-slate-700/40 py-2">
                <div className="text-lg font-bold text-rose-400">{shotFailed}</div>
                <div className="text-[10px] text-slate-500">Failed</div>
              </div>
            </div>
            <div className="text-xs text-slate-500 pt-1">
              {d.shotsWithCandidates} of {d.shotsTotal} shots have candidates.
            </div>
          </div>
        </Card>

        {/* License & rights */}
        <Card className="p-4">
          <SectionTitle icon="§" className="mb-3">Rights &amp; License Status</SectionTitle>
          <div className="space-y-3">
            <div className="rounded-lg bg-emerald-950/30 border border-emerald-800/30 p-3">
              <div className="text-sm font-semibold text-emerald-300">{d.verifiedLabel}</div>
              <div className="text-xs text-slate-400 mt-1">Source license verified for commercial use.</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-slate-900/40 border border-slate-700/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Confirmed</span>
                  <Badge tone="good">{d.confirmed}</Badge>
                </div>
              </div>
              <div className="rounded-lg bg-slate-900/40 border border-slate-700/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Review</span>
                  <Badge tone="warn">{d.review}</Badge>
                </div>
              </div>
              <div className="rounded-lg bg-slate-900/40 border border-slate-700/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Rejected</span>
                  <Badge tone="bad">{d.rejected}</Badge>
                </div>
              </div>
              <div className="rounded-lg bg-slate-900/40 border border-slate-700/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Approved</span>
                  <Badge tone="good">{d.approved}</Badge>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== Sources ===== */}
      <Card className="p-4">
        <SectionTitle icon="◆" className="mb-3">Sources</SectionTitle>
        {provs.length === 0 ? (
          <p className="text-xs text-slate-500">No providers configured.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {provs.map((p) => (
              <div key={p.id} className="rounded-lg bg-slate-900/40 border border-slate-700/40 p-3">
                <div className="flex items-center justify-between mb-1">
                  <a href={p.attribution_url ?? "#"} target="_blank" rel="noreferrer" className="text-sm font-medium text-sky-400 hover:underline">
                    {p.name}
                  </a>
                  <Badge tone="info">{d.byProvider[p.id] ?? 0} assets</Badge>
                </div>
                <a href={p.license_url ?? "#"} target="_blank" rel="noreferrer" className="text-xs text-slate-500 hover:text-slate-300">
                  View license →
                </a>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
