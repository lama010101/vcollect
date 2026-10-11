import { useCallback, useEffect, useState, useRef } from "react";
import { api, type Asset, type AssetDownloadProgress, type Shot, type Task, type TaskStatus, type Timeline } from "../api.js";
import {
  ACQUIRE_COUNT_DEFAULT,
  MIN_ACQUIRE_RATING_DEFAULT,
  MIN_CANDIDATES_PER_SHOT_DEFAULT,
  sectionFolder,
} from "@twio/shared";
import { RatingSlider } from "../components/RatingSlider.js";
import { Button, Badge, EmptyState } from "../components/ui.js";

export function ShotReview({ shotId, onBack }: { shotId: string; onBack: () => void }) {
  const [shot, setShot] = useState<Shot | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [currentAsset, setCurrentAsset] = useState<AssetDownloadProgress | null>(null);
  const [done, setDone] = useState<{ downloaded: number; candidatesFound: number } | null>(null);
  const [acquirePaused, setAcquirePaused] = useState(false);
  const [keepingAll, setKeepingAll] = useState(false);
  // Download tasks covering this shot's assets, keyed by asset id. SELECTing
  // a candidate starts a task server-side; we poll so cards can show progress
  // and pause / resume / cancel controls.
  const [tasksByAsset, setTasksByAsset] = useState<Map<string, { taskId: string; status: TaskStatus; progress: Task["progress"] }>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The shot-acquire task id this page is watching (tasks registry). Null when
  // no acquire run is active — polling then stops and controls hide.
  const acquireTaskIdRef = useRef<string | null>(null);
  const taskPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const assetsRef = useRef<Asset[]>([]);
  const finishedTasksRef = useRef<Set<string>>(new Set());
  // ratingOverrides lets the UI update immediately on slider change without
  // waiting for a full reload. Keyed by asset id; value is 0-10 or null.
  const [ratingOverrides, setRatingOverrides] = useState<Map<string, number | null>>(new Map());
  // Asset ids flagged "on the timeline rail" (shot_assets.on_rail) — the rail
  // on the Timeline page shows only top-N candidates by rank plus these.
  const [onRail, setOnRail] = useState<Set<string>>(new Set());
  // Asset ids carrying shot_assets.selected — selection is exclusive per shot
  // (the user's pick clears the rest), so at most one card shows SELECTED.
  const [selectedLinks, setSelectedLinks] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const r = await api.shot(shotId);
    const a = r.assets ?? [];
    setShot(r.shot ?? null);
    setAssets(a);
    assetsRef.current = a;
    setRatingOverrides(new Map());
    setOnRail(new Set((r.shotAssets ?? []).filter((l) => l.on_rail === 1).map((l) => l.asset_id)));
    setSelectedLinks(new Set((r.shotAssets ?? []).filter((l) => l.selected === 1).map((l) => l.asset_id)));
  }, [shotId]);
  useEffect(() => {
    load().catch(console.error);
  }, [load, shotId]);

  // --- download-task polling (kept-clip downloads) ---------------------------
  /** One poll tick: rebuilds assetId→task map for this shot's assets, reloads
   *  when a download finishes (asset gains a local file → playable video).
   *  Returns true while any task is still queued/running/paused. */
  const pollTasksOnce = useCallback(async (): Promise<boolean> => {
    const { tasks } = await api.tasks();
    const ids = new Set(assetsRef.current.map((a) => a.id));
    const map = new Map<string, { taskId: string; status: TaskStatus; progress: Task["progress"] }>();
    let active = false;
    let newFinished = false;
    for (const t of tasks) {
      for (const it of t.items) {
        if (!ids.has(it.id)) continue;
        map.set(it.id, { taskId: t.id, status: it.status, progress: it.progress });
        if (it.status === "queued" || it.status === "running" || it.status === "paused") {
          active = true;
        } else if (!finishedTasksRef.current.has(`${t.id}:${it.id}`)) {
          finishedTasksRef.current.add(`${t.id}:${it.id}`);
          newFinished = true;
        }
      }
    }
    setTasksByAsset(map);
    if (newFinished) await load();
    return active;
  }, [load]);

  const stopTaskPolling = useCallback(() => {
    if (taskPollRef.current) { clearInterval(taskPollRef.current); taskPollRef.current = null; }
  }, []);

  const startTaskPolling = useCallback(() => {
    if (taskPollRef.current) return;
    taskPollRef.current = setInterval(async () => {
      try {
        if (!(await pollTasksOnce())) stopTaskPolling();
      } catch { /* transient — keep polling */ }
    }, 800);
  }, [pollTasksOnce, stopTaskPolling]);

  function startTimer() {
    setElapsed(0);
    const start = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
  }
  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  function startPolling() {
    // Track the currently-downloading item + how many items finished across
    // polls. When either changes (one asset finished → next started, or → null
    // between assets), refresh the assets list so completed downloads show
    // their thumbnails immediately instead of only when the task ends.
    let lastAssetId: string | undefined = undefined;
    let lastFinished = -1;
    pollRef.current = setInterval(async () => {
      const taskId = acquireTaskIdRef.current;
      if (!taskId) { stopPolling(); return; }
      try {
        const { task } = await api.task(taskId);
        const busyNow = task.status === "queued" || task.status === "running" || task.status === "paused";
        setAcquirePaused(task.status === "paused");
        if (task.error) {
          setError(task.error);
        }
        const activeItem = task.items.find((it) => it.status === "running" || it.status === "paused") ?? null;
        const cur: AssetDownloadProgress | null = activeItem
          ? {
              assetId: activeItem.id,
              assetName: activeItem.label,
              receivedBytes: activeItem.progress?.receivedBytes ?? 0,
              totalBytes: activeItem.progress?.totalBytes ?? 0,
              pct: activeItem.progress?.pct ?? 0,
            }
          : null;
        setCurrentAsset(cur);
        const finished = task.items.filter((it) => it.status === "done" || it.status === "failed").length;
        if (cur?.assetId !== lastAssetId || finished !== lastFinished) {
          lastAssetId = cur?.assetId;
          lastFinished = finished;
          await load();
        }
        if (!busyNow) {
          stopPolling();
          acquireTaskIdRef.current = null;
          setBusy(false);
          stopTimer();
          setCurrentAsset(null);
          await load();
          if (task.status === "done") {
            setDone({ downloaded: 0, candidatesFound: assetsRef.current.length });
          } else if (task.status === "failed") {
            setError(task.error ?? "Acquire failed");
          }
        }
      } catch (e) {
        console.error(`[shot-review] poll failed: ${(e as Error).message}`);
      }
    }, 800);
  }
  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  useEffect(() => () => { stopTimer(); stopPolling(); stopTaskPolling(); }, [stopTaskPolling]);

  // If a shot-acquire task is already active for this shot on mount, resume
  // polling it (tasks carry their shotId so we can find ours in the registry).
  useEffect(() => {
    api.tasks().then(({ tasks }) => {
      const t = tasks.find((x) =>
        x.kind === "shot" && x.shotId === shotId &&
        (x.status === "queued" || x.status === "running" || x.status === "paused"));
      if (t) {
        acquireTaskIdRef.current = t.id;
        setBusy(true);
        setAcquirePaused(t.status === "paused");
        startTimer();
        startPolling();
      }
    }).catch(() => {});
    // Same for kept-clip download tasks started earlier.
    pollTasksOnce()
      .then((active) => { if (active) startTaskPolling(); })
      .catch(() => {});
  }, [shotId, pollTasksOnce, startTaskPolling]);

  async function runAcquire() {
    setError(null);
    setDone(null);
    setBusy(true);
    startTimer();
    try {
      // Don't start a second task when one is already active for this shot —
      // mirror the old alreadyRunning response by attaching to the live task.
      const { tasks } = await api.tasks();
      const existing = tasks.find((x) =>
        x.kind === "shot" && x.shotId === shotId &&
        (x.status === "queued" || x.status === "running" || x.status === "paused"));
      if (existing) {
        acquireTaskIdRef.current = existing.id;
        setError("Acquisition is already running.");
      } else {
        const { task } = await api.startAcquireShotTask(shotId);
        acquireTaskIdRef.current = task.id;
      }
      startPolling();
    } catch (e) {
      setError(`Acquire failed: ${(e as Error).message}`);
      setBusy(false);
      stopTimer();
    }
  }

  async function stopAcquire() {
    const taskId = acquireTaskIdRef.current;
    if (!taskId) return;
    try {
      await api.cancelTask(taskId);
    } catch (e) {
      setError(`Stop failed: ${(e as Error).message}`);
    }
  }

  async function toggleAcquirePause() {
    const taskId = acquireTaskIdRef.current;
    if (!taskId) return;
    try {
      if (acquirePaused) {
        await api.resumeTask(taskId);
        setAcquirePaused(false);
      } else {
        await api.pauseTask(taskId);
        setAcquirePaused(true);
      }
    } catch { /* next poll reflects the real state */ }
  }

  /** Returns true when the review action was applied — the route answers 200
   *  even for a refused action ({ ok:false, reason }), so callers (and the
   *  optimistic SELECTED state) need the body's `ok` flag, not just HTTP. */
  async function review(assetId: string, action: string): Promise<boolean> {
    try {
      const r = await api.review(shotId, assetId, { action });
      if (!r.ok) {
        setError(`Review failed: ${r.reason ?? r.status}`);
        return false;
      }
      // SELECT (KEEP action) on a non-downloaded candidate starts a download
      // task server-side.
      if (action === "KEEP") startTaskPolling();
      await load();
      return true;
    } catch (e) {
      setError(`Review failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** "ADD TO TIMELINE" — flag the candidate onto this shot's rail on the
   *  Timeline page. Optimistic; the flag only controls rail visibility. */
  async function toggleRail(assetId: string, on: boolean) {
    setOnRail((s) => {
      const m = new Set(s);
      if (on) m.add(assetId); else m.delete(assetId);
      return m;
    });
    try {
      await api.setAssetOnRail(shotId, assetId, on);
    } catch (e) {
      setError(`Add to timeline failed: ${(e as Error).message}`);
      await load();
    }
  }

  /** SELECT every candidate that isn't already downloaded or rejected — each
   *  SELECT starts its own pausable/cancellable download task. */
  async function keepAll() {
    const targets = assets.filter((a) => !a.local_path && a.commercial_status !== "REJECTED");
    if (targets.length === 0) return;
    setKeepingAll(true);
    setError(null);
    try {
      for (const a of targets) {
        try {
          await api.review(shotId, a.id, { action: "KEEP" });
        } catch { /* per-asset failures show via task/card state */ }
      }
      startTaskPolling();
      await load();
    } finally {
      setKeepingAll(false);
    }
  }

  async function taskAction(taskId: string, action: "pause" | "resume" | "cancel") {
    try {
      if (action === "pause") await api.pauseTask(taskId);
      else if (action === "resume") await api.resumeTask(taskId);
      else await api.cancelTask(taskId);
      await pollTasksOnce();
    } catch (e) {
      setError(`Task ${action} failed: ${(e as Error).message}`);
    }
  }

  async function setRating(assetId: string, prev: number | null, next: number | null) {
    if (next === prev) return;
    // Optimistic update.
    setRatingOverrides((prevMap) => {
      const m = new Map(prevMap);
      m.set(assetId, next);
      return m;
    });
    try {
      await api.setAssetRating(assetId, next);
    } catch (e) {
      // Revert on failure.
      setRatingOverrides((prevMap) => {
        const m = new Map(prevMap);
        m.set(assetId, prev);
        return m;
      });
      console.error(`[shot-review] set rating failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-sky-400 hover:text-sky-300 flex items-center gap-1 transition-colors">
        ← Back to timeline
      </button>
      {shot && (
        <div className="ui-card p-5">
          <div className="flex justify-between items-start">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs text-sky-400">{shot.id}</span>
                <Badge tone="info">{shot.section}</Badge>
              </div>
              <div className="text-lg font-semibold text-slate-100">{shot.visual_description}</div>
              <div className="text-xs text-slate-400 mt-1">Query: {shot.search_query}</div>
              <div className="text-xs text-slate-500 font-mono mt-0.5">Collector/{sectionFolder(shot.section)}</div>
            </div>
            <div className="flex gap-2 shrink-0 flex-wrap justify-end">
              <Button variant="primary" onClick={runAcquire} disabled={busy}>
                {busy ? `${acquirePaused ? "Paused" : "Acquiring…"} ${elapsed}s` : "↓ Acquire candidates"}
              </Button>
              {busy && (
                <>
                  <Button variant="secondary" onClick={toggleAcquirePause}>
                    {acquirePaused ? "▶ Resume" : "⏸ Pause"}
                  </Button>
                  <Button variant="danger" onClick={stopAcquire}>■ Stop</Button>
                </>
              )}
              {!busy && assets.some((a) => !a.local_path && a.commercial_status !== "REJECTED") && (
                <Button variant="secondary" onClick={keepAll} disabled={keepingAll}>
                  {keepingAll ? "Selecting…" : "✓ Select all"}
                </Button>
              )}
            </div>
          </div>
          <TimelinePositionPanel shot={shot} onSaved={load} />
          <AcquireSettingsPanel shot={shot} onSaved={load} />
          <AssetSearchPanel shotId={shot.id} projectId={shot.project_id} onAdded={load} />
          {busy && (
            <div className="mt-3 text-xs text-sky-400 animate-pulse-soft">
              {acquirePaused
                ? "Paused — press Resume to continue."
                : "Searching providers and ranking candidates — nothing is downloaded until you SELECT a clip."}
            </div>
          )}
          {done && !busy && (
            <div className="mt-3 text-xs text-emerald-400 bg-emerald-950/40 rounded-lg p-2 border border-emerald-800/40">
              ✓ Acquire complete — {done.candidatesFound} candidates found. SELECT the clips you want to download them.
            </div>
          )}
          {error && (
            <div className="mt-3 text-xs text-rose-400 bg-rose-950/40 rounded-lg p-2 border border-rose-800/40">{error}</div>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {assets.map((a) => {
          const t = tasksByAsset.get(a.id) ?? null;
          return (
            <AssetCard
              key={a.id}
              asset={a}
              onReview={review}
              onRail={onRail.has(a.id)}
              onToggleRail={() => toggleRail(a.id, !onRail.has(a.id))}
              linkSelected={selectedLinks.has(a.id)}
              downloadingAsset={
                currentAsset?.assetId === a.id ? currentAsset
                : t ? { assetId: a.id, assetName: a.id, receivedBytes: t.progress?.receivedBytes ?? 0, totalBytes: t.progress?.totalBytes ?? 0, pct: t.progress?.pct ?? 0 }
                : null
              }
              task={t}
              onTaskAction={taskAction}
              rating={ratingOverrides.has(a.id) ? ratingOverrides.get(a.id) ?? null : a.rating ?? null}
              onSetRating={(next) => setRating(a.id, a.rating ?? null, next)}
            />
          );
        })}
        {assets.length === 0 && !busy && <EmptyState icon="◇" title="No candidates yet" description='Click "Acquire candidates" to search for assets for this shot.' />}
        {assets.length === 0 && busy && <EmptyState icon="↓" title="Waiting for candidates…" description="Searching providers and ranking matches — nothing downloads until you SELECT a clip." />}
      </div>
    </div>
  );
}

/**
 * Timeline membership + absolute time-range editor. Lets the user assign this
 * shot to a timeline and set its time_start / time_end (seconds from timeline
 * 0). Shows the resulting length (end - start). Empty inputs clear the values.
 */
function TimelinePositionPanel({ shot, onSaved }: { shot: Shot; onSaved: () => Promise<void> }) {
  const [timelines, setTimelines] = useState<Timeline[]>([]);
  const [tlId, setTlId] = useState<string>(shot.timeline_id ?? "");
  const [start, setStart] = useState<string>(shot.time_start_seconds == null ? "" : String(shot.time_start_seconds));
  const [end, setEnd] = useState<string>(shot.time_end_seconds == null ? "" : String(shot.time_end_seconds));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.timelines(shot.project_id).then((r) => setTimelines(r.timelines)).catch(() => {});
  }, [shot.project_id]);
  useEffect(() => {
    setTlId(shot.timeline_id ?? "");
    setStart(shot.time_start_seconds == null ? "" : String(shot.time_start_seconds));
    setEnd(shot.time_end_seconds == null ? "" : String(shot.time_end_seconds));
  }, [shot.id, shot.timeline_id, shot.time_start_seconds, shot.time_end_seconds]);

  const startNum = start.trim() === "" ? null : Number(start);
  const endNum = end.trim() === "" ? null : Number(end);
  const length = startNum != null && endNum != null ? endNum - startNum : null;

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const timelineId = tlId === "" ? null : tlId;
      const s = startNum;
      const e = endNum;
      if (s != null && e != null && e < s) {
        setErr("End must be ≥ start.");
        setSaving(false);
        return;
      }
      await api.updateShot(shot.id, { timelineId, timeStart: s, timeEnd: e });
      await onSaved();
    } catch (e2) {
      setErr(`Save failed: ${(e2 as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-700">
      <div className="text-xs text-slate-400 mb-2">Timeline position</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-400">
          <span>Timeline</span>
          <select
            value={tlId}
            onChange={(e) => setTlId(e.target.value)}
            className="mt-1 bg-input border border-slate-700 rounded px-2 py-1 text-slate-100 text-sm"
          >
            <option value="">— none —</option>
            {timelines.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-400">
          <span>Start (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            placeholder="0"
            className="mt-1 w-24 bg-input border border-slate-700 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-400">
          <span>End (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            placeholder="0"
            className="mt-1 w-24 bg-input border border-slate-700 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </label>
        <span className="text-xs text-emerald-400 pb-1">
          length {length != null ? `${length.toFixed(1)}s` : "—"}
        </span>
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-sm"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {err && <span className="text-xs text-rose-400">{err}</span>}
      </div>
    </div>
  );
}

/**
 * Search the discovered/downloaded asset pool by free text (title/tags/
 * creator/provider) and add results to this shot. Added assets appear in the
 * shot's candidate list above (they're linked via shot_assets).
 */
function AssetSearchPanel({ shotId, projectId, onAdded }: { shotId: string; projectId: string; onAdded: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Asset[]>([]);
  const [searching, setSearching] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  async function runSearch() {
    if (q.trim() === "") { setResults([]); return; }
    setSearching(true);
    setErr(null);
    try {
      const r = await api.searchAssets(q, projectId);
      setResults(r.assets);
    } catch (e) {
      setErr(`Search failed: ${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  }

  async function add(assetId: string) {
    try {
      await api.addAssetToShot(shotId, assetId);
      setAdded((prev) => new Set(prev).add(assetId));
      await onAdded();
    } catch (e) {
      setErr(`Add failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-700">
      <div className="text-xs text-slate-400 mb-2">
        Search existing asset pool and add to this shot
      </div>
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="title, tag, creator, provider…"
          className="flex-1 bg-input border border-slate-700 rounded px-2 py-1 text-sm"
        />
        <button onClick={runSearch} disabled={searching} className="px-3 py-1 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-sm">
          {searching ? "…" : "Search"}
        </button>
      </div>
      {err && <div className="text-xs text-rose-400 mt-1">{err}</div>}
      {results.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto text-xs space-y-1">
          {results.map((a) => (
            <li key={a.id} className="flex items-center gap-2 bg-slate-900/60 rounded px-2 py-1">
              <span className="font-mono text-sky-400 truncate flex-1">{a.id}</span>
              <span className="text-slate-400 truncate flex-1">{a.title ?? a.creator_name ?? a.provider_id}</span>
              <span className="text-slate-500">{a.width}×{a.height}</span>
              {added.has(a.id) ? (
                <span className="text-emerald-400">added</span>
              ) : (
                <button onClick={() => add(a.id)} className="px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white">
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {q.trim() !== "" && results.length === 0 && !searching && (
        <p className="text-xs text-slate-500 mt-1">No matching assets in the pool.</p>
      )}
    </div>
  );
}

/**
 * Per-shot acquisition priority settings (X / Y / Z).
 *   X = minimum candidates to fetch (search expands until >= X)
 *   Y = acquire count (max candidates to download)
 *   Z = minimum rating (finalScore 0..1) required to be acquired
 * Empty inputs clear the override (NULL) so the pipeline uses the shared
 * defaults (shown as placeholders).
 */
function AcquireSettingsPanel({ shot, onSaved }: { shot: Shot; onSaved: () => Promise<void> }) {
  // Local editable values. Empty string = clear override (use default).
  const [x, setX] = useState<string>(shot.min_candidates == null ? "" : String(shot.min_candidates));
  const [y, setY] = useState<string>(shot.acquire_count == null ? "" : String(shot.acquire_count));
  const [z, setZ] = useState<string>(shot.min_acquire_rating == null ? "" : String(shot.min_acquire_rating));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Re-sync when the shot id changes or the server value updates after a save.
  useEffect(() => {
    setX(shot.min_candidates == null ? "" : String(shot.min_candidates));
    setY(shot.acquire_count == null ? "" : String(shot.acquire_count));
    setZ(shot.min_acquire_rating == null ? "" : String(shot.min_acquire_rating));
  }, [shot.id, shot.min_candidates, shot.acquire_count, shot.min_acquire_rating]);

  function parseOrNull(v: string): number | null {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.updateShotSettings(shot.id, {
        minCandidates: parseOrNull(x),
        acquireCount: parseOrNull(y),
        minAcquireRating: parseOrNull(z),
      });
      setSavedAt(Date.now());
      await onSaved();
    } catch (e) {
      setErr(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-700">
      <div className="text-xs text-slate-400 mb-2">
        Acquisition priority — <span className="text-sky-400">fetch min X candidates</span>. Y/Z apply only to legacy
        bulk-download mode — clips now download when you SELECT them. Leave blank to use defaults.
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-400">
          <span>Min candidates (X)</span>
          <input
            type="number"
            min={1}
            max={60}
            value={x}
            onChange={(e) => setX(e.target.value)}
            placeholder={`default ${MIN_CANDIDATES_PER_SHOT_DEFAULT}`}
            className="mt-1 w-32 bg-input border border-slate-700 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-400">
          <span>Acquire count (Y)</span>
          <input
            type="number"
            min={1}
            max={20}
            value={y}
            onChange={(e) => setY(e.target.value)}
            placeholder={`default ${ACQUIRE_COUNT_DEFAULT}`}
            className="mt-1 w-28 bg-input border border-slate-700 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-400">
          <span>Min rating (Z, 0–1)</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={z}
            onChange={(e) => setZ(e.target.value)}
            placeholder={`default ${MIN_ACQUIRE_RATING_DEFAULT}`}
            className="mt-1 w-28 bg-input border border-slate-700 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </label>
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-sm"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && !err && (
          <span className="text-xs text-emerald-400">saved</span>
        )}
        {err && <span className="text-xs text-rose-400">{err}</span>}
      </div>
    </div>
  );
}

function AssetCard({
  asset,
  onReview,
  onRail,
  onToggleRail,
  linkSelected,
  downloadingAsset,
  task,
  onTaskAction,
  rating,
  onSetRating,
}: {
  asset: Asset;
  onReview: (id: string, action: string) => Promise<boolean>;
  onRail: boolean;
  onToggleRail: () => void;
  linkSelected: boolean;
  downloadingAsset: AssetDownloadProgress | null;
  task: { taskId: string; status: TaskStatus; progress: Task["progress"] } | null;
  onTaskAction: (taskId: string, action: "pause" | "resume" | "cancel") => void;
  rating: number | null;
  onSetRating: (next: number | null) => void;
}) {
  const score = asset.final_score != null ? Math.round(asset.final_score * 100) : "—";
  const downloaded = !!asset.local_path;
  // SELECTED state = approved + carries the shot's selected link flag
  // (exclusive — another pick clears it). Optimistic on click so the button
  // flips immediately; re-synced on every reload and reverted when the
  // review action is refused (e.g. license status blocks approval).
  const isSelected = asset.commercial_status === "APPROVED_FOR_EDIT" && linkSelected;
  const [selected, setSelected] = useState(isSelected);
  useEffect(() => {
    setSelected(isSelected);
  }, [isSelected]);
  // Decision state defaults to SELECT unless the asset was already rejected.
  const [keep, setKeep] = useState(asset.commercial_status !== "REJECTED");
  useEffect(() => {
    setKeep(asset.commercial_status !== "REJECTED");
  }, [asset.commercial_status]);

  // Each button sets its own state — clicking SELECT means select, clicking
  // REJECT means reject. SELECT still fires when the candidate is merely
  // "not rejected" (the visual default): it must reach the server to mark it
  // APPROVED_FOR_EDIT and start the download task.
  async function chooseKeep() {
    if (keep && selected) return;
    setKeep(true);
    setSelected(true);
    if (!(await onReview(asset.id, "KEEP"))) setSelected(false);
  }
  function chooseReject() {
    if (!keep) return;
    setKeep(false);
    setSelected(false);
    onReview(asset.id, "REJECT");
  }

  const pct = downloadingAsset?.pct ?? 0;

  return (
    <div className={`ui-card overflow-hidden ${selected ? "ring-1 ring-emerald-500/60" : ""}`}>
      {/* inset ring = the "video frame highlighted" state for a SELECTed clip;
          sits inside the box so the card's overflow-hidden can't clip it */}
      <div className={`aspect-video bg-black flex items-center justify-center relative ${selected ? "ring-2 ring-inset ring-emerald-400/80" : ""}`}>
        {downloaded ? (
          <VideoPlayer assetId={asset.id} />
        ) : task && (task.status === "queued" || task.status === "running" || task.status === "paused") ? (
          <div className="w-full px-4">
            <div className="flex justify-between text-xs text-sky-300 mb-1">
              <span className="font-mono truncate">{downloadingAsset?.assetName ?? asset.id}</span>
              <span className="ml-2 whitespace-nowrap">
                {task.status === "paused" ? "paused" : task.status === "queued" ? "queued" : `${pct}%`}
              </span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
              <div className={`h-full transition-all ${task.status === "paused" ? "bg-amber-500" : "bg-sky-500"}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-slate-500 mt-1 text-center">
              {downloadingAsset && downloadingAsset.totalBytes > 0
                ? `${(downloadingAsset.receivedBytes / 1024 / 1024).toFixed(1)} / ${(downloadingAsset.totalBytes / 1024 / 1024).toFixed(1)} MB`
                : downloadingAsset && downloadingAsset.receivedBytes > 0
                  ? `${(downloadingAsset.receivedBytes / 1024 / 1024).toFixed(1)} MB`
                  : "waiting…"}
            </div>
            <div className="flex gap-1.5 justify-center mt-1.5">
              <button
                onClick={() => onTaskAction(task.taskId, task.status === "paused" ? "resume" : "pause")}
                className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-200"
              >
                {task.status === "paused" ? "▶ Resume" : "⏸ Pause"}
              </button>
              <button
                onClick={() => onTaskAction(task.taskId, "cancel")}
                className="px-2 py-0.5 rounded bg-rose-800 hover:bg-rose-700 text-xs text-white"
              >
                ✕ Cancel
              </button>
            </div>
          </div>
        ) : asset.download_url ? (
          /* Not downloaded yet — stream the provider-hosted file for preview.
             SELECT downloads a local copy. */
          <div className="relative w-full h-full">
            <video
              src={asset.download_url}
              poster={asset.thumbnail_url ?? undefined}
              controls
              playsInline
              preload="none"
              className="w-full h-full object-contain bg-black"
            />
            <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-amber-300 pointer-events-none">
              preview — SELECT to download
            </span>
          </div>
        ) : asset.thumbnail_url ? (
          <div className="relative w-full h-full">
            <img src={asset.thumbnail_url} alt="" className="w-full h-full object-contain bg-black" />
            <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-amber-300 pointer-events-none">
              preview — SELECT to download
            </span>
          </div>
        ) : (
          <span className="text-slate-600 text-xs">not downloaded</span>
        )}
      </div>
      <div className="px-3 py-2 border-t border-slate-700 bg-slate-900/50">
        <RatingSlider value={rating} onChange={onSetRating} />
      </div>
      <div className="p-3 space-y-1">
        <div className="flex justify-between text-xs">
          <span className="font-mono text-sky-400">{asset.id}</span>
          <span className="font-bold">{score}</span>
        </div>
        <div className="text-xs text-slate-400">
          {asset.width}×{asset.height} · {asset.duration_seconds?.toFixed(1)}s · {asset.provider_id}
        </div>
        <div className="text-xs">
          License: <LicenseBadge status={asset.commercial_status} />
          {asset.duplicate_flag && asset.duplicate_flag !== "NONE" && <span className="ml-2 text-rose-400">dup:{asset.duplicate_flag}</span>}
        </div>
        <div className="text-xs text-slate-400">
          {asset.creator_name} · <a href={asset.provider_url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">source</a> · <a href={asset.license_url ?? "#"} target="_blank" rel="noreferrer" className="text-slate-400 hover:underline">license</a>
        </div>
        {asset.title && (
          <div className="text-xs text-slate-300 italic">"{asset.title}"</div>
        )}
        <TagsRow tagsJson={asset.tags} />
        <MoreInfo asset={asset} />
        {downloaded && asset.folder && (
          <div className="text-xs text-slate-500 pt-1 break-all">
            <span className="text-slate-400">Folder:</span>{" "}
            <span className="font-mono text-sky-400">{asset.folder}</span>
            {asset.folder_section && <span className="text-slate-500"> ({asset.folder_section})</span>}
            <div className="font-mono text-slate-500 mt-0.5">{asset.absolute_path}</div>
            <button
              onClick={() => api.revealAsset(asset.id).catch(console.error)}
              className="mt-1 px-2 py-0.5 rounded bg-sky-700 hover:bg-sky-600 text-xs text-white"
              title="Show this file in File Explorer"
            >
              File Explorer
            </button>
          </div>
        )}
        {task && (task.status === "failed" || task.status === "cancelled") && !downloaded && (
          <div className="text-[11px] text-rose-400 pt-1">
            download {task.status} — SELECT to retry
          </div>
        )}
        {/* Review actions work on undownloaded candidates too — SELECT is what
            triggers the download task. */}
        {(
          <div className="flex gap-1 pt-2 flex-wrap items-center">
            <button
              onClick={chooseKeep}
              className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                selected
                  ? "bg-emerald-600 text-white hover:bg-emerald-500"
                  : "bg-slate-700 text-slate-400 hover:bg-slate-600"
              }`}
              aria-pressed={selected}
              title="Approve + download — shows as SELECTED on the timeline rail"
            >
              {selected ? "✓ SELECTED" : "SELECT"}
            </button>
            <button
              onClick={onToggleRail}
              className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                onRail
                  ? "bg-sky-700 text-white hover:bg-sky-600"
                  : "bg-slate-700 text-slate-400 hover:bg-slate-600"
              }`}
              aria-pressed={onRail}
              title="Show on this shot's rail on the 3D timeline page (even past the rail limit)"
            >
              {onRail ? "✓ ON TIMELINE" : "ADD TO TIMELINE"}
            </button>
            <button
              onClick={chooseReject}
              className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                !keep
                  ? "bg-rose-600 text-white hover:bg-rose-500"
                  : "bg-slate-700 text-slate-400 hover:bg-slate-600"
              }`}
              aria-pressed={!keep}
            >
              REJECT
            </button>
            <button
              onClick={() => onReview(asset.id, "REVIEW_RIGHTS")}
              className="px-2 py-1 rounded bg-amber-700 hover:bg-amber-600 text-xs"
            >
              REVIEW RIGHTS
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Parse the JSON-encoded tags string from the asset row. Defensive against
 * malformed/missing JSON. */
function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const v = JSON.parse(tagsJson);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string" && t) : [];
  } catch {
    return [];
  }
}

/** Render the provider-supplied tags as chips. Hidden entirely when there are
 * no tags (e.g. a provider returned none). */
function TagsRow({ tagsJson }: { tagsJson: string | null }) {
  const tags = parseTags(tagsJson);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {tags.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 border border-slate-600"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

/** Collapsible "More info" panel showing the sub-scores and metadata that are
 * on the asset row but not surfaced in the compact card header. Only rows that
 * actually have a value are rendered, so the panel stays compact for sparse
 * assets. */
function MoreInfo({ asset }: { asset: Asset }) {
  const [open, setOpen] = useState(false);

  const pct = (v: number | null): string => (v == null ? "—" : `${Math.round(v * 100)}`);
  const rows: Array<{ label: string; value: string | number | null }> = [
    { label: "Provider asset ID", value: asset.provider_asset_id },
    { label: "FPS", value: asset.fps },
    { label: "Orientation", value: asset.orientation },
    { label: "Aspect flag", value: asset.aspect_flag },
    { label: "Rights review", value: asset.rights_review_status },
    { label: "Relevance score", value: pct(asset.ai_relevance_score) },
    { label: "Technical score", value: pct(asset.technical_score) },
    { label: "Duplicate score", value: asset.duplicate_score == null ? "—" : asset.duplicate_score },
    { label: "Diversity penalty", value: asset.diversity_penalty_applied ? "yes" : "no" },
    { label: "Discovered", value: asset.discovered_at ? new Date(asset.discovered_at).toLocaleString() : null },
    { label: "Downloaded", value: asset.downloaded_at ? new Date(asset.downloaded_at).toLocaleString() : null },
    { label: "Notes", value: asset.notes },
  ];
  const present = rows.filter((r) => r.value != null && r.value !== "" && r.value !== "—");

  if (present.length === 0) return null;
  return (
    <div className="pt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-slate-500 hover:text-sky-400 transition-colors"
      >
        {open ? "▾ hide info" : "▸ more info"}
      </button>
      {open && (
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] bg-slate-900/60 rounded p-2 border border-slate-700">
          {present.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-slate-500">{r.label}</dt>
              <dd className="text-slate-300 font-mono break-all">{String(r.value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function LicenseBadge({ status }: { status: string | null }) {
  const s = status ?? "";
  const color = s === "APPROVED_FOR_EDIT" ? "text-emerald-400" : s === "LICENSE_SOURCE_CONFIRMED" ? "text-sky-400" : s === "HUMAN_REVIEW_REQUIRED" ? "text-amber-400" : s === "REJECTED" ? "text-rose-400" : "text-slate-400";
  return <span className={color}>{s}</span>;
}

/**
 * Inline video player for a downloaded asset. Shows the thumbnail as the
 * poster; native controls handle play/pause/seek/volume. A dedicated
 * fullscreen button uses the Fullscreen API on the container so the video
 * fills the screen (browser native fullscreen control also works).
 */
function VideoPlayer({ assetId }: { assetId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await el.requestFullscreen().catch(() => {});
    }
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black group">
      <video
        ref={videoRef}
        src={api.assetFileUrl(assetId)}
        poster={api.assetThumbUrl(assetId)}
        controls
        playsInline
        preload="metadata"
        className="w-full h-full object-contain bg-black"
      />
      <button
        onClick={toggleFullscreen}
        className="absolute top-2 right-2 px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
      >
        {isFullscreen ? "⤢ Exit" : "⤢ Fullscreen"}
      </button>
    </div>
  );
}
