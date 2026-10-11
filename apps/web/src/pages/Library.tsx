import { useCallback, useEffect, useRef, useState } from "react";
import { api, ASSETS_CHANGED_EVENT, isImageFileName, type AcquireBatchProgress, type Asset, type AssetCandidate, type AssetSearchFilters, type AssetSortKey, type Provider, type Task } from "../api.js";
import { RatingSlider } from "../components/RatingSlider.js";
import { Button, Badge, ProgressBar, EmptyState, Spinner } from "../components/ui.js";

// Tailwind border color reflecting rating (red low → emerald high, slate = unrated).
function ratingBorder(rating: number | null): string {
  if (rating == null) return "border-slate-700";
  if (rating >= 7) return "border-emerald-700";
  if (rating >= 4) return "border-amber-700";
  return "border-rose-800";
}

function StatusPill({ status }: { status: string | null }) {
  const s = status ?? "";
  const color =
    s === "APPROVED_FOR_EDIT" ? "text-emerald-400" :
    s === "LICENSE_SOURCE_CONFIRMED" ? "text-sky-400" :
    s === "HUMAN_REVIEW_REQUIRED" ? "text-amber-400" :
    s === "REJECTED" ? "text-rose-400" :
    "text-slate-400";
  return <span className={color}>{s || "—"}</span>;
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const v = JSON.parse(tagsJson);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string" && t) : [];
  } catch {
    return [];
  }
}

const SORT_OPTIONS: Array<{ value: AssetSortKey; label: string }> = [
  { value: "final_score_desc", label: "Score ↓" },
  { value: "final_score_asc", label: "Score ↑" },
  { value: "rating_desc", label: "Rating ↓" },
  { value: "rating_asc", label: "Rating ↑" },
  { value: "duration_desc", label: "Duration ↓" },
  { value: "duration_asc", label: "Duration ↑" },
  { value: "newest_downloaded", label: "Newest downloaded" },
  { value: "oldest_downloaded", label: "Oldest downloaded" },
  { value: "newest_discovered", label: "Newest discovered" },
  { value: "oldest_discovered", label: "Oldest discovered" },
  { value: "title_asc", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
];

const ORIENTATION_OPTIONS = ["landscape", "portrait", "square"] as const;

const STATUS_OPTIONS = [
  "APPROVED_FOR_EDIT",
  "LICENSE_SOURCE_CONFIRMED",
  "HUMAN_REVIEW_REQUIRED",
  "REJECTED",
  "DISCOVERED",
] as const;

const inputCls = "w-full bg-input border border-slate-700 rounded px-2 py-1 text-sm";
const labelCls = "text-[11px] text-slate-400";

const RECENT_QUERIES_KEY = "twio.recentSearchQueries";
const RECENT_QUERIES_MAX = 10;

/** Poll a task by id until it reaches a terminal status, calling onUpdate
 *  on each poll. Resolves with the final task. Used to drive per-card and
 *  per-candidate acquire state from the concurrent task registry. */
function pollTask(taskId: string, onUpdate: (t: Task) => void, intervalMs = 800): Promise<Task> {
  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const r = await api.task(taskId);
        onUpdate(r.task);
        if (r.task.status === "done" || r.task.status === "failed" || r.task.status === "cancelled") {
          clearInterval(poll);
          resolve(r.task);
        }
      } catch (e) {
        clearInterval(poll);
        reject(e as Error);
      }
    }, intervalMs);
  });
}

export function LibraryPage({ projectId }: { projectId: string }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [results, setResults] = useState<Asset[]>([]);
  const [count, setCount] = useState(0);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // ratingOverrides lets the UI update immediately on slider change without
  // waiting for a full reload. Keyed by asset id; value is 0-10 or null.
  const [ratingOverrides, setRatingOverrides] = useState<Map<string, number | null>>(new Map());
  // Recent search queries, persisted in localStorage so they survive reloads.
  const [recentQueries, setRecentQueries] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_QUERIES_KEY);
      return raw ? JSON.parse(raw) as string[] : [];
    } catch { return []; }
  });

  // Batch acquire ("Acquire All") state.
  const [batchAcquiring, setBatchAcquiring] = useState(false);
  const [batchProgress, setBatchProgress] = useState<AcquireBatchProgress | null>(null);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Search mode: "local" searches the existing asset pool; "providers" calls
  // the live Pexels/Pixabay APIs to discover new candidates.
  const [searchMode, setSearchMode] = useState<"local" | "providers">("local");
  const [candidates, setCandidates] = useState<AssetCandidate[]>([]);
  // Track acquisition state per candidate key (provider:providerAssetId).
  const [candidateAcquire, setCandidateAcquire] = useState<Map<string, { state: "acquiring" | "done" | "failed"; msg?: string }>>(new Map());
  // Sequential batch acquire for provider candidates (backend allows only one
  // download at a time, so candidates are queued and processed one-by-one).
  const [candidateBatch, setCandidateBatch] = useState<{ running: boolean; completed: number; total: number; succeeded: number; failed: number } | null>(null);

  useEffect(() => {
    return () => { if (batchPollRef.current) clearInterval(batchPollRef.current); };
  }, []);

  // Filter form state. Empty/undefined means "no filter on this field".
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("");
  const [creator, setCreator] = useState("");
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [minDuration, setMinDuration] = useState("");
  const [maxDuration, setMaxDuration] = useState("");
  const [minWidth, setMinWidth] = useState("");
  const [minHeight, setMinHeight] = useState("");
  const [maxWidth, setMaxWidth] = useState("");
  const [maxHeight, setMaxHeight] = useState("");
  const [orientation, setOrientation] = useState("");
  const [downloadState, setDownloadState] = useState<"" | "downloaded" | "discovered">("");
  const [commercialStatus, setCommercialStatus] = useState("");
  const [rightsReviewStatus, setRightsReviewStatus] = useState("");
  const [sourceLicense, setSourceLicense] = useState("");
  const [minRating, setMinRating] = useState("");
  const [maxRating, setMaxRating] = useState("");
  const [minScore, setMinScore] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [discoveredAfter, setDiscoveredAfter] = useState("");
  const [discoveredBefore, setDiscoveredBefore] = useState("");
  const [downloadedAfter, setDownloadedAfter] = useState("");
  const [downloadedBefore, setDownloadedBefore] = useState("");
  const [sort, setSort] = useState<AssetSortKey>("final_score_desc");
  const [limit, setLimit] = useState("500");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.providers().then((r) => { if (!cancelled) setProviders(r.providers); }).catch(console.error);
    return () => { cancelled = true; };
  }, []);

  const buildFilters = useCallback((): AssetSearchFilters => {
    const num = (s: string): number | undefined => {
      if (s.trim() === "") return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (s: string): string | undefined => {
      const t = s.trim();
      return t === "" ? undefined : t;
    };
    const filters: AssetSearchFilters = {
      q: str(q),
      provider: str(provider),
      creator: str(creator),
      tag: str(tag),
      title: str(title),
      minDuration: num(minDuration),
      maxDuration: num(maxDuration),
      minWidth: num(minWidth),
      minHeight: num(minHeight),
      maxWidth: num(maxWidth),
      maxHeight: num(maxHeight),
      orientation: str(orientation),
      downloadedOnly: downloadState === "downloaded" ? true : undefined,
      discoveredOnly: downloadState === "discovered" ? true : undefined,
      commercialStatus: str(commercialStatus),
      rightsReviewStatus: str(rightsReviewStatus),
      sourceLicense: str(sourceLicense),
      minRating: num(minRating),
      maxRating: num(maxRating),
      minScore: num(minScore),
      maxScore: num(maxScore),
      discoveredAfter: str(discoveredAfter),
      discoveredBefore: str(discoveredBefore),
      downloadedAfter: str(downloadedAfter),
      downloadedBefore: str(downloadedBefore),
      sort,
      limit: num(limit),
    };
    return filters;
  }, [
    q, provider, creator, tag, title, minDuration, maxDuration, minWidth, minHeight,
    maxWidth, maxHeight, orientation, downloadState, commercialStatus, rightsReviewStatus,
    sourceLicense, minRating, maxRating, minScore, maxScore, discoveredAfter,
    discoveredBefore, downloadedAfter, downloadedBefore, sort, limit,
  ]);

  /** Persist a query to the recent-searches list (deduped, most-recent first). */
  function saveRecentQuery(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecentQueries((prev) => {
      const next = [trimmed, ...prev.filter((q) => q !== trimmed)].slice(0, RECENT_QUERIES_MAX);
      try { localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const runSearch = useCallback(async (opts?: { skipSync?: boolean }) => {
    setSearching(true);
    setErr(null);
    try {
      if (searchMode === "providers") {
        const query = q.trim();
        if (!query) {
          setCandidates([]);
          setCount(0);
          setHasSearched(true);
          return;
        }
        saveRecentQuery(query);
        const r = await api.searchProviders(query, projectId, {
          orientation: orientation || undefined,
          minWidth: minWidth ? Number(minWidth) : undefined,
          minHeight: minHeight ? Number(minHeight) : undefined,
          provider: provider || undefined,
        });
        setCandidates(r.candidates);
        setCount(r.count);
        setCandidateAcquire(new Map());
        setHasSearched(true);
      } else {
        saveRecentQuery(q);
        // Register media placed in the project's assets folder outside the
        // app — in the BACKGROUND. Disk scans can take a while on large or
        // freshly reorganized folders; the listing must not wait on them.
        // When the sync registers/repoints files, refresh the results once.
        if (!opts?.skipSync) {
          void api.syncProjectAssets(projectId)
            .then((r) => { if (r.added + r.moved + r.missing > 0) void runSearch({ skipSync: true }); })
            .catch(() => {});
        }
        const r = await api.searchAssetsAdvanced(buildFilters(), projectId);
        setResults(r.assets);
        setCount(r.count);
        setRatingOverrides(new Map());
        setHasSearched(true);
      }
    } catch (e) {
      setErr(`Search failed: ${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  }, [buildFilters, projectId, searchMode, q, orientation, minWidth, minHeight, provider]);

  // Run an initial empty-filter search on mount / project change so the user
  // sees the whole pool immediately (sorted by final_score desc by default).
  // Only auto-search in local mode; provider mode requires an explicit query.
  useEffect(() => {
    if (searchMode === "local") {
      runSearch().catch(console.error);
    } else {
      setCandidates([]);
      setCount(0);
      setHasSearched(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, searchMode]);

  // Reload the local pool when files are dropped onto the app (uploads land in
  // the active project's assets folder).
  useEffect(() => {
    const onChanged = () => {
      if (searchMode === "local") runSearch().catch(console.error);
    };
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
  }, [projectId, searchMode, runSearch]);

  function clearAll() {
    setQ(""); setProvider(""); setCreator(""); setTag(""); setTitle("");
    setMinDuration(""); setMaxDuration(""); setMinWidth(""); setMinHeight("");
    setMaxWidth(""); setMaxHeight(""); setOrientation(""); setDownloadState("");
    setCommercialStatus(""); setRightsReviewStatus(""); setSourceLicense("");
    setMinRating(""); setMaxRating(""); setMinScore(""); setMaxScore("");
    setDiscoveredAfter(""); setDiscoveredBefore(""); setDownloadedAfter(""); setDownloadedBefore("");
    setSort("final_score_desc"); setLimit("500");
  }

  async function setRating(assetId: string, prev: number | null, next: number | null) {
    if (next === prev) return;
    setRatingOverrides((prevMap) => {
      const m = new Map(prevMap);
      m.set(assetId, next);
      return m;
    });
    try {
      await api.setAssetRating(assetId, next);
    } catch (e) {
      setRatingOverrides((prevMap) => {
        const m = new Map(prevMap);
        m.set(assetId, prev);
        return m;
      });
      console.error(`[search] set rating failed: ${(e as Error).message}`);
    }
  }

  /** Acquire a provider candidate: persist it as a standalone asset and start
   *  a concurrent download task. Polls the task until it finishes. */
  async function acquireCandidate(candidate: AssetCandidate) {
    const key = `${candidate.provider}:${candidate.providerAssetId}`;
    setCandidateAcquire((prev) => {
      const m = new Map(prev);
      m.set(key, { state: "acquiring" });
      return m;
    });
    try {
      const r = await api.acquireCandidate(candidate, projectId);
      if (r.alreadyDownloaded) {
        setCandidateAcquire((prev) => {
          const m = new Map(prev);
          m.set(key, { state: "done" });
          return m;
        });
        return;
      }
      const task = r.task;
      if (!task) {
        // Backward compat: server didn't return a task — treat as done.
        setCandidateAcquire((prev) => {
          const m = new Map(prev);
          m.set(key, { state: "done" });
          return m;
        });
        return;
      }
      const final = await pollTask(task.id, (cur) => {
        setCandidateAcquire((prev) => {
          const m = new Map(prev);
          if (cur.status === "running" || cur.status === "paused") m.set(key, { state: "acquiring" });
          else if (cur.status === "done") m.set(key, { state: "done" });
          else if (cur.status === "failed") m.set(key, { state: "failed", msg: cur.error ?? "failed" });
          else if (cur.status === "cancelled") m.delete(key);
          return m;
        });
      });
      if (final.status === "done") {
        setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "done" }); return m; });
      } else if (final.status === "failed") {
        setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "failed", msg: final.error ?? "failed" }); return m; });
      }
    } catch (e) {
      setCandidateAcquire((prev) => {
        const m = new Map(prev);
        m.set(key, { state: "failed", msg: (e as Error).message });
        return m;
      });
    }
  }

  /** Acquire all provider candidates in parallel. Each candidate starts its
   *  own concurrent download task; we track aggregate progress as they finish. */
  async function acquireAllCandidates() {
    if (candidateBatch?.running) return;
    const queue = [...candidates];
    setCandidateBatch({ running: true, completed: 0, total: queue.length, succeeded: 0, failed: 0 });
    let succeeded = 0;
    let failed = 0;
    let completed = 0;
    const update = () => setCandidateBatch({ running: true, completed, total: queue.length, succeeded, failed });
    await Promise.all(queue.map(async (c) => {
      const key = `${c.provider}:${c.providerAssetId}`;
      setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "acquiring" }); return m; });
      try {
        const r = await api.acquireCandidate(c, projectId);
        if (r.alreadyDownloaded) {
          succeeded++; completed++;
          setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "done" }); return m; });
          update();
          return;
        }
        const task = r.task;
        if (!task) {
          succeeded++; completed++;
          setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "done" }); return m; });
          update();
          return;
        }
        const final = await pollTask(task.id, () => {});
        completed++;
        if (final.status === "done") {
          succeeded++;
          setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "done" }); return m; });
        } else {
          failed++;
          setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "failed", msg: final.error ?? final.status }); return m; });
        }
        update();
      } catch (e) {
        failed++; completed++;
        setCandidateAcquire((prev) => { const m = new Map(prev); m.set(key, { state: "failed", msg: (e as Error).message }); return m; });
        update();
      }
    }));
    setCandidateBatch({ running: false, completed: queue.length, total: queue.length, succeeded, failed });
  }

  /** Acquire every not-yet-downloaded asset in the current result set as a
   *  single concurrent batch task. Polls the task for aggregate progress. */
  async function acquireAllMissing() {
    const missing = results.filter((a) => !a.local_path).map((a) => a.id);
    if (missing.length === 0) return;
    setBatchAcquiring(true);
    setBatchProgress(null);
    try {
      const r = await api.startAcquireBatchTask(missing);
      const taskId = r.task.id;
      batchPollRef.current = setInterval(async () => {
        try {
          const tr = await api.task(taskId);
          const t = tr.task;
          // Map the task into the AcquireBatchProgress shape the UI expects.
          const mapped: AcquireBatchProgress = {
            running: t.status === "running" || t.status === "paused",
            total: t.total ?? missing.length,
            completed: t.completed ?? 0,
            succeeded: t.succeeded ?? 0,
            failed: t.failed ?? 0,
            currentAssetId: null,
            currentAsset: null,
            results: [],
            error: t.error,
          };
          setBatchProgress(mapped);
          if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
            if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; }
            setBatchAcquiring(false);
            await runSearch(); // refresh results to show newly downloaded assets
          }
        } catch (e) {
          if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; }
          setBatchAcquiring(false);
          console.error(`[search] batch progress poll failed: ${(e as Error).message}`);
        }
      }, 1000);
    } catch (e) {
      setBatchAcquiring(false);
      setErr(`Acquire All failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {/* Mode toggle: this project's library (all assets) vs live providers */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700">
            <button
              onClick={() => setSearchMode("local")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${searchMode === "local" ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            >
              ⌕ Library
            </button>
            <button
              onClick={() => setSearchMode("providers")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${searchMode === "providers" ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            >
              ◇ Search providers
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-xs text-slate-400">
            {hasSearched && !searching && searchMode === "local" && (() => {
              const downloaded = results.filter((a) => a.local_path).length;
              return <><Badge tone="good">{downloaded}</Badge> downloaded / <Badge tone="info">{count}</Badge> match{count === 1 ? "" : "es"}</>;
            })()}
            {hasSearched && !searching && searchMode === "providers" && <><Badge tone="info">{count}</Badge> candidate{count === 1 ? "" : "s"}</>}
            {searching && <span className="flex items-center gap-1"><Spinner className="w-3 h-3 text-sky-500" /> searching…</span>}
          </div>
          {hasSearched && !searching && searchMode === "local" && results.some((a) => !a.local_path) && (
            <Button variant="primary" size="sm" onClick={acquireAllMissing} disabled={batchAcquiring} title="Download all not-yet-downloaded assets in the current results">
              {batchAcquiring ? "Acquiring…" : "↓ Acquire All"}
            </Button>
          )}
          {hasSearched && !searching && searchMode === "providers" && candidates.length > 0 && (
            <Button variant="primary" size="sm" onClick={acquireAllCandidates} disabled={!!candidateBatch?.running} title="Download all candidates from this provider search">
              {candidateBatch?.running ? "Acquiring…" : "↓ Acquire All"}
            </Button>
          )}
        </div>
      </div>

      {/* Batch acquire progress bar */}
      {batchProgress && batchProgress.total > 0 && (
        <div className="ui-card p-3">
          <div className="flex items-center justify-between text-xs text-slate-300 mb-1.5">
            <span>
              Acquiring {batchProgress.completed}/{batchProgress.total}
              {batchProgress.succeeded > 0 && <span className="text-emerald-400 ml-2">{batchProgress.succeeded} done</span>}
              {batchProgress.failed > 0 && <span className="text-rose-400 ml-2">{batchProgress.failed} failed</span>}
            </span>
            <span className="text-slate-400">
              {batchProgress.running ? "running…" : "complete"}
            </span>
          </div>
          <ProgressBar value={batchProgress.completed} max={batchProgress.total} />
          {!batchProgress.running && batchProgress.failed > 0 && (
            <div className="text-[10px] text-rose-400 mt-1">
              {batchProgress.failed} asset(s) failed — see individual cards for details.
            </div>
          )}
        </div>
      )}

      {/* Candidate batch acquire progress bar (provider mode) */}
      {candidateBatch && candidateBatch.total > 0 && (
        <div className="ui-card p-3">
          <div className="flex items-center justify-between text-xs text-slate-300 mb-1.5">
            <span>
              Acquiring {candidateBatch.completed}/{candidateBatch.total}
              {candidateBatch.succeeded > 0 && <span className="text-emerald-400 ml-2">{candidateBatch.succeeded} done</span>}
              {candidateBatch.failed > 0 && <span className="text-rose-400 ml-2">{candidateBatch.failed} failed</span>}
            </span>
            <span className="text-slate-400">
              {candidateBatch.running ? "running…" : "complete"}
            </span>
          </div>
          <ProgressBar value={candidateBatch.completed} max={candidateBatch.total} />
          {!candidateBatch.running && candidateBatch.failed > 0 && (
            <div className="text-[10px] text-rose-400 mt-1">
              {candidateBatch.failed} candidate(s) failed — see individual cards for details.
            </div>
          )}
        </div>
      )}

      {err && <div className="text-rose-400 text-sm mb-2">{err}</div>}

      {/* Filter form */}
      <div className="ui-card p-4">
        {/* Always-visible search bar */}
        <div className="flex items-center gap-2 mb-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder={searchMode === "providers" ? "Search providers for new assets…" : "Search the library…"}
            className="ui-input flex-1"
          />
          <Button variant="primary" onClick={() => runSearch()} disabled={searching}>
            {searching ? <Spinner className="w-4 h-4" /> : "Search"}
          </Button>
          <Button variant="secondary" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "− Filters" : "+ Filters"}
          </Button>
        </div>

        {/* Always-visible quick filters: orientation + limit + recent queries */}
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <div className="flex items-center gap-1">
            <span className={labelCls}>Orientation</span>
            <select value={orientation} onChange={(e) => setOrientation(e.target.value)} className={inputCls + " w-auto"}>
              <option value="">any</option>
              {ORIENTATION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className={labelCls}>Limit</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" className={inputCls + " w-20"} />
          </div>
          {recentQueries.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className={labelCls}>Recent</span>
              {recentQueries.map((rq, i) => (
                <button
                  key={`${rq}-${i}`}
                  onClick={() => { setQ(rq); setTimeout(() => runSearch(), 0); }}
                  className="text-[11px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600"
                  title={`Search "${rq}" again`}
                >
                  {rq}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Advanced filters (collapsible) */}
        {showAdvanced && (
        <>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div className="space-y-1">
            <div className={labelCls}>Provider</div>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className={inputCls}>
              <option value="">any</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Title (LIKE)</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Creator (LIKE)</div>
            <input value={creator} onChange={(e) => setCreator(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Tag (LIKE)</div>
            <input value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Download state</div>
            <select value={downloadState} onChange={(e) => setDownloadState(e.target.value as "" | "downloaded" | "discovered")} className={inputCls}>
              <option value="">any</option>
              <option value="downloaded">downloaded only</option>
              <option value="discovered">discovered only</option>
            </select>
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Commercial status</div>
            <select value={commercialStatus} onChange={(e) => setCommercialStatus(e.target.value)} className={inputCls}>
              <option value="">any</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Rights review status</div>
            <input value={rightsReviewStatus} onChange={(e) => setRightsReviewStatus(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} placeholder="e.g. OK" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Source license (LIKE)</div>
            <input value={sourceLicense} onChange={(e) => setSourceLicense(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Min duration (s)</div>
            <input value={minDuration} onChange={(e) => setMinDuration(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Max duration (s)</div>
            <input value={maxDuration} onChange={(e) => setMaxDuration(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Min width (px)</div>
            <input value={minWidth} onChange={(e) => setMinWidth(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Min height (px)</div>
            <input value={minHeight} onChange={(e) => setMinHeight(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Max width (px)</div>
            <input value={maxWidth} onChange={(e) => setMaxWidth(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Max height (px)</div>
            <input value={maxHeight} onChange={(e) => setMaxHeight(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Min rating (0–10)</div>
            <input value={minRating} onChange={(e) => setMinRating(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Max rating (0–10)</div>
            <input value={maxRating} onChange={(e) => setMaxRating(e.target.value)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Min final score (0–1)</div>
            <input value={minScore} onChange={(e) => setMinScore(e.target.value)} inputMode="decimal" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Max final score (0–1)</div>
            <input value={maxScore} onChange={(e) => setMaxScore(e.target.value)} inputMode="decimal" className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Discovered after</div>
            <input type="date" value={discoveredAfter} onChange={(e) => setDiscoveredAfter(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Discovered before</div>
            <input type="date" value={discoveredBefore} onChange={(e) => setDiscoveredBefore(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Downloaded after</div>
            <input type="date" value={downloadedAfter} onChange={(e) => setDownloadedAfter(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Downloaded before</div>
            <input type="date" value={downloadedBefore} onChange={(e) => setDownloadedBefore(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <div className={labelCls}>Sort</div>
            <select value={sort} onChange={(e) => setSort(e.target.value as AssetSortKey)} className={inputCls}>
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={clearAll} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm">
            Clear all filters
          </button>
        </div>
        </>
        )}
      </div>

      {/* Results — local pool mode */}
      {searchMode === "local" && hasSearched && results.length === 0 && !searching && (
        <EmptyState icon="⌕" title="No assets match these filters" description="Try adjusting your search query or clearing some filters." />
      )}
      {searchMode === "local" && results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {results.map((a) => {
            return (
              <SearchAssetCard
                key={a.id}
                asset={a}
                rating={ratingOverrides.has(a.id) ? ratingOverrides.get(a.id) ?? null : a.rating ?? null}
                onSetRating={setRating}
                onAcquired={runSearch}
              />
            );
          })}
        </div>
      )}

      {/* Results — provider search mode */}
      {searchMode === "providers" && hasSearched && candidates.length === 0 && !searching && (
        <EmptyState icon="◇" title="No candidates from providers" description="Try a different search query or check your API keys." />
      )}
      {searchMode === "providers" && candidates.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {candidates.map((c) => {
            const key = `${c.provider}:${c.providerAssetId}`;
            const acq = candidateAcquire.get(key);
            return (
              <CandidateCard
                key={key}
                candidate={c}
                acquireState={acq?.state ?? "idle"}
                acquireMsg={acq?.msg}
                onAcquire={() => acquireCandidate(c)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SearchAssetCard({
  asset,
  rating,
  onSetRating,
  onAcquired,
}: {
  asset: Asset;
  rating: number | null;
  onSetRating: (assetId: string, prev: number | null, next: number | null) => void;
  onAcquired: () => Promise<void>;
}) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const tags = parseTags(asset.tags);
  // Acquire state: "idle" | "acquiring" | "done" | "failed"
  const [acquireState, setAcquireState] = useState<"idle" | "acquiring" | "done" | "failed">("idle");
  const [acquirePct, setAcquirePct] = useState(0);
  const [acquireMsg, setAcquireMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (playing && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [playing]);

  const downloaded = !!asset.local_path;
  const isImage = isImageFileName(asset.local_path ?? asset.title);

  async function startAcquire() {
    if (acquireState === "acquiring") return;
    setAcquireState("acquiring");
    setAcquirePct(0);
    setAcquireMsg(null);
    try {
      const r = await api.startAcquireAssetTask(asset.id);
      const taskId = r.task.id;
      pollRef.current = setInterval(async () => {
        try {
          const tr = await api.task(taskId);
          const t = tr.task;
          if (t.progress) setAcquirePct(t.progress.pct);
          if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (t.status === "done") {
              setAcquireState("done");
              setAcquireMsg(null);
              await onAcquired();
            } else if (t.status === "cancelled") {
              setAcquireState("idle");
              setAcquireMsg("cancelled");
            } else {
              setAcquireState("failed");
              setAcquireMsg(t.error ?? "failed");
              await onAcquired();
            }
          }
        } catch (e) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setAcquireState("failed");
          setAcquireMsg((e as Error).message);
        }
      }, 800);
    } catch (e) {
      setAcquireState("failed");
      setAcquireMsg((e as Error).message);
    }
  }

  return (
    <div className={`ui-card asset-card overflow-hidden border-2 ${ratingBorder(rating)}`}>
      <div
        className="aspect-video bg-black flex items-center justify-center relative cursor-pointer group"
        onClick={() => {
          if (isImage && downloaded) window.open(api.assetFileUrl(asset.id), "_blank");
          else if (!playing && downloaded) setPlaying(true);
        }}
        title={!downloaded ? "Not downloaded" : isImage ? "Click to open" : playing ? "" : "Click to play"}
      >
        {playing && downloaded && !isImage ? (
          <video
            ref={videoRef}
            src={api.assetFileUrl(asset.id)}
            poster={api.assetThumbUrl(asset.id)}
            controls
            playsInline
            preload="metadata"
            className="w-full h-full object-contain"
          />
        ) : downloaded ? (
          <>
            <img
              src={api.assetThumbUrl(asset.id)}
              alt={asset.title ?? asset.id}
              className="max-h-full max-w-full object-contain"
              loading="lazy"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
              <span className="text-3xl text-white/0 group-hover:text-white/90 transition-colors">{isImage ? "↗" : "▶"}</span>
            </div>
          </>
        ) : (
          <div className="text-slate-600 text-xs px-2 text-center">
            <div className="text-slate-500 mb-1">not downloaded</div>
            <div className="text-slate-600 truncate" title={asset.provider_url}>{asset.provider_url}</div>
          </div>
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-sky-400 truncate" title={asset.title ?? asset.id}>
            {asset.title ?? asset.id}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {isImage && (
              <span className="text-[10px] px-1 rounded bg-violet-700/60 text-violet-200 border border-violet-600/60">image</span>
            )}
            <span className="text-[10px] text-slate-500">{asset.provider_id}</span>
          </span>
        </div>
        {asset.creator_name && (
          <div className="text-xs text-slate-400 truncate">by {asset.creator_name}</div>
        )}
        <RatingSlider value={rating} onChange={(next) => onSetRating(asset.id, rating, next)} />
        <div className="text-xs text-slate-400">
          {asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}
          {asset.duration_seconds != null ? ` · ${asset.duration_seconds.toFixed(1)}s` : ""}
          {asset.orientation ? ` · ${asset.orientation}` : ""}
          {asset.final_score != null ? ` · score ${asset.final_score.toFixed(2)}` : ""}
        </div>
        <div className="text-xs">
          <StatusPill status={asset.commercial_status} />
          {downloaded && <span className="ml-2 text-emerald-500">downloaded</span>}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {tags.slice(0, 6).map((t, i) => (
              <span key={`${t}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 border border-slate-600">
                {t}
              </span>
            ))}
            {tags.length > 6 && <span className="text-[10px] text-slate-500">+{tags.length - 6}</span>}
          </div>
        )}
        {acquireState === "acquiring" && (
          <div className="pt-1">
            <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
              <div className="bg-sky-500 h-full transition-all" style={{ width: `${acquirePct}%` }} />
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">downloading… {acquirePct}%</div>
          </div>
        )}
        {acquireState === "failed" && acquireMsg && (
          <div className="text-[10px] text-rose-400 pt-1">acquire failed: {acquireMsg}</div>
        )}
        <div className="flex gap-1 pt-1 flex-wrap">
          {playing && downloaded && (
            <button
              onClick={() => setPlaying(false)}
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white"
            >
              Thumbnail
            </button>
          )}
          {downloaded && (
            <button
              onClick={() => api.revealAsset(asset.id).catch(console.error)}
              className="px-2 py-0.5 rounded bg-sky-700 hover:bg-sky-600 text-xs text-white"
              title="Show this file in File Explorer"
            >
              File Explorer
            </button>
          )}
          {!downloaded && acquireState !== "acquiring" && asset.provider_id !== "local" && (
            <Button variant="primary" size="sm" onClick={startAcquire} title="Download this asset to local disk">
              {acquireState === "done" ? "Re-acquire" : acquireState === "failed" ? "Retry" : "Acquire"}
            </Button>
          )}
          {acquireState === "done" && (
            <span className="text-[10px] text-emerald-400 self-center">acquired ✓</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Card for a provider-search candidate (not yet persisted/downloaded). */
function CandidateCard({
  candidate,
  acquireState,
  acquireMsg,
  onAcquire,
}: {
  candidate: AssetCandidate;
  acquireState: "idle" | "acquiring" | "done" | "failed";
  acquireMsg?: string;
  onAcquire: () => void;
}) {
  const orientation = candidate.width >= candidate.height ? "landscape" : candidate.width === candidate.height ? "square" : "portrait";
  return (
    <div className="ui-card overflow-hidden">
      <div className="aspect-video bg-black flex items-center justify-center">
        {candidate.thumbnailUrl ? (
          <img
            src={candidate.thumbnailUrl}
            alt={candidate.title ?? candidate.providerAssetId}
            className="max-h-full max-w-full object-contain"
            loading="lazy"
          />
        ) : (
          <div className="text-slate-600 text-xs">no preview</div>
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-sky-400 truncate" title={candidate.title ?? candidate.providerAssetId}>
            {candidate.title ?? candidate.providerAssetId}
          </span>
          <span className="text-[10px] text-slate-500 shrink-0">{candidate.provider}</span>
        </div>
        {candidate.creatorName && (
          <div className="text-xs text-slate-400 truncate">by {candidate.creatorName}</div>
        )}
        <div className="text-xs text-slate-400">
          {candidate.width}×{candidate.height}
          {candidate.durationSeconds != null ? ` · ${candidate.durationSeconds.toFixed(1)}s` : ""}
          {` · ${orientation}`}
        </div>
        {candidate.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {candidate.tags.slice(0, 6).map((t, i) => (
              <span key={`${t}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 border border-slate-600">
                {t}
              </span>
            ))}
            {candidate.tags.length > 6 && <span className="text-[10px] text-slate-500">+{candidate.tags.length - 6}</span>}
          </div>
        )}
        {acquireState === "acquiring" && (
          <div className="text-[10px] text-sky-400 pt-1">downloading…</div>
        )}
        {acquireState === "failed" && acquireMsg && (
          <div className="text-[10px] text-rose-400 pt-1">acquire failed: {acquireMsg}</div>
        )}
        <div className="flex gap-1 pt-1 flex-wrap">
          {acquireState !== "acquiring" && (
            <Button variant="primary" size="sm" onClick={onAcquire} title="Download this candidate to local disk">
              {acquireState === "done" ? "Re-acquire" : acquireState === "failed" ? "Retry" : "Acquire"}
            </Button>
          )}
          {acquireState === "done" && (
            <span className="text-[10px] text-emerald-400 self-center">acquired ✓</span>
          )}
          <a
            href={candidate.providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white"
          >
            Source
          </a>
        </div>
      </div>
    </div>
  );
}
