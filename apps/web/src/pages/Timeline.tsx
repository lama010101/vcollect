import { useEffect, useState, useCallback, useRef } from "react";
import type { VizSessionMeta } from "@twio/shared";
import { api, type Shot, type TaskStatus, type Timeline, type TimelineCandidate, type TimelineFetchProgress } from "../api.js";
import { Button, Badge, EmptyState, Tray, Modal } from "../components/ui.js";

/**
 * Timeline page — replaces the old "Shots" tab.
 *
 * Left: list of user-created timelines (create / rename / delete).
 * Right: a horizontal bar timeline for the selected timeline. Each shot is a
 * segment positioned at its absolute time_start..time_end (seconds from 0).
 * Segments are labeled with start / end / length. Clicking a segment opens the
 * shot review page.
 *
 * Shots with no time range set are listed below the bar in an "unscheduled"
 * section so they're still reachable.
 *
 * Both columns collapse into vertical trays (persisted), and the selected
 * timeline is remembered per project across refreshes.
 */
const TRAYS_STORAGE_KEY = "twio.timeline.trays";

export function TimelinePage({ onOpenShot, projectId }: { onOpenShot: (id: string) => void; projectId: string }) {
  const [timelines, setTimelines] = useState<Timeline[]>([]);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [showScript, setShowScript] = useState(false);
  // "Fetch video" — runs candidate discovery for every shot of the selected
  // timeline (search + persist, no downloads; SELECT downloads on demand).
  const [maxFetch, setMaxFetch] = useState(5);
  const [fetchProg, setFetchProg] = useState<TimelineFetchProgress | null>(null);
  const [keepBusy, setKeepBusy] = useState<string | null>(null);
  // Most recently SELECTed candidate per shot — pins that clip to the front
  // of its rail (a shot can have several selected candidates; latest wins).
  const [firstSelected, setFirstSelected] = useState<Map<string, string>>(new Map());
  // Rail video size multiplier (1–5×), persisted across sessions.
  const [railScale, setRailScale] = useState<number>(() => {
    const v = Number(localStorage.getItem("twio.timeline.railScale"));
    return v >= 1 && v <= 5 ? v : 1;
  });
  useEffect(() => {
    localStorage.setItem("twio.timeline.railScale", String(railScale));
  }, [railScale]);
  // Shot highlighted in the timeline bar — set by clicking a row in the shot
  // list; shared because bar and list live in separate windows now.
  const [selShotId, setSelShotId] = useState<string | null>(null);
  useEffect(() => { setSelShotId(null); }, [selectedId]);
  // Fullscreen playback queue — the first-on-rail video of each shot, in
  // timeline order. Null = player closed.
  const [playQueue, setPlayQueue] = useState<{ shotId: string; assetId: string; src: string; duration: number | undefined }[] | null>(null);
  const [playIndex, setPlayIndex] = useState(0);
  // Download-task status per candidate asset id (kept clips downloading).
  const [dlTasks, setDlTasks] = useState<Map<string, TaskStatus>>(new Map());
  // "Load Visualizer session" — builds a timeline whose shots are the
  // session's layer stack + stems.
  const [vizSessions, setVizSessions] = useState<VizSessionMeta[]>([]);
  const [vizSel, setVizSel] = useState("");
  const [vizLoading, setVizLoading] = useState(false);
  const fetchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const taskPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shotsRef = useRef<Shot[]>([]);
  const finishedTasksRef = useRef<Set<string>>(new Set());
  // Column collapse state — each column folds into a vertical tray.
  const [trays, setTrays] = useState<{ list: boolean; view: boolean }>(() => {
    try {
      return { list: false, view: false, ...JSON.parse(localStorage.getItem(TRAYS_STORAGE_KEY) ?? "{}") };
    } catch {
      return { list: false, view: false };
    }
  });

  useEffect(() => {
    localStorage.setItem(TRAYS_STORAGE_KEY, JSON.stringify(trays));
  }, [trays]);

  // Reset project-scoped state when the project changes (render-time
  // adjustment — clears stale data before effects can persist it under the
  // new project's storage key).
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (prevProjectId !== projectId) {
    setPrevProjectId(projectId);
    setTimelines([]);
    setShots([]);
    setSelectedId(null);
    setFirstSelected(new Map());
    setSelShotId(null);
    setVizSessions([]);
    setVizSel("");
  }

  const loadTimelines = useCallback(async () => {
    try {
      const r = await api.timelines(projectId);
      setTimelines(r.timelines);
      setUnassignedCount(r.unassignedShotCount);
      // Resolve the selection: keep the current one if still valid; else this
      // project's remembered timeline (survives refresh); else the first.
      setSelectedId((cur) => {
        const valid = (id: string | null) => id != null && r.timelines.some((t) => t.id === id);
        if (valid(cur)) return cur;
        const stored = localStorage.getItem(`twio.selectedTimeline.${projectId}`);
        if (valid(stored)) return stored;
        return r.timelines[0]?.id ?? null;
      });
    } catch (e) {
      setError(`Failed to load timelines: ${(e as Error).message}`);
    }
  }, [projectId]);

  // Remember the selected timeline per project so a refresh restores it.
  useEffect(() => {
    if (selectedId) localStorage.setItem(`twio.selectedTimeline.${projectId}`, selectedId);
  }, [selectedId, projectId]);

  // The visualizer-session picker — refetch on mount + project switch.
  useEffect(() => {
    let live = true;
    api
      .vizSessions(projectId)
      .then((r) => {
        if (!live) return;
        setVizSessions(r.sessions);
        setVizSel((cur) => (r.sessions.some((s) => s.id === cur) ? cur : (r.sessions[0]?.id ?? "")));
      })
      .catch(() => {}); // sessions are optional — keep the picker empty
    return () => {
      live = false;
    };
  }, [projectId]);

  /** Builds a real timeline from the chosen visualizer session — one shot
   *  per layer-stack row (top→bottom) plus one per stem — then selects it. */
  async function loadVizSession() {
    if (!vizSel) return;
    setVizLoading(true);
    try {
      const r = await api.vizSessionToTimeline(projectId, vizSel);
      await loadTimelines();
      setSelectedId(r.timelineId);
    } catch (e) {
      setError(`4D timeline session failed: ${(e as Error).message}`);
    } finally {
      setVizLoading(false);
    }
  }

  const loadShots = useCallback(async () => {
    if (!selectedId) { setShots([]); return; }
    setLoading(true);
    try {
      const r = await api.timelineShots(selectedId, projectId);
      setShots(r.shots);
      shotsRef.current = r.shots;
    } catch (e) {
      setError(`Failed to load shots: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedId, projectId]);

  // --- fetch-videos + kept-download polling ----------------------------------

  /** One tasks tick: map download tasks onto this timeline's candidate ids;
   *  reload shots when a kept clip finishes (it gains a local file). */
  const pollTasksOnce = useCallback(async (): Promise<boolean> => {
    const { tasks } = await api.tasks();
    const ids = new Set(shotsRef.current.flatMap((s) => (s.candidates ?? []).map((c) => c.id)));
    const map = new Map<string, TaskStatus>();
    let active = false;
    let newFinished = false;
    for (const t of tasks) {
      for (const it of t.items) {
        if (!ids.has(it.id)) continue;
        map.set(it.id, it.status);
        if (it.status === "queued" || it.status === "running" || it.status === "paused") {
          active = true;
        } else if (!finishedTasksRef.current.has(`${t.id}:${it.id}`)) {
          finishedTasksRef.current.add(`${t.id}:${it.id}`);
          newFinished = true;
        }
      }
    }
    setDlTasks(map);
    if (newFinished) await loadShots();
    return active;
  }, [loadShots]);

  const stopTaskPolling = useCallback(() => {
    if (taskPollRef.current) { clearInterval(taskPollRef.current); taskPollRef.current = null; }
  }, []);

  const startTaskPolling = useCallback(() => {
    if (taskPollRef.current) return;
    taskPollRef.current = setInterval(async () => {
      try {
        if (!(await pollTasksOnce())) stopTaskPolling();
      } catch { /* transient — keep polling */ }
    }, 900);
  }, [pollTasksOnce, stopTaskPolling]);

  const stopFetchPolling = useCallback(() => {
    if (fetchPollRef.current) { clearInterval(fetchPollRef.current); fetchPollRef.current = null; }
  }, []);

  const startFetchPolling = useCallback((tlId: string) => {
    if (fetchPollRef.current) return;
    fetchPollRef.current = setInterval(async () => {
      try {
        const p = await api.fetchTimelineProgress(tlId, projectId);
        setFetchProg(p);
        if (!p.running) {
          stopFetchPolling();
          await loadShots();
        }
      } catch { /* transient */ }
    }, 1000);
  }, [loadShots, stopFetchPolling, projectId]);

  // Resume polling on mount / timeline switch when a fetch is in flight.
  useEffect(() => {
    if (!selectedId) return;
    api.fetchTimelineProgress(selectedId, projectId)
      .then((p) => { setFetchProg(p); if (p.running && p.timelineId === selectedId) startFetchPolling(selectedId); })
      .catch(() => {});
    return () => { stopFetchPolling(); stopTaskPolling(); };
  }, [selectedId, projectId, startFetchPolling, stopFetchPolling, stopTaskPolling]);

  async function startFetch() {
    if (!selectedId) return;
    setError(null);
    try {
      const r = await api.fetchTimelineVideos(selectedId, maxFetch, projectId);
      if (r.alreadyRunning) {
        setError("A fetch is already running — it appears above and can be stopped.");
      }
      startFetchPolling(selectedId);
      const p = await api.fetchTimelineProgress(selectedId, projectId);
      setFetchProg(p);
    } catch (e) {
      setError(`Fetch failed: ${(e as Error).message}`);
    }
  }

  async function keepCandidate(shotId: string, assetId: string) {
    setKeepBusy(assetId);
    try {
      // SELECT sends the KEEP review action: the candidate is marked
      // selected+approved and its download task starts server-side; the rail
      // updates when the file lands. The route answers 200 even when the
      // action is refused — check `ok` before pinning it first.
      const r = await api.review(shotId, assetId, { action: "KEEP" });
      if (!r.ok) {
        setError(`Select failed: ${r.reason ?? r.status}`);
        return;
      }
      setFirstSelected((m) => new Map(m).set(shotId, assetId));
      startTaskPolling();
      await loadShots();
    } catch (e) {
      setError(`Select failed: ${(e as Error).message}`);
    } finally {
      setKeepBusy(null);
    }
  }

  useEffect(() => { loadTimelines(); }, [loadTimelines]);
  useEffect(() => { loadShots(); }, [loadShots]);

  async function createTimeline() {
    const name = newName.trim();
    if (!name) return;
    try {
      const r = await api.createTimeline(name, projectId);
      setNewName("");
      await loadTimelines();
      setSelectedId(r.timeline.id);
    } catch (e) {
      setError(`Create failed: ${(e as Error).message}`);
    }
  }

  async function renameTimeline(t: Timeline) {
    const name = prompt("Rename timeline", t.name);
    if (name == null || name.trim() === t.name) return;
    try {
      await api.renameTimeline(t.id, name.trim(), projectId);
      await loadTimelines();
    } catch (e) {
      setError(`Rename failed: ${(e as Error).message}`);
    }
  }

  async function deleteTimeline(t: Timeline) {
    if (!confirm(`Delete timeline "${t.name}"? Its shots will be unassigned (not deleted).`)) return;
    try {
      await api.deleteTimeline(t.id, projectId);
      if (selectedId === t.id) setSelectedId(null);
      await loadTimelines();
    } catch (e) {
      setError(`Delete failed: ${(e as Error).message}`);
    }
  }

  const scheduled = shots.filter((s) => s.time_start_seconds != null && s.time_end_seconds != null);
  const unscheduled = shots.filter((s) => !(s.time_start_seconds != null && s.time_end_seconds != null));
  const timelineEnd = scheduled.reduce((m, s) => Math.max(m, s.time_end_seconds ?? 0), 0);
  // The video that is first on each shot's rail, in timeline order (scheduled
  // first, then unscheduled) — the same clip the segment shows on the bar.
  // Local file when downloaded, provider preview URL while the download is
  // still in flight. duration = the shot's slot length on the timeline —
  // playback cuts to the next clip after that many seconds (a shorter clip
  // still ends naturally).
  const playable = [...scheduled, ...unscheduled]
    .map((s) => {
      const c = firstRailCandidate(s, firstSelected.get(s.id));
      const src = c ? (c.local_path ? api.assetFileUrl(c.id) : c.download_url ?? null) : null;
      return {
        shotId: s.id,
        assetId: c?.id ?? "",
        src,
        duration:
          s.time_start_seconds != null && s.time_end_seconds != null
            ? s.time_end_seconds - s.time_start_seconds
            : (s.target_duration_seconds ?? undefined),
      };
    })
    .filter((x): x is { shotId: string; assetId: string; src: string; duration: number | undefined } => x.src != null);

  function startPlayback() {
    if (playable.length === 0) return;
    setPlayQueue(playable);
    setPlayIndex(0);
  }
  const selectedTimeline = timelines.find((t) => t.id === selectedId);
  // Fetch progress is global server-side — only surface it on the timeline
  // the run actually belongs to.
  const fetchProgHere = fetchProg && fetchProg.timelineId === selectedId ? fetchProg : null;

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      {/* --- Timelines sidebar --- */}
      {trays.list ? (
        <Tray label="Timelines" onExpand={() => setTrays((t) => ({ ...t, list: false }))} />
      ) : (
      <div className="ui-card p-4 w-full lg:w-[280px] shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Timelines</h2>
          <button
            onClick={() => setTrays((t) => ({ ...t, list: true }))}
            title="Collapse panel"
            className="text-slate-600 hover:text-slate-300 transition-colors text-sm px-1"
          >«</button>
        </div>
        <ul className="space-y-1">
          {timelines.map((t) => (
            <li key={t.id}>
              <div
                className={`group flex items-center justify-between rounded-lg px-3 py-2 cursor-pointer transition-all ${
                  selectedId === t.id ? "bg-sky-600/20 text-sky-300 border border-sky-700/30" : "bg-slate-900/40 hover:bg-slate-800/60 text-slate-300 border border-transparent"
                }`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className="text-sm truncate flex-1">{t.name} <span className="text-xs opacity-60">({t.shotCount ?? 0})</span></span>
                <span className="opacity-0 group-hover:opacity-100 flex gap-1 ml-2 transition-opacity" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => renameTimeline(t)}
                    className="text-xs px-1.5 rounded bg-slate-700 hover:bg-slate-600"
                    title="Rename"
                  >✎</button>
                  <button
                    onClick={() => deleteTimeline(t)}
                    className="text-xs px-1.5 rounded bg-rose-800 hover:bg-rose-700"
                    title="Delete"
                  >✕</button>
                </span>
              </div>
            </li>
          ))}
          {timelines.length === 0 && <li className="text-xs text-slate-500 py-2">No timelines yet.</li>}
        </ul>
        <div className="mt-3 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createTimeline()}
            placeholder="New timeline name"
            className="ui-input flex-1 text-sm"
          />
          <Button variant="primary" size="sm" onClick={createTimeline}>Add</Button>
        </div>
        {/* Import a saved visualizer setup — each layer-stack row + stem
            becomes a shot on a new "Viz — <name>" timeline. */}
        <div className="mt-3 pt-3 border-t border-slate-800 space-y-1.5">
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">4D timeline session</label>
          {vizSessions.length === 0 ? (
            <p className="text-[11px] text-slate-600">No sessions — save one on the 4D timeline page.</p>
          ) : (
            <div className="flex gap-2">
              <select value={vizSel} onChange={(e) => setVizSel(e.target.value)} className="ui-input flex-1 text-xs min-w-0">
                {vizSessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                disabled={!vizSel || vizLoading}
                onClick={() => void loadVizSession()}
                title="Build a timeline whose shots are this session's layers + stems"
              >
                {vizLoading ? "…" : "Load"}
              </Button>
            </div>
          )}
        </div>
        {unassignedCount > 0 && (
          <p className="text-xs text-slate-500 mt-3">{unassignedCount} shot(s) not assigned to any timeline.</p>
        )}
      </div>
      )}

      {/* --- Timeline view --- */}
      {trays.view ? (
        <Tray label="Timeline" side="right" onExpand={() => setTrays((t) => ({ ...t, view: false }))} />
      ) : (
      <div className="flex-1 min-w-0 w-full space-y-4">
      {/* Window 1 — controls + horizontal (visual) timeline */}
      <div className="ui-card p-5">
        {error && <div className="text-xs text-rose-400 bg-rose-950/40 rounded-lg p-2 border border-rose-800/40 mb-3">{error}</div>}
        {!selectedId && (
          <>
            <div className="flex justify-end -mt-1 -mr-1 mb-1">
              <button
                onClick={() => setTrays((t) => ({ ...t, view: true }))}
                title="Collapse panel"
                className="text-slate-600 hover:text-slate-300 transition-colors text-sm px-1"
              >»</button>
            </div>
            <EmptyState icon="▬" title="Select or create a timeline" description="Create a timeline above, then assign shots to it from the shot review page." />
          </>
        )}
        {selectedId && (
          <>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-semibold text-slate-200">{selectedTimeline?.name ?? "Timeline"}</h2>
              <div className="flex gap-2 items-center">
                {selectedTimeline?.script_text && (
                  <Button variant="secondary" size="sm" onClick={() => setShowScript(true)} title="View the original imported script">
                    ♪ Script
                  </Button>
                )}
                <Badge tone="info">{shots.length} shots</Badge>
                <Badge tone="good">{scheduled.length} scheduled</Badge>
                <Badge tone="default">length {fmtTime(timelineEnd)}</Badge>
                {/* Fetch videos: discover up to N candidates per shot; rails
                    appear under each title, SELECT downloads the clip. */}
                <label className="flex items-center gap-1 text-[10px] text-slate-500 ml-2">
                  max/shot
                  <input
                    type="number" min={1} max={50}
                    value={maxFetch}
                    onChange={(e) => setMaxFetch(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                    className="ui-input w-14 px-1.5 py-0.5 text-xs"
                    title="Max candidate videos to fetch per shot"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  rail size
                  <input
                    type="range" min={1} max={5} step={0.5}
                    value={railScale}
                    onChange={(e) => setRailScale(Number(e.target.value))}
                    className="w-20 accent-sky-500"
                    title="Rail video size (1–5×)"
                  />
                  <span className="w-7 text-right font-mono text-slate-400">{railScale}×</span>
                </label>
                <Button size="sm" variant="secondary" onClick={startFetch} disabled={!selectedId || !!fetchProgHere?.running}>
                  ↓ Fetch video
                </Button>
                {/* Play every shot's first-on-rail video back-to-back, fullscreen. */}
                <button
                  onClick={startPlayback}
                  disabled={playable.length === 0}
                  className="px-3 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={playable.length > 0 ? `Play ${playable.length} clip(s) fullscreen, in timeline order` : "No rail videos yet — run ↓ Fetch video"}
                >
                  ▶ PLAY
                </button>
                {fetchProgHere?.running && (
                  <>
                    <span className="text-xs text-sky-400 whitespace-nowrap">
                      {fetchProgHere.completed}/{fetchProgHere.total} shots{fetchProgHere.paused ? " · paused" : ""} · {fetchProgHere.persisted} found · {fetchProgHere.satisfied} at target
                    </span>
                    <button
                      onClick={() => (fetchProgHere.paused ? api.resumeTimelineFetch(selectedId!, projectId) : api.pauseTimelineFetch(selectedId!, projectId))}
                      className="text-xs px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
                    >{fetchProgHere.paused ? "▶" : "⏸"}</button>
                    <button
                      onClick={() => api.cancelTimelineFetch(selectedId!, projectId)}
                      className="text-xs px-1.5 py-0.5 rounded bg-rose-800 hover:bg-rose-700 text-white"
                    >■</button>
                  </>
                )}
                <button
                  onClick={() => setTrays((t) => ({ ...t, view: true }))}
                  title="Collapse panel"
                  className="text-slate-600 hover:text-slate-300 transition-colors text-sm px-1 ml-1"
                >»</button>
              </div>
            </div>
            {fetchProgHere && !fetchProgHere.running && fetchProgHere.completed > 0 && (
              <div className="text-[11px] text-emerald-400 mb-2">
                ✓ {fetchProgHere.satisfied}/{fetchProgHere.total} shots have {fetchProgHere.maxPerShot} candidates
                {fetchProgHere.persisted > 0 && ` · ${fetchProgHere.persisted} newly fetched`}
                {" — pick SELECT on the rails below."}
                {fetchProgHere.warnings.length > 0 && (
                  <span className="text-amber-400" title={fetchProgHere.warnings.join("\n")}> {fetchProgHere.warnings.length} warning(s).</span>
                )}
                {fetchProgHere.shotErrors.length > 0 && (
                  <span className="text-rose-400" title={fetchProgHere.shotErrors.join("\n")}> {fetchProgHere.shotErrors.length} shot(s) failed.</span>
                )}
              </div>
            )}

            {loading && <p className="text-slate-400 text-sm">Loading…</p>}

            {!loading && scheduled.length > 0 && (
              <TimelineBar
                key={selectedId}
                shots={scheduled}
                end={timelineEnd}
                onOpenShot={onOpenShot}
                selShotId={selShotId}
                firstSelected={firstSelected}
                railScale={railScale}
              />
            )}

            {!loading && shots.length > 0 && scheduled.length === 0 && (
              <p className="text-xs text-slate-500">No scheduled shots — unscheduled shots are listed below.</p>
            )}
          </>
        )}
      </div>

      {/* Window 2 — vertical (list) timeline: shot rows + candidate rails */}
      {selectedId && !loading && (
      <div className="ui-card p-5">
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-3">Shot list</h3>
            {scheduled.length > 0 && (
              <TimelineShotList
                shots={scheduled}
                onOpenShot={onOpenShot}
                selShotId={selShotId}
                onSelectShot={setSelShotId}
                maxFetch={maxFetch}
                dlTasks={dlTasks}
                onKeep={keepCandidate}
                keepBusy={keepBusy}
                firstSelected={firstSelected}
                railScale={railScale}
              />
            )}

            {unscheduled.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Unscheduled ({unscheduled.length})</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {unscheduled.map((s) => {
                    const kid = keptAssetId(s);
                    return (
                    <div key={s.id} className="ui-card p-3">
                      <button onClick={() => onOpenShot(s.id)} className="text-left w-full">
                        <div className="font-mono text-xs text-sky-400">{s.id}</div>
                        <div className="text-xs text-slate-300 truncate mt-0.5">{s.visual_description}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">no time set — click to schedule</div>
                        {kid && <KeptVideo assetId={kid} className="mt-2" />}
                      </button>
                      <CandidateRail shot={s} max={maxFetch} tasks={dlTasks} onKeep={keepCandidate} keepBusy={keepBusy} first={firstSelected.get(s.id)} scale={railScale} />
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            {shots.length === 0 && (
              <EmptyState icon="▬" title="No shots in this timeline" description="Add shots by opening one and setting its timeline + time range." />
            )}
      </div>
      )}
      </div>
      )}

      {/* Fullscreen playlist — selected clips, one after the other. */}
      {playQueue && (
        <PlaylistPlayer
          items={playQueue}
          index={playIndex}
          onIndex={setPlayIndex}
          onClose={() => setPlayQueue(null)}
        />
      )}

      {/* Original script modal — shown when the selected timeline was created
          by a script import (script_text stored on the timeline row). */}
      {showScript && selectedTimeline?.script_text && (
        <Modal title={`Script — ${selectedTimeline.name}`} onClose={() => setShowScript(false)}>
          <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
            {selectedTimeline.script_text}
          </pre>
        </Modal>
      )}
    </div>
  );
}

/**
 * Horizontal (visual) timeline — the top window. A scrollable filmstrip in
 * time order: each shot is a fixed-size tile the same size as the shot-list
 * rail videos (7rem × railScale, 16:9) showing the clip that is first on the
 * shot's rail. A second ruler row shows the time scale.
 */
function TimelineBar({
  shots, end, onOpenShot, selShotId, firstSelected, railScale,
}: {
  shots: Shot[];
  end: number;
  onOpenShot: (id: string) => void;
  selShotId: string | null;
  firstSelected: Map<string, string>;
  railScale: number;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const span = Math.max(end, 1); // avoid divide-by-zero when all shots at 0
  // Build ~6 tick marks across the span.
  const tickCount = 6;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (span * i) / tickCount);

  return (
    <div className="space-y-1">
      {/* Ruler */}
      <div className="relative h-5 text-[10px] text-slate-500">
        {ticks.map((t, i) => (
          <span key={i} className="absolute -translate-x-1/2" style={{ left: `${(t / span) * 100}%` }}>
            {fmtTime(t)}
          </span>
        ))}
      </div>
      {/* Segments — a scrollable filmstrip: each shot's video renders at the
          same size as the shot-list rail tiles (7rem × railScale, 16:9).
          Shots stay in time order; the strip scrolls horizontally. */}
      <div className="bg-slate-900/60 rounded border border-slate-700 overflow-x-auto">
        <div className="flex gap-1 p-1 w-max">
        {shots.map((s, i) => {
          const start = s.time_start_seconds ?? 0;
          const finish = s.time_end_seconds ?? 0;
          const color = segmentColor(i);
          // The segment shows the video that is first on the shot's rail —
          // the just-SELECTed clip (pinned), else a kept clip, else the
          // top-ranked candidate. Local file when downloaded, provider
          // preview URL while the download is still in flight.
          const first = firstRailCandidate(s, firstSelected.get(s.id));
          const kid = keptAssetId(s);
          const src = first
            ? first.local_path ? api.assetFileUrl(first.id) : first.download_url ?? null
            : kid ? api.assetFileUrl(kid) : null;
          const poster = first
            ? first.local_path ? api.assetThumbUrl(first.id) : first.thumbnail_url ?? null
            : kid ? api.assetThumbUrl(kid) : null;
          const hasMedia = src != null || poster != null;
          return (
            <button
              key={s.id}
              onClick={() => onOpenShot(s.id)}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
              title={`${s.id} [${s.section.replace(/_/g, " ")}]: ${fmtTime(start)} → ${fmtTime(finish)} (${fmtTime(finish - start)})`}
              className={`relative shrink-0 rounded ${color} text-white text-[10px] px-1 overflow-hidden hover:ring-2 hover:ring-sky-400/70 transition-all ${
                selShotId === s.id ? "ring-2 ring-sky-300 brightness-125 z-10 shadow-[0_0_10px_rgba(125,211,252,0.6)]" : ""
              }`}
              style={{ width: `${7 * railScale}rem`, aspectRatio: "16 / 9" }}
            >
              {hasMedia && <SegmentMedia src={src} poster={poster} playing={hoveredId === s.id} />}
              <div className={`relative z-10 ${hasMedia ? "[text-shadow:0_1px_3px_rgba(0,0,0,0.95)]" : ""}`}>
                <div className="font-mono leading-tight truncate">{s.id.replace("SHOT_", "S")}</div>
                <div className="leading-tight truncate opacity-90">{fmtTime(finish - start)}</div>
              </div>
            </button>
          );
        })}
        </div>
      </div>
    </div>
  );
}

/**
 * Vertical (list) timeline — the bottom window. Full start/end/length rows
 * grouped by section, each with its kept-clip preview and candidate rail.
 * Clicking a row highlights the matching segment in the bar above.
 */
function TimelineShotList({
  shots, onOpenShot, selShotId, onSelectShot, maxFetch, dlTasks, onKeep, keepBusy, firstSelected, railScale,
}: {
  shots: Shot[];
  onOpenShot: (id: string) => void;
  selShotId: string | null;
  onSelectShot: (id: string | null) => void;
  maxFetch: number;
  dlTasks: Map<string, TaskStatus>;
  onKeep: (shotId: string, assetId: string) => void;
  keepBusy: string | null;
  firstSelected: Map<string, string>;
  railScale: number;
}) {
  return (
    <ul className="text-xs space-y-0.5">
      {shots.map((s, i) => {
        const start = s.time_start_seconds ?? 0;
        const finish = s.time_end_seconds ?? 0;
        const kid = keptAssetId(s);
        // Section header whenever the section changes (shots are time-ordered,
        // and each section occupies a contiguous span).
        const newSection = s.section !== shots[i - 1]?.section;
        return (
          <li key={s.id}>
            {newSection && (
              <div className="pt-2 first:pt-0 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
                {s.section.replace(/_/g, " ")}
              </div>
            )}
            <div
              onClick={() => onSelectShot(selShotId === s.id ? null : s.id)}
              onDoubleClick={() => onOpenShot(s.id)}
              title="Click to highlight in the timeline bar · double-click to open"
              className={`flex items-center gap-2 mt-0.5 rounded px-1.5 -mx-1.5 cursor-pointer transition-colors ${
                selShotId === s.id ? "bg-sky-600/20" : "hover:bg-slate-800/50"
              }`}
            >
              <button onClick={(e) => { e.stopPropagation(); onOpenShot(s.id); }} className="font-mono text-sky-400 hover:underline">{s.id}</button>
              <span className="text-slate-400 truncate flex-1">{s.visual_description}</span>
              <span className="text-slate-300 font-mono whitespace-nowrap">
                {fmtTime(start)} → {fmtTime(finish)}
              </span>
              <span className="text-emerald-400 font-mono whitespace-nowrap">len {fmtTime((finish - start))}</span>
            </div>
            {kid && <KeptVideo assetId={kid} className="mt-1 w-44" />}
            {/* Candidate rail — fetched videos for this title; SELECT picks
                the one to download. */}
            <CandidateRail shot={s} max={maxFetch} tasks={dlTasks} onKeep={onKeep} keepBusy={keepBusy} first={firstSelected.get(s.id)} scale={railScale} />
          </li>
        );
      })}
    </ul>
  );
}

/** Format seconds as M:SS (or H:MM:SS for long spans). Adds a tenth-of-a-
 *  second digit for fractional values — fast-montage clips are sub-second
 *  (e.g. 0.9s → "0:00.9", 227.9 → "3:47.9"). Rounds to tenths first so float
 *  noise (227.90000000000002) can't leak through. */
function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const frac = tenths % 10;
  const total = Math.floor(tenths / 10);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const suffix = frac ? `.${frac}` : "";
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}${suffix}`;
  return `${m}:${String(sec).padStart(2, "0")}${suffix}`;
}

/** The kept (selected) candidate for a shot — only when it has a local file
 *  to display (KEEP after acquisition). Null when nothing is kept yet. */
function keptAssetId(s: Shot): string | null {
  return s.kept_downloaded && s.kept_asset_id ? s.kept_asset_id : null;
}

/** Rail ordering shared by CandidateRail and the bar: the shot's selected
 *  video pins to position 1 (selId = the user's pick this session, else the
 *  persisted kept candidate — selection is exclusive per shot server-side),
 *  then other selected candidates, then the rest in rank order. Stable sort
 *  keeps relative order. */
function sortRail(cands: TimelineCandidate[], selId?: string | null): TimelineCandidate[] {
  const isKept = (c: TimelineCandidate) => c.link_selected === 1 && c.commercial_status === "APPROVED_FOR_EDIT";
  return [...cands].sort((a, b) => Number(b.id === selId) - Number(a.id === selId) || Number(isKept(b)) - Number(isKept(a)));
}

/** The candidate displayed first on a shot's rail — the selected video. Its
 *  preview is what the horizontal bar shows inside the shot's segment. */
function firstRailCandidate(s: Shot, first?: string): TimelineCandidate | null {
  return sortRail(s.candidates ?? [], first ?? s.kept_asset_id)[0] ?? null;
}

/** Video preview inside a timeline segment — shows the candidate's thumbnail
 *  at rest and plays muted+looped while hovered. Works with the local file
 *  (downloaded clip) or the provider-hosted preview URLs (still downloading).
 *  pointer-events-none so the segment button keeps the click. */
function SegmentMedia({ src, poster, playing }: { src: string | null; poster: string | null; playing: boolean }) {
  const cls = "absolute inset-0 w-full h-full object-cover pointer-events-none";
  // The video element mounts only while hovered — keeps ~100 segments from
  // each holding a (possibly remote) stream open at rest.
  if (playing && src) {
    return <video src={src} autoPlay muted loop playsInline className={cls} />;
  }
  if (poster) {
    return <img src={poster} alt="" loading="lazy" className={cls} />;
  }
  if (src) {
    return <video src={src} muted loop playsInline preload="metadata" className={cls} />;
  }
  return null;
}

/** Click-to-play preview of a shot's kept asset — shows the generated
 *  thumbnail until clicked, then the real video with controls.
 *  stopPropagation so playing doesn't trigger surrounding row/card clicks. */
function KeptVideo({ assetId, className = "" }: { assetId: string; className?: string }) {
  const [fs, setFs] = useState(false);
  const [thumbOk, setThumbOk] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  return (
    <div
      ref={boxRef}
      className={`aspect-video bg-black rounded overflow-hidden relative cursor-pointer group ${className} ${fs ? "flex items-center justify-center" : ""}`}
      onClick={(e) => { e.stopPropagation(); setFs(true); boxRef.current?.requestFullscreen().catch(() => {}); }}
      title="Click for fullscreen"
    >
      {fs ? (
        <video
          src={api.assetFileUrl(assetId)}
          poster={api.assetThumbUrl(assetId)}
          controls
          autoPlay
          playsInline
          className="w-full h-full object-contain"
        />
      ) : (
        <>
          {thumbOk ? (
            <img
              src={api.assetThumbUrl(assetId)}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setThumbOk(false)}
            />
          ) : (
            // No generated thumb — show the video's first frame instead.
            <video
              src={api.assetFileUrl(assetId)}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            />
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
            <span className="text-white/0 group-hover:text-white/90 transition-colors text-lg">▶</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Fullscreen playlist — plays the timeline's selected clips in order, each
 * for the shot's timeline duration (time_end − time_start, or the shot's
 * target duration for unscheduled shots). A clip shorter than its slot still
 * advances on ended; a broken file is skipped. Opened by the PLAY button's
 * click, so the fullscreen request counts as a user gesture. ESC / leaving
 * fullscreen closes the player; the last slot finishing exits automatically.
 */
function PlaylistPlayer({
  items, index, onIndex, onClose,
}: {
  items: { shotId: string; assetId: string; src: string; duration: number | undefined }[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  // Enter fullscreen on mount; if the overlay unmounts while still
  // fullscreen (shouldn't happen — close goes through exit), leave cleanly.
  useEffect(() => {
    boxRef.current?.requestFullscreen().catch(() => {});
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Leaving fullscreen (ESC, browser UI) closes the player.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) onClose(); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [onClose]);

  const it = items[index];
  if (!it) return null;

  function advance() {
    if (index + 1 < items.length) {
      onIndex(index + 1);
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {}); // fullscreenchange → onClose
    } else {
      onClose();
    }
  }

  return (
    <div ref={boxRef} className="fixed inset-0 z-50 bg-black flex items-center justify-center">
      {/* key remounts per clip so src changes reset + autoplay cleanly.
          onTimeUpdate cuts to the next clip once the shot's timeline slot
          elapses — paused playback holds because currentTime stops. */}
      <video
        key={it.assetId || it.src}
        src={it.src}
        autoPlay
        controls
        playsInline
        className="w-full h-full object-contain"
        onTimeUpdate={(e) => {
          if (it.duration != null && it.duration > 0 && e.currentTarget.currentTime >= it.duration) advance();
        }}
        onEnded={advance}
        onError={advance}
      />
      <div className="absolute top-3 left-3 text-xs text-slate-300 bg-black/60 rounded px-2 py-1 font-mono">
        {index + 1}/{items.length} · {it.shotId}
        {it.duration != null && it.duration > 0 ? ` · ${fmtTime(it.duration)}` : ""}
      </div>
      <div className="absolute top-3 right-3 flex gap-1">
        <button
          onClick={() => index > 0 && onIndex(index - 1)}
          className="px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-xs"
          title="Previous clip"
        >⏮</button>
        <button
          onClick={advance}
          className="px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-xs"
          title="Next clip"
        >⏭</button>
        <button
          onClick={() => (document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : onClose())}
          className="px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-xs"
          title="Exit (Esc)"
        >✕</button>
      </div>
    </div>
  );
}

/** Stable per-shot segment color based on index. */
function segmentColor(i: number): string {
  const palette = [
    "bg-sky-700", "bg-emerald-700", "bg-violet-700", "bg-amber-700",
    "bg-rose-700", "bg-cyan-700", "bg-fuchsia-700", "bg-teal-700",
  ];
  return palette[i % palette.length]!;
}

/**
 * Horizontal rail of candidate videos for one title (shot). Candidates are
 * discovered by "Fetch video" (search + persist, nothing downloaded). SELECT
 * on a candidate starts a tracked download task — the selected clip appears
 * on the timeline bar once the file lands.
 */
function CandidateRail({
  shot, max, tasks, onKeep, keepBusy, first, scale = 1,
}: {
  shot: Shot;
  max: number;
  tasks: Map<string, TaskStatus>;
  onKeep: (shotId: string, assetId: string) => void;
  keepBusy: string | null;
  first?: string;
  scale?: number;
}) {
  // Position 1 is always the shot's selected video: the user's pick this
  // session (`first`), else the persisted kept candidate (selection is
  // exclusive per shot server-side), else rank order → first fetched wins.
  // Capped at `max`, except "ADD TO TIMELINE" candidates (link_on_rail) always
  // show, so the rail can grow past the cap. Stable sort keeps relative order.
  const selId = first ?? shot.kept_asset_id ?? null;
  const cands = sortRail(shot.candidates ?? [], selId)
    .filter((c, i) => i < max || c.link_on_rail === 1);
  if (cands.length === 0) {
    return <div className="text-[10px] text-slate-600 mt-0.5">no candidates — run ↓ Fetch video</div>;
  }
  return (
    <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
      {cands.map((c, i) => (
        <RailCandidate
          key={c.id}
          c={c}
          taskStatus={tasks.get(c.id) ?? null}
          busy={keepBusy === c.id}
          scale={scale}
          isFirst={i === 0}
          onKeep={() => onKeep(shot.id, c.id)}
        />
      ))}
    </div>
  );
}

/** One candidate tile in the rail: thumbnail (hover streams a preview, click
 *  opens fullscreen), selected badge, download progress overlay, Select button. */
function RailCandidate({
  c, taskStatus, busy, scale = 1, isFirst = false, onKeep,
}: {
  c: TimelineCandidate;
  taskStatus: TaskStatus | null;
  busy: boolean;
  scale?: number;
  isFirst?: boolean;
  onKeep: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [fs, setFs] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const kept = c.link_selected === 1 && c.commercial_status === "APPROVED_FOR_EDIT";
  const rejected = c.commercial_status === "REJECTED" || c.link_rejected === 1;
  // The first rail position is always the shot's selected video — a real pick
  // when one exists, else the first-fetched candidate displays as selected.
  // Only a real kept clip locks the button; clicking the implicit pick still
  // fires SELECT so it becomes approved + downloads.
  const displaySelected = kept || (isFirst && !rejected);
  const downloading = taskStatus === "queued" || taskStatus === "running" || taskStatus === "paused";
  const previewSrc = c.local_path ? api.assetFileUrl(c.id) : (c.download_url ?? null);
  const thumbSrc = c.local_path ? api.assetThumbUrl(c.id) : (c.thumbnail_url ?? null);
  function openFullscreen(e: React.MouseEvent) {
    e.stopPropagation();
    if (!previewSrc) return;
    setFs(true);
    boxRef.current?.requestFullscreen().catch(() => {});
  }
  return (
    // Tile width scales with the rail-size slider (base w-28 = 7rem → up to 5×).
    <div className={`shrink-0 ${rejected ? "opacity-40" : ""}`} style={{ width: `${7 * scale}rem` }}>
      <div
        ref={boxRef}
        className={`relative aspect-video rounded overflow-hidden bg-slate-900 border cursor-pointer ${
          displaySelected ? "border-emerald-500 ring-1 ring-emerald-400/60" : "border-slate-700"
        } ${fs ? "flex items-center justify-center" : ""}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={openFullscreen}
        title={previewSrc ? "Click for fullscreen" : undefined}
      >
        {fs && previewSrc ? (
          <video src={previewSrc} controls autoPlay playsInline className="w-full h-full object-contain bg-black" />
        ) : hover && previewSrc ? (
          <video src={previewSrc} autoPlay muted loop playsInline className="w-full h-full object-cover" />
        ) : thumbSrc ? (
          <img src={thumbSrc} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[9px] text-slate-600">no preview</div>
        )}
        {downloading && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[9px] text-sky-300">
            {taskStatus === "paused" ? "⏸ paused" : taskStatus === "queued" ? "queued" : "downloading…"}
          </div>
        )}
        {displaySelected && (
          <span className="absolute top-0.5 right-0.5 text-[8px] bg-emerald-600 text-white px-1 rounded">selected</span>
        )}
        {!displaySelected && (taskStatus === "failed" || taskStatus === "cancelled") && (
          <span className="absolute top-0.5 right-0.5 text-[8px] bg-rose-700 text-white px-1 rounded">{taskStatus}</span>
        )}
        {!fs && c.duration_seconds != null && c.duration_seconds > 0 && (
          <span className="absolute bottom-0.5 right-0.5 text-[8px] bg-black/70 text-white px-1 rounded font-mono">
            {fmtTime(c.duration_seconds)}
          </span>
        )}
      </div>
      <button
        onClick={onKeep}
        disabled={busy || downloading || kept}
        className={`mt-0.5 w-full text-[9px] rounded py-0.5 font-semibold transition-colors ${
          displaySelected ? "bg-emerald-700 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
        }`}
      >
        {displaySelected ? "✓ Selected" : busy || downloading ? "…" : "Select"}
      </button>
      <div className="text-[8px] text-slate-600 truncate" title={c.title ?? c.provider_id}>{c.title ?? c.provider_id}</div>
    </div>
  );
}
