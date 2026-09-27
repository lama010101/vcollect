// Thin fetch wrapper for the backend API.
// Same-origin "/api" in dev (Vite proxy) and when the backend serves the SPA.
// Set VITE_API_URL to point the deployed frontend at a hosted backend.
const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** Extract a human-readable error message from a failed fetch response. */
async function errorMessage(r: Response, url: string): Promise<string> {
  try {
    const body = await r.json() as { message?: string; error?: string };
    const detail = body.message ?? body.error ?? r.statusText;
    return `${r.status} ${url}: ${detail}`;
  } catch {
    return `${r.status} ${url}`;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(base + url);
  if (!r.ok) throw new Error(await errorMessage(r, url));
  return r.json() as Promise<T>;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await errorMessage(r, url));
  return r.json() as Promise<T>;
}

async function patchJson<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await errorMessage(r, url));
  return r.json() as Promise<T>;
}

async function putJson<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await errorMessage(r, url));
  return r.json() as Promise<T>;
}

async function deleteJson<T>(url: string): Promise<T> {
  const r = await fetch(base + url, { method: "DELETE" });
  if (!r.ok) throw new Error(await errorMessage(r, url));
  return r.json() as Promise<T>;
}

export interface Shot {
  id: string;
  project_id: string;
  shot_number: number;
  section: string;
  visual_description: string;
  search_query: string;
  status: string | null;
  target_duration_seconds: number | null;
  priority: number | null;
  // Per-shot acquisition priority overrides (NULL → shared defaults).
  min_candidates: number | null; // X
  acquire_count: number | null; // Y
  min_acquire_rating: number | null; // Z (0..1)
  // Timeline membership + absolute position on the timeline (seconds from 0).
  timeline_id: string | null;
  time_start_seconds: number | null;
  time_end_seconds: number | null;
  // Lyrics + directorial reference image (from script import).
  lyrics: string | null;
  reference_image_url: string | null;
  // Augmented on the timeline-shots endpoint: the kept (selected) candidate.
  kept_asset_id?: string | null;
  kept_downloaded?: number | null; // 1 when the kept asset has a local file
  // Ranked candidate pool for the per-title video rail on the Timeline page.
  candidates?: TimelineCandidate[];
}

/** A shot's candidate as returned inside the timeline-shots response —
 *  asset fields plus the shot_assets link state. */
export interface TimelineCandidate {
  id: string;
  link_rank: number;
  link_selected: number;
  link_rejected: number;
  link_on_rail: number;
  title: string | null;
  provider_id: string;
  provider_url: string | null;
  download_url?: string | null;
  thumbnail_url?: string | null;
  local_path: string | null;
  commercial_status: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  final_score: number | null;
}

/** Progress for the timeline-wide "fetch videos" run (search+persist only). */
export interface TimelineFetchProgress {
  running: boolean;
  paused: boolean;
  timelineId: string | null;
  total: number;
  completed: number;
  currentShotId: string | null;
  /** The requested candidates-per-shot this run is topping up to. */
  maxPerShot: number;
  persisted: number;
  /** Shots that ended the run showing the requested candidates per shot
   *  (already satisfied or topped up by this run). */
  satisfied: number;
  error: string | null;
  shotErrors: string[];
  /** Non-fatal issues: tolerated provider failures + shots still below the
   *  requested candidate count. */
  warnings: string[];
}

export interface Timeline {
  id: string;
  name: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  shotCount?: number; // augmented on list responses
  script_text?: string | null; // original script text (script-imported timelines)
}
/** shot_assets link row — returned by GET /api/shots/:id as `shotAssets`. */
export interface ShotAssetLink {
  shot_id: string;
  asset_id: string;
  rank: number | null;
  selected: number;
  rejected: number;
  rejection_reason: string | null;
  is_reserve: number;
  on_rail: number;
}

export interface Asset {
  id: string;
  project_id: string;
  provider_id: string;
  provider_asset_id: string | null;
  provider_url: string;
  title: string | null;
  creator_name: string | null;
  creator_url: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  fps: number | null;
  orientation: string | null;
  local_path: string | null;
  // Provider-hosted file + still — usable to preview a candidate before it's
  // downloaded locally (download happens on KEEP).
  download_url?: string | null;
  thumbnail_url?: string | null;
  aspect_flag: string | null;
  discovered_at: string | null;
  downloaded_at: string | null;
  source_license: string | null;
  license_url: string | null;
  commercial_status: string | null;
  rights_review_status: string | null;
  // Provider-supplied tags, JSON-encoded string[] (null when provider had none).
  tags: string | null;
  final_score: number | null;
  ai_relevance_score: number | null;
  technical_score: number | null;
  duplicate_score: number | null;
  diversity_penalty_applied: number | null;
  duplicate_flag: string | null;
  notes: string | null;
  // Augmented server-side when local_path is set:
  absolute_path?: string;
  folder?: string;
  folder_section?: string | null;
  // User rating 0-10 (null = unrated). Present on all assets returned by the
  // shot endpoint (spread from the assets row).
  rating?: number | null;
}
export type AssetSortKey =
  | "final_score_desc" | "final_score_asc"
  | "rating_desc" | "rating_asc"
  | "duration_desc" | "duration_asc"
  | "newest_downloaded" | "oldest_downloaded"
  | "newest_discovered" | "oldest_discovered"
  | "title_asc" | "title_desc";

// --- Script import types ---
export interface ScriptPreviewShot {
  shotNumber: number;
  section: string;
  lyrics: string | null;
  visualDescription: string;
  searchQuery: string;
  targetDurationSeconds: number;
  priority: number;
  referenceImageUrl: string | null;
  timeStartSeconds: number;
  timeEndSeconds: number;
}
export interface ScriptPreviewSection {
  name: string;
  startSeconds: number | null;
  endSeconds: number | null;
  shotCount: number;
  lyrics: string[];
}
export interface ScriptParseError {
  line: number;
  text: string;
  message: string;
}
export interface ScriptPreviewResult {
  shots: ScriptPreviewShot[];
  sections: ScriptPreviewSection[];
  totalDurationSeconds: number;
  errors: ScriptParseError[];
}
export interface ScriptImportResult {
  ok: boolean;
  projectId: string;
  timelineId: string | null;
  shotsCreated: number;
  totalDurationSeconds: number;
  sections: ScriptPreviewSection[];
}

export interface LlmStatus {
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  reachable: boolean;
  error: string | null;
}

export interface AssetSearchFilters {
  q?: string;
  provider?: string;
  creator?: string;
  tag?: string;
  title?: string;
  minDuration?: number;
  maxDuration?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  orientation?: string;
  downloadedOnly?: boolean;
  discoveredOnly?: boolean;
  commercialStatus?: string;
  rightsReviewStatus?: string;
  sourceLicense?: string;
  minRating?: number;
  maxRating?: number;
  minScore?: number;
  maxScore?: number;
  discoveredAfter?: string;
  discoveredBefore?: string;
  downloadedAfter?: string;
  downloadedBefore?: string;
  sort?: AssetSortKey;
  limit?: number;
}
export interface Dashboard {
  total: number;
  confirmed: number;
  review: number;
  rejected: number;
  approved: number;
  byProvider: Record<string, number>;
  shotsTotal: number;
  shotsWithCandidates: number;
  shotsApproved: number;
  verifiedLabel: string;
  downloaded: number;
  notDownloaded: number;
  projectId: string;
}
/** A candidate returned by a live provider search (not yet persisted). */
export interface AssetCandidate {
  provider: string;
  providerAssetId: string;
  providerUrl: string;
  downloadUrl: string;
  title: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number | null;
  thumbnailUrl: string | null;
  sourceLicense: string | null;
  licenseUrl: string | null;
  tags: string[];
}
export interface Provider {
  id: string;
  name: string;
  license_url: string | null;
  attribution_url: string | null;
  active: number;
}
export interface AssetDownloadProgress {
  assetId: string;
  assetName: string;
  receivedBytes: number;
  totalBytes: number;
  pct: number;
}
export interface AcquireAssetProgress {
  running: boolean;
  assetId: string | null;
  currentAsset: AssetDownloadProgress | null;
  lastResult: { assetId: string; status: string; error?: string; reason?: string } | null;
  error: string | null;
  requestedAssetId?: string;
}
export interface AcquireBatchResult {
  assetId: string;
  status: "downloaded" | "already_downloaded" | "rejected" | "failed";
  error?: string;
  reason?: string;
}
export interface AcquireBatchProgress {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentAssetId: string | null;
  currentAsset: AssetDownloadProgress | null;
  results: AcquireBatchResult[];
  error: string | null;
}
export interface AcquireProgress {
  running: boolean;
  total: number;
  completed: number;
  currentShotId: string | null;
  currentAsset: AssetDownloadProgress | null;
  startedAt: string | null;
  error: string | null;
  shotErrors: string[];
}
export interface ShotAcquireProgress {
  running: boolean;
  paused?: boolean;
  shotId: string | null;
  currentAsset: AssetDownloadProgress | null;
  lastResult: { shotId: string; status: string; downloaded: number; candidatesFound: number; error?: string | null; downloadErrors?: string[] } | null;
  error: string | null;
  requestedShotId?: string;
}

// --- Concurrent download tasks ---
export type TaskKind = "asset" | "shot" | "batch";
export type TaskStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export interface TaskProgress {
  receivedBytes: number;
  totalBytes: number;
  pct: number;
}
export interface TaskItem {
  id: string;
  label: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  error: string | null;
}
export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  total: number | null;
  completed: number | null;
  succeeded: number | null;
  failed: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  assetId: string | null;
  shotId: string | null;
  assetIds: string[] | null;
  items: TaskItem[];
}
export interface TaskConfig {
  maxConcurrent: number;
  running: number;
  queued: number;
}

export interface FolderAsset {
  assetId: string;
  filename: string;
  relativePath: string;
  absolutePath: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  providerId: string;
  commercialStatus: string | null;
  shotIds: string[];
  finalScore: number | null;
  ready: boolean;
  rating: number | null; // 0-10, null = unrated
  projectId: string;
  projectName: string;
}

export interface FolderNode {
  folder: string;
  section: string | null;
  relativePath: string;
  absolutePath: string;
  assetCount: number;
  assets: FolderAsset[];
  projectId: string;
  projectName: string;
}

export interface FoldersResponse {
  outputRoot: string;
  footageRoot: string;
  folders: FolderNode[];
  totalDownloaded: number;
  projectId: string;
}

// --- Projects (multi-project) ---
export interface ProjectCounts {
  shotCount: number;
  assetCount: number;
  downloadedCount: number;
}
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  isVirtual?: boolean;
  counts?: ProjectCounts;
  // Per-project acquisition settings.
  acquireCount?: number | null;
  enforceAcquireCount?: boolean;
  minCandidates?: number | null;
  enforceMinCandidates?: boolean;
  minAcquireRating?: number | null;
  enforceMinAcquireRating?: boolean;
  candidatesPerProvider?: number | null;
}

export interface ProjectSettingsUpdate {
  acquireCount?: number | null;
  enforceAcquireCount?: boolean;
  minCandidates?: number | null;
  enforceMinCandidates?: boolean;
  minAcquireRating?: number | null;
  enforceMinAcquireRating?: boolean;
  candidatesPerProvider?: number | null;
}

/** Append `?project=<id>` to a URL if projectId is provided and not the default. */
function withProject(url: string, projectId?: string): string {
  if (!projectId) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}project=${encodeURIComponent(projectId)}`;
}

export const api = {
  // --- Projects ---
  projects: () => getJson<{ projects: Project[] }>("/api/projects"),
  createProject: (name: string, description?: string) =>
    postJson<{ project: Project }>("/api/projects", { name, description }),
  renameProject: (id: string, name: string, description?: string | null) =>
    patchJson<{ ok: boolean; project: Project }>(`/api/projects/${id}`, { name, description }),
  updateProjectSettings: (id: string, settings: ProjectSettingsUpdate) =>
    patchJson<{ ok: boolean; project: Project }>(`/api/projects/${id}`, settings),
  deleteProject: (id: string) =>
    deleteJson<{ ok: boolean; id: string }>(`/api/projects/${id}`),
  // --- Shots ---
  shots: (projectId?: string) => getJson<{ shots: Shot[] }>(withProject("/api/shots", projectId)),
  shot: (id: string) => getJson<{ shot: Shot | undefined; assets: Asset[]; shotAssets?: ShotAssetLink[] }>(`/api/shots/${id}`),
  createShot: (body: {
    projectId: string; section: string; searchQuery: string; visualDescription: string;
    targetDurationSeconds?: number; priority?: number;
  }) => postJson<{ shot: Shot }>("/api/shots", body),
  deleteShot: (id: string) => deleteJson<{ ok: boolean; id: string }>(`/api/shots/${id}`),
  // --- Script import (bulk shot + timeline creation from text) ---
  previewScript: (projectId: string, script: string, useLlm?: boolean) =>
    postJson<ScriptPreviewResult>(
      `/api/projects/${projectId}/${useLlm ? "preview-script-llm" : "preview-script"}`,
      { script },
    ),
  importScript: (projectId: string, script: string, opts?: { timelineName?: string; replace?: boolean; useLlm?: boolean }) =>
    postJson<ScriptImportResult>(`/api/projects/${projectId}/import-script`, {
      script,
      timelineName: opts?.timelineName,
      replace: opts?.replace ?? false,
      useLlm: opts?.useLlm ?? false,
    }),
  // --- LLM status ---
  llmStatus: () => getJson<LlmStatus>("/api/llm-status"),
  updateShot: (id: string, settings: {
    minCandidates?: number | null;
    acquireCount?: number | null;
    minAcquireRating?: number | null;
    timelineId?: string | null;
    timeStart?: number | null;
    timeEnd?: number | null;
  }) =>
    patchJson<{
      ok: boolean; id: string;
      minCandidates: number | null; acquireCount: number | null; minAcquireRating: number | null;
      timelineId: string | null; timeStart: number | null; timeEnd: number | null;
    }>(`/api/shots/${id}`, settings),
  // Back-compat alias for the X/Y/Z-only updater used by ShotReview.
  updateShotSettings: (id: string, settings: {
    minCandidates?: number | null;
    acquireCount?: number | null;
    minAcquireRating?: number | null;
  }) => api.updateShot(id, settings),
  // --- Timelines ---
  timelines: (projectId?: string) => getJson<{ timelines: Timeline[]; unassignedShotCount: number }>(withProject("/api/timelines", projectId)),
  timelineShots: (id: string, projectId?: string) => getJson<{ timeline: Timeline; shots: Shot[] }>(withProject(`/api/timelines/${id}/shots`, projectId)),
  fetchTimelineVideos: (id: string, maxPerShot: number, projectId?: string) =>
    postJson<{ started?: boolean; alreadyRunning?: boolean; total?: number }>(withProject(`/api/timelines/${id}/fetch`, projectId), { maxPerShot }),
  fetchTimelineProgress: (id: string, projectId?: string) => getJson<TimelineFetchProgress>(withProject(`/api/timelines/${id}/fetch/progress`, projectId)),
  cancelTimelineFetch: (id: string, projectId?: string) => postJson<{ ok: boolean }>(withProject(`/api/timelines/${id}/fetch/cancel`, projectId)),
  pauseTimelineFetch: (id: string, projectId?: string) => postJson<{ ok: boolean }>(withProject(`/api/timelines/${id}/fetch/pause`, projectId)),
  resumeTimelineFetch: (id: string, projectId?: string) => postJson<{ ok: boolean }>(withProject(`/api/timelines/${id}/fetch/resume`, projectId)),
  createTimeline: (name: string, projectId: string) =>
    postJson<{ timeline: Timeline }>("/api/timelines", { name, projectId }),
  renameTimeline: (id: string, name: string, projectId?: string) =>
    patchJson<{ ok: boolean; id: string; name: string }>(withProject(`/api/timelines/${id}`, projectId), { name }),
  deleteTimeline: (id: string, projectId?: string) =>
    deleteJson<{ ok: boolean; id: string }>(withProject(`/api/timelines/${id}`, projectId)),
  // --- Asset search + manual shot/asset assignment ---
  searchAssets: (q: string, projectId?: string, limit?: number) =>
    getJson<{ query: string; assets: Asset[] }>(`/api/assets/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`),
  // Structured asset search. Sends only the filters that are set; the backend
  // takes the structured path when any non-legacy param is present.
  searchAssetsAdvanced: (filters: AssetSearchFilters, projectId?: string) => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.provider) params.set("provider", filters.provider);
    if (filters.creator) params.set("creator", filters.creator);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.title) params.set("title", filters.title);
    if (filters.minDuration != null) params.set("minDuration", String(filters.minDuration));
    if (filters.maxDuration != null) params.set("maxDuration", String(filters.maxDuration));
    if (filters.minWidth != null) params.set("minWidth", String(filters.minWidth));
    if (filters.minHeight != null) params.set("minHeight", String(filters.minHeight));
    if (filters.maxWidth != null) params.set("maxWidth", String(filters.maxWidth));
    if (filters.maxHeight != null) params.set("maxHeight", String(filters.maxHeight));
    if (filters.orientation) params.set("orientation", filters.orientation);
    if (filters.downloadedOnly) params.set("downloadedOnly", "true");
    if (filters.discoveredOnly) params.set("discoveredOnly", "true");
    if (filters.commercialStatus) params.set("commercialStatus", filters.commercialStatus);
    if (filters.rightsReviewStatus) params.set("rightsReviewStatus", filters.rightsReviewStatus);
    if (filters.sourceLicense) params.set("sourceLicense", filters.sourceLicense);
    if (filters.minRating != null) params.set("minRating", String(filters.minRating));
    if (filters.maxRating != null) params.set("maxRating", String(filters.maxRating));
    if (filters.minScore != null) params.set("minScore", String(filters.minScore));
    if (filters.maxScore != null) params.set("maxScore", String(filters.maxScore));
    if (filters.discoveredAfter) params.set("discoveredAfter", filters.discoveredAfter);
    if (filters.discoveredBefore) params.set("discoveredBefore", filters.discoveredBefore);
    if (filters.downloadedAfter) params.set("downloadedAfter", filters.downloadedAfter);
    if (filters.downloadedBefore) params.set("downloadedBefore", filters.downloadedBefore);
    if (filters.sort) params.set("sort", filters.sort);
    if (filters.limit != null) params.set("limit", String(filters.limit));
    if (projectId) params.set("project", projectId);
    return getJson<{ query: string; count: number; assets: Asset[] }>(`/api/assets/search?${params.toString()}`);
  },
  addAssetToShot: (shotId: string, assetId: string) =>
    postJson<{ ok: boolean; shotId: string; assetId: string }>(`/api/shots/${shotId}/assets`, { assetId }),
  removeAssetFromShot: (shotId: string, assetId: string) =>
    deleteJson<{ ok: boolean; shotId: string; assetId: string }>(`/api/shots/${shotId}/assets/${assetId}`),
  // "ADD TO TIMELINE" — flag a linked candidate onto the shot's rail on the
  // Timeline page (the rail always shows on_rail candidates past its cap).
  setAssetOnRail: (shotId: string, assetId: string, onRail: boolean) =>
    patchJson<{ ok: boolean; shotId: string; assetId: string; onRail: boolean }>(`/api/shots/${shotId}/assets/${assetId}`, { onRail }),
  // --- Copy asset to another project ---
  copyAsset: (assetId: string, toProjectId: string, targetShotId?: string | null) =>
    postJson<{ ok: boolean; result: { newAssetId: string; toProjectId: string; copiedFile: boolean; copiedThumbnail: boolean } }>(`/api/assets/${assetId}/copy`, { toProjectId, targetShotId }),
  // --- Dashboard / providers / acquire / manifests ---
  dashboard: (projectId?: string) => getJson<Dashboard>(withProject("/api/dashboard", projectId)),
  providers: () => getJson<{ providers: Provider[] }>("/api/providers"),
  acquireAll: (projectId?: string) => postJson<{ started?: boolean; alreadyRunning?: boolean; total?: number }>(withProject("/api/acquire", projectId)),
  acquireProgress: () => getJson<AcquireProgress>("/api/acquire/progress"),
  acquireShot: (id: string) => postJson<{ started?: boolean; alreadyRunning?: boolean }>(`/api/acquire/${id}`),
  acquireShotProgress: (id: string) => getJson<ShotAcquireProgress>(`/api/acquire/${id}/progress`),
  cancelShotAcquire: (id: string) => postJson<{ ok: boolean }>(`/api/acquire/${id}/cancel`),
  pauseShotAcquire: (id: string) => postJson<{ ok: boolean }>(`/api/acquire/${id}/pause`),
  resumeShotAcquire: (id: string) => postJson<{ ok: boolean }>(`/api/acquire/${id}/resume`),
  acquireReserve: (projectId?: string) => postJson<unknown>(withProject("/api/acquire/reserve", projectId)),
  generateManifests: (projectId?: string) => postJson<unknown>(withProject("/api/manifests/generate", projectId)),
  review: (shotId: string, assetId: string, body: unknown) =>
    postJson<{ ok: boolean; status: string; reason?: string }>(`/api/review/${shotId}/${assetId}`, body),
  assetFileUrl: (id: string) => `${base}/api/assets/${id}/file`,
  assetThumbUrl: (id: string) => `${base}/api/assets/${id}/thumb`,
  folders: (projectId?: string) => getJson<FoldersResponse>(withProject("/api/folders", projectId)),
  revealAsset: (id: string) => postJson<{ ok: boolean; error?: string }>(`/api/assets/${id}/reveal`),
  setAssetReady: (id: string, ready: boolean) =>
    postJson<{ ok: boolean; id: string; ready: boolean }>(`/api/assets/${id}/ready`, { ready }),
  setAssetRating: (id: string, rating: number | null) =>
    postJson<{ ok: boolean; id: string; rating: number | null }>(`/api/assets/${id}/rating`, { rating }),
  // --- Acquire a single discovered asset by id (search-page acquisition) ---
  acquireAsset: (id: string) =>
    postJson<{ started?: boolean; alreadyRunning?: boolean }>(`/api/assets/${id}/acquire`),
  acquireAssetProgress: (id: string) =>
    getJson<AcquireAssetProgress>(`/api/assets/${id}/acquire/progress`),
  // --- Acquire multiple discovered assets (Acquire All on search page) ---
  acquireAssetsBatch: (assetIds: string[]) =>
    postJson<{ started?: boolean; alreadyRunning?: boolean }>(`/api/assets/acquire-batch`, { assetIds }),
  acquireAssetsBatchProgress: () =>
    getJson<AcquireBatchProgress>(`/api/assets/acquire-batch/progress`),
  // --- Live provider search (discover new assets) ---
  searchProviders: (query: string, projectId: string, opts?: { orientation?: string; minWidth?: number; minHeight?: number; provider?: string }) =>
    postJson<{ query: string; count: number; candidates: AssetCandidate[] }>(
      `/api/providers/search${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
      { query, ...opts },
    ),
  acquireCandidate: (candidate: AssetCandidate, projectId: string) =>
    postJson<{ assetId: string; started?: boolean; alreadyRunning?: boolean; alreadyDownloaded?: boolean; task?: Task }>(
      "/api/providers/acquire",
      { candidate, projectId },
    ),
  // --- Concurrent download tasks (parallel downloads with pause/cancel) ---
  tasks: () => getJson<{ tasks: Task[] }>("/api/tasks"),
  task: (id: string) => getJson<{ task: Task }>(`/api/tasks/${id}`),
  startAcquireAssetTask: (assetId: string) =>
    postJson<{ task: Task }>("/api/tasks/acquire-asset", { assetId }),
  startAcquireShotTask: (shotId: string) =>
    postJson<{ task: Task }>("/api/tasks/acquire-shot", { shotId }),
  startAcquireBatchTask: (assetIds: string[]) =>
    postJson<{ task: Task }>("/api/tasks/acquire-batch", { assetIds }),
  pauseTask: (id: string) => postJson<{ ok: boolean; id: string; task: Task }>(`/api/tasks/${id}/pause`),
  resumeTask: (id: string) => postJson<{ ok: boolean; id: string; task: Task }>(`/api/tasks/${id}/resume`),
  cancelTask: (id: string) => postJson<{ ok: boolean; id: string; task: Task }>(`/api/tasks/${id}/cancel`),
  removeTask: (id: string) => deleteJson<{ ok: boolean; id: string }>(`/api/tasks/${id}`),
  pauseAllTasks: () => postJson<{ ok: boolean; paused: string[]; tasks: Task[] }>("/api/tasks/pause-all"),
  resumeAllTasks: () => postJson<{ ok: boolean; resumed: string[]; tasks: Task[] }>("/api/tasks/resume-all"),
  cancelAllTasks: () => postJson<{ ok: boolean; cancelled: string[]; tasks: Task[] }>("/api/tasks/cancel-all"),
  getTaskConfig: () => getJson<{ config: TaskConfig }>("/api/tasks/config"),
  setTaskConfig: (maxConcurrent: number) =>
    putJson<{ ok: boolean; config: TaskConfig; tasks: Task[] }>("/api/tasks/config", { maxConcurrent }),
};
