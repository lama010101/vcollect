import { useEffect, useRef, useState } from "react";
import { api, ASSETS_CHANGED_EVENT, type FoldersResponse, type FolderNode, type FolderAsset, type Project } from "../api.js";
import { RatingSlider } from "../components/RatingSlider.js";
import { PROJECT_ID_ALL } from "@twio/shared";

// Resolve an asset's effective rating, preferring optimistic overrides.
function ratingOf(asset: FolderAsset, overrides: Map<string, number | null>): number | null {
  return overrides.has(asset.assetId) ? overrides.get(asset.assetId) ?? null : asset.rating;
}

// Tailwind border color reflecting rating (red low → emerald high, slate = unrated).
function ratingBorder(rating: number | null): string {
  if (rating == null) return "border-slate-700";
  if (rating >= 7) return "border-emerald-700";
  if (rating >= 4) return "border-amber-700";
  return "border-rose-800";
}

export function Folders({ projectId, projects }: { projectId: string; projects: Project[] }) {
  const [data, setData] = useState<FoldersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [revealMsg, setRevealMsg] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  // ratingOverrides lets the UI update immediately on slider change without
  // waiting for a full reload. Keyed by asset id; value is 0-10 or null.
  const [ratingOverrides, setRatingOverrides] = useState<Map<string, number | null>>(new Map());
  // sortMode: manual sort selection. "none" = filename order (default, no
  // auto-resort while rating), "high" = rating high→low, "low" = rating low→high.
  const [sortMode, setSortMode] = useState<"none" | "high" | "low">("none");
  // viewMode: "grid" (thumbnail cards) or "list" (compact rows).
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  // copyTarget: per-asset "copy to project" target selection (assetId → projectId).
  const [copyTarget, setCopyTarget] = useState<Map<string, string>>(new Map());
  const [copyMsg, setCopyMsg] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  // Timeout refs for dismissible messages — cleaned up on unmount.
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
    };
  }, []);

  async function load() {
    try {
      // Register any video files placed in the project's assets folder outside
      // the app before listing — the folder contents are the source of truth.
      await api.syncProjectAssets(projectId).catch(() => {});
      const r = await api.folders(projectId);
      setData(r);
      setRatingOverrides(new Map());
      // Folders start collapsed by default.
      setExpanded(new Set());
    } catch (e) {
      setError(`Failed to load folders: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    load().catch(console.error);
  }, [projectId]);

  // Reload when files are dropped onto the app (uploads land in the active
  // project's assets folder).
  useEffect(() => {
    const onChanged = () => { load().catch(console.error); };
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function toggle(folder: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  async function copyAsset(assetId: string, toProjectId: string) {
    if (!toProjectId) return;
    try {
      await api.copyAsset(assetId, toProjectId);
      setCopyMsg({ id: assetId, ok: true });
    } catch (e) {
      setCopyMsg({ id: assetId, ok: false, error: (e as Error).message });
    }
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopyMsg(null), 3000);
  }

  async function reveal(assetId: string) {
    try {
      const r = await api.revealAsset(assetId);
      setRevealMsg({ id: assetId, ok: r.ok, error: r.error });
    } catch (e) {
      setRevealMsg({ id: assetId, ok: false, error: (e as Error).message });
    }
    if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
    revealTimeoutRef.current = setTimeout(() => setRevealMsg(null), 3000);
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
      console.error(`[folders] set rating failed: ${(e as Error).message}`);
    }
  }

  if (error) return <div className="text-rose-400">{error}</div>;
  if (!data) return <div className="text-slate-400">Loading folders…</div>;

  const downloadedFolders = data.folders.filter((f) => f.assetCount > 0).length;
  const ratedCount = data.folders.reduce(
    (n, f) => n + f.assets.filter((a) => ratingOf(a, ratingOverrides) != null).length,
    0,
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="font-semibold">Folder structure</h2>
        <div className="flex items-center gap-4">
          <div className="flex items-center rounded overflow-hidden border border-slate-700">
            <button
              onClick={() => setViewMode("grid")}
              className={`px-2 py-1 text-xs ${viewMode === "grid" ? "bg-sky-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
              title="Grid view (thumbnails)"
            >
              ▦ Grid
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`px-2 py-1 text-xs ${viewMode === "list" ? "bg-sky-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
              title="List view (compact rows)"
            >
              ☰ List
            </button>
          </div>
          <div className="flex items-center rounded overflow-hidden border border-slate-700">
            <button
              onClick={() => setSortMode("none")}
              className={`px-2 py-1 text-xs ${sortMode === "none" ? "bg-sky-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
              title="Original filename order (no auto-sort)"
            >
              A–Z
            </button>
            <button
              onClick={() => setSortMode("high")}
              className={`px-2 py-1 text-xs ${sortMode === "high" ? "bg-sky-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
              title="Sort by rating, high to low (unrated last)"
            >
              Rating ↓
            </button>
            <button
              onClick={() => setSortMode("low")}
              className={`px-2 py-1 text-xs ${sortMode === "low" ? "bg-sky-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
              title="Sort by rating, low to high (unrated last)"
            >
              Rating ↑
            </button>
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-3">
        {data.totalDownloaded} downloaded asset(s) · {ratedCount} rated · across {downloadedFolders} folder(s).
        Output root: <code className="text-sky-400">{data.outputRoot}</code>
      </p>

      <div className="ui-card p-3 mb-4">
        <div className="text-xs text-slate-400 mb-1">
          {projectId === PROJECT_ID_ALL ? "Output root" : "Project assets folder"}
        </div>
        <code className="text-sm text-sky-400 break-all">{data.footageRoot}</code>
      </div>

      <div className="space-y-1">
        {data.folders.map((f) => (
          <FolderRow
            key={`${f.projectId}/${f.folder}`}
            folder={f}
            expanded={expanded.has(`${f.projectId}/${f.folder}`)}
            onToggle={() => toggle(`${f.projectId}/${f.folder}`)}
            onReveal={reveal}
            onSetRating={setRating}
            ratingOverrides={ratingOverrides}
            sortMode={sortMode}
            viewMode={viewMode}
            revealMsg={revealMsg}
            projects={projects}
            copyTarget={copyTarget}
            setCopyTarget={setCopyTarget}
            onCopy={copyAsset}
            copyMsg={copyMsg}
          />
        ))}
      </div>
    </div>
  );
}

function FolderRow({
  folder,
  expanded,
  onToggle,
  onReveal,
  onSetRating,
  ratingOverrides,
  sortMode,
  viewMode,
  revealMsg,
  projects,
  copyTarget,
  setCopyTarget,
  onCopy,
  copyMsg,
}: {
  folder: FolderNode;
  expanded: boolean;
  onToggle: () => void;
  onReveal: (assetId: string) => void;
  onSetRating: (assetId: string, prev: number | null, next: number | null) => void;
  ratingOverrides: Map<string, number | null>;
  sortMode: "none" | "high" | "low";
  viewMode: "grid" | "list";
  revealMsg: { id: string; ok: boolean; error?: string } | null;
  projects: Project[];
  copyTarget: Map<string, string>;
  setCopyTarget: (m: Map<string, string>) => void;
  onCopy: (assetId: string, toProjectId: string) => void;
  copyMsg: { id: string; ok: boolean; error?: string } | null;
}) {
  const hasAssets = folder.assetCount > 0;
  const rated = folder.assets.map((a) => ratingOf(a, ratingOverrides));
  const ratedCount = rated.filter((r) => r != null).length;
  const ratedValues = rated.filter((r): r is number => r != null);
  const avg = ratedValues.length > 0 ? ratedValues.reduce((s, n) => s + n, 0) / ratedValues.length : null;

  // Sort assets only when the user explicitly picks a rating sort. "none"
  // keeps filename order and does NOT re-sort while rating changes.
  const sortedAssets =
    sortMode === "none"
      ? [...folder.assets].sort((a, b) => a.filename.localeCompare(b.filename))
      : [...folder.assets].sort((a, b) => {
          const ar = ratingOf(a, ratingOverrides);
          const br = ratingOf(b, ratingOverrides);
          // Unrated always sorts last, regardless of direction.
          if (ar == null && br == null) return a.filename.localeCompare(b.filename);
          if (ar == null) return 1;
          if (br == null) return -1;
          const diff = sortMode === "high" ? br - ar : ar - br;
          if (diff !== 0) return diff;
          return a.filename.localeCompare(b.filename);
        });

  return (
    <div className="ui-card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-750"
      >
        <span className="text-xs text-slate-500 w-4">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono text-sm text-sky-400">{folder.folder}</span>
        {folder.section && (
          <span className="text-xs text-slate-500">({folder.section})</span>
        )}
        {folder.projectName && folder.projectId !== PROJECT_ID_ALL && (
          <span className="text-xs text-violet-400 bg-violet-950/40 px-1.5 rounded">{folder.projectName}</span>
        )}
        <span className="ml-auto text-xs flex items-center gap-2">
          {hasAssets && avg != null && (
            <span className="text-emerald-400">avg {avg.toFixed(1)}/10</span>
          )}
          {hasAssets && (
            <span className="text-slate-400">{ratedCount}/{folder.assetCount} rated</span>
          )}
          <span className={hasAssets ? "text-slate-400" : "text-slate-600"}>
            {folder.assetCount} asset{folder.assetCount === 1 ? "" : "s"}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3">
          <div className="text-xs text-slate-500 mb-3 pl-6 break-all">
            <code className="text-slate-400">{folder.absolutePath}</code>
          </div>
          {hasAssets ? (
            viewMode === "grid" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 pl-6">
                {sortedAssets.map((a) => (
                  <AssetTile
                    key={a.assetId}
                    asset={a}
                    rating={ratingOf(a, ratingOverrides)}
                    onReveal={onReveal}
                    onSetRating={onSetRating}
                    revealMsg={revealMsg}
                    projects={projects}
                    copyTarget={copyTarget.get(a.assetId) ?? ""}
                    setCopyTarget={(pid) => {
                      const m = new Map(copyTarget);
                      if (pid) m.set(a.assetId, pid); else m.delete(a.assetId);
                      setCopyTarget(m);
                    }}
                    onCopy={onCopy}
                    copyMsg={copyMsg}
                  />
                ))}
              </div>
            ) : (
              <div className="pl-6 space-y-1">
                {sortedAssets.map((a) => (
                  <AssetListRow
                    key={a.assetId}
                    asset={a}
                    rating={ratingOf(a, ratingOverrides)}
                    onReveal={onReveal}
                    onSetRating={onSetRating}
                    revealMsg={revealMsg}
                    projects={projects}
                    copyTarget={copyTarget.get(a.assetId) ?? ""}
                    setCopyTarget={(pid) => {
                      const m = new Map(copyTarget);
                      if (pid) m.set(a.assetId, pid); else m.delete(a.assetId);
                      setCopyTarget(m);
                    }}
                    onCopy={onCopy}
                    copyMsg={copyMsg}
                  />
                ))}
              </div>
            )
          ) : (
            <p className="text-xs text-slate-600 pl-6">No downloaded assets.</p>
          )}
        </div>
      )}
    </div>
  );
}

function AssetTile({
  asset,
  rating,
  onReveal,
  onSetRating,
  revealMsg,
  projects,
  copyTarget,
  setCopyTarget,
  onCopy,
  copyMsg,
}: {
  asset: FolderAsset;
  rating: number | null;
  onReveal: (assetId: string) => void;
  onSetRating: (assetId: string, prev: number | null, next: number | null) => void;
  revealMsg: { id: string; ok: boolean; error?: string } | null;
  projects: Project[];
  copyTarget: string;
  setCopyTarget: (projectId: string) => void;
  onCopy: (assetId: string, toProjectId: string) => void;
  copyMsg: { id: string; ok: boolean; error?: string } | null;
}) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  function handleClick() {
    if (!playing) setPlaying(true);
  }

  // When switching to playing mode, auto-play.
  useEffect(() => {
    if (playing && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [playing]);

  return (
    <div className={`rounded bg-slate-900 border overflow-hidden ${ratingBorder(rating)}`}>
      <div
        className="aspect-video bg-black flex items-center justify-center relative cursor-pointer group"
        onClick={handleClick}
        title={playing ? "" : "Click to play"}
      >
        {playing ? (
          <video
            ref={videoRef}
            src={api.assetFileUrl(asset.assetId)}
            poster={api.assetThumbUrl(asset.assetId)}
            controls
            playsInline
            preload="metadata"
            className="w-full h-full object-contain"
          />
        ) : (
          <>
            <img
              src={api.assetThumbUrl(asset.assetId)}
              alt={asset.filename}
              className="max-h-full max-w-full object-contain"
              loading="lazy"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
              <span className="text-3xl text-white/0 group-hover:text-white/90 transition-colors">▶</span>
            </div>
          </>
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-sky-400 truncate" title={asset.filename}>{asset.filename}</span>
        </div>
        <RatingSlider
          value={rating}
          onChange={(next) => onSetRating(asset.assetId, rating, next)}
        />
        <div className="text-xs text-slate-400">
          {asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}
          {asset.durationSeconds != null ? ` · ${asset.durationSeconds.toFixed(1)}s` : ""}
          {" · "}{asset.providerId}
        </div>
        <div className="text-xs">
          <StatusPill status={asset.commercialStatus} />
          {asset.shotIds.length > 0 && <span className="ml-2 text-slate-500">{asset.shotIds.join(", ")}</span>}
        </div>
        <div className="flex gap-1 pt-1 flex-wrap">
          {playing && (
            <button
              onClick={() => setPlaying(false)}
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white"
            >
              Thumbnail
            </button>
          )}
          <button
            onClick={() => onReveal(asset.assetId)}
            className="px-2 py-0.5 rounded bg-sky-700 hover:bg-sky-600 text-xs text-white"
            title="Show this file in File Explorer"
          >
            File Explorer
          </button>
          {revealMsg?.id === asset.assetId && (
            <span className={`self-center text-xs ${revealMsg.ok ? "text-emerald-400" : "text-rose-400"}`}>
              {revealMsg.ok ? "opened" : revealMsg.error ?? "failed"}
            </span>
          )}
        </div>
        <CopyControl
          assetId={asset.assetId}
          projects={projects}
          value={copyTarget}
          onChange={setCopyTarget}
          onCopy={onCopy}
          copyMsg={copyMsg}
          excludeProjectId={asset.projectId}
        />
      </div>
    </div>
  );
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

/**
 * Compact list row for an asset. Shows a small thumbnail (click to expand
 * into an inline player), filename, metadata, ready toggle, and reveal.
 */
function AssetListRow({
  asset,
  rating,
  onReveal,
  onSetRating,
  revealMsg,
  projects,
  copyTarget,
  setCopyTarget,
  onCopy,
  copyMsg,
}: {
  asset: FolderAsset;
  rating: number | null;
  onReveal: (assetId: string) => void;
  onSetRating: (assetId: string, prev: number | null, next: number | null) => void;
  revealMsg: { id: string; ok: boolean; error?: string } | null;
  projects: Project[];
  copyTarget: string;
  setCopyTarget: (projectId: string) => void;
  onCopy: (assetId: string, toProjectId: string) => void;
  copyMsg: { id: string; ok: boolean; error?: string } | null;
}) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (playing && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [playing]);

  return (
    <div className={`rounded bg-slate-900 border p-2 ${ratingBorder(rating)}`}>
      <div className="flex items-start gap-3">
        {/* Thumbnail / inline player */}
        <div
          className="w-28 shrink-0 aspect-video bg-black rounded overflow-hidden cursor-pointer relative group"
          onClick={() => !playing && setPlaying(true)}
          title={playing ? "" : "Click to play"}
        >
          {playing ? (
            <video
              ref={videoRef}
              src={api.assetFileUrl(asset.assetId)}
              poster={api.assetThumbUrl(asset.assetId)}
              controls
              playsInline
              preload="metadata"
              className="w-full h-full object-contain"
            />
          ) : (
            <>
              <img
                src={api.assetThumbUrl(asset.assetId)}
                alt={asset.filename}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
                <span className="text-xl text-white/0 group-hover:text-white/90 transition-colors">▶</span>
              </div>
            </>
          )}
        </div>

        {/* Metadata */}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-sky-400 truncate" title={asset.filename}>{asset.filename}</span>
          </div>
          <RatingSlider
            value={rating}
            onChange={(next) => onSetRating(asset.assetId, rating, next)}
          />
          <div className="text-xs text-slate-400">
            {asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}
            {asset.durationSeconds != null ? ` · ${asset.durationSeconds.toFixed(1)}s` : ""}
            {" · "}{asset.providerId}
            {asset.shotIds.length > 0 ? ` · ${asset.shotIds.join(", ")}` : ""}
          </div>
          <div className="text-xs flex items-center gap-2 flex-wrap">
            <StatusPill status={asset.commercialStatus} />
            <div className="flex gap-1 ml-auto">
              {playing && (
                <button
                  onClick={() => setPlaying(false)}
                  className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white"
                >
                  Thumbnail
                </button>
              )}
              <button
                onClick={() => onReveal(asset.assetId)}
                className="px-2 py-0.5 rounded bg-sky-700 hover:bg-sky-600 text-xs text-white"
                title="Show this file in File Explorer"
              >
                File Explorer
              </button>
              {revealMsg?.id === asset.assetId && (
                <span className={`self-center text-xs ${revealMsg.ok ? "text-emerald-400" : "text-rose-400"}`}>
                  {revealMsg.ok ? "opened" : revealMsg.error ?? "failed"}
                </span>
              )}
            </div>
          </div>
          <CopyControl
            assetId={asset.assetId}
            projects={projects}
            value={copyTarget}
            onChange={setCopyTarget}
            onCopy={onCopy}
            copyMsg={copyMsg}
            excludeProjectId={asset.projectId}
          />
        </div>
      </div>
    </div>
  );
}

/** "Copy to project" control — a dropdown of target projects + a Copy button. */
function CopyControl({
  assetId,
  projects,
  value,
  onChange,
  onCopy,
  copyMsg,
  excludeProjectId,
}: {
  assetId: string;
  projects: Project[];
  value: string;
  onChange: (projectId: string) => void;
  onCopy: (assetId: string, toProjectId: string) => void;
  copyMsg: { id: string; ok: boolean; error?: string } | null;
  excludeProjectId?: string;
}) {
  // Exclude the virtual __ALL__ and the asset's own project from the copy targets.
  const targets = projects.filter((p) => p.id !== PROJECT_ID_ALL && p.id !== excludeProjectId);
  if (targets.length === 0) return null;
  return (
    <div className="flex items-center gap-1 pt-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-input border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-300"
        title="Copy asset to another project"
      >
        <option value="">Copy to…</option>
        {targets.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button
        onClick={() => value && onCopy(assetId, value)}
        disabled={!value}
        className="px-2 py-0.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-xs text-white"
      >
        Copy
      </button>
      {copyMsg?.id === assetId && (
        <span className={`text-xs ${copyMsg.ok ? "text-emerald-400" : "text-rose-400"}`}>
          {copyMsg.ok ? "copied" : copyMsg.error ?? "failed"}
        </span>
      )}
    </div>
  );
}
