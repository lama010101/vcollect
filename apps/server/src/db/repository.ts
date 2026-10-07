// =============================================================================
// Asset repository — DB CRUD for assets / shot_assets / timelines (raw SQL
// over node:sqlite). Multi-project: every project-scoped query takes a
// `projectId` param and filters by it. PROJECT_ID_ALL ("__ALL__") skips the
// filter to aggregate across all projects.
// =============================================================================

import type { AssetCandidate, ProviderName } from "@twio/shared";
import { providerLicenseStatus, PROJECT_ID_ALL } from "@twio/shared";
import { db } from "../db/client.js";
import type { AssetRow, ShotAssetRow, ShotRow, ShotWithKeptRow, TimelineRow } from "../db/schema.js";
import { classifyLicense } from "../state/machine.js";

function nowIso(): string {
  return new Date().toISOString();
}

function assetIdFor(provider: ProviderName, providerAssetId: string): string {
  return `${provider.toUpperCase()}_${providerAssetId}`;
}

/** True when `projectId` is the virtual aggregate that spans all projects. */
export function isAllProjects(projectId: string): boolean {
  return projectId === PROJECT_ID_ALL;
}

/** Build a `WHERE project_id = ?` clause fragment, or empty for __ALL__. */
function projectFilter(projectId: string, alias = ""): { clause: string; params: unknown[] } {
  if (isAllProjects(projectId)) return { clause: "", params: [] };
  const col = alias ? `${alias}.project_id` : "project_id";
  return { clause: `WHERE ${col} = ?`, params: [projectId] };
}

// Lazy prepared-statement helper: statements are created on first use, so
// importing this module before migrate() runs does not error on missing tables.
type Stmt = ReturnType<typeof db.prepare>;
function lazy(sql: string): () => Stmt {
  let s: Stmt | null = null;
  return () => (s ??= db.prepare(sql));
}

const insertAssetStmt = lazy(
  `INSERT INTO assets (
     id, project_id, provider_id, provider_asset_id, provider_url, download_url,
     title, creator_name, creator_url, width, height, duration_seconds, fps,
     orientation, thumbnail_url, discovered_at, source_license, license_url,
     commercial_status, rights_review_status, vision_status, tags
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OK', 'NOT_RUN', ?)
   -- commercial_status is deliberately NOT updated on conflict: re-discovery
   -- must not downgrade human review decisions (APPROVED_FOR_EDIT / REJECTED /
   -- HUMAN_REVIEW_REQUIRED) when a fetch run re-persists an already-kept or
   -- already-reviewed candidate.
   ON CONFLICT(id) DO UPDATE SET
     provider_url=excluded.provider_url, download_url=excluded.download_url,
     thumbnail_url=excluded.thumbnail_url, discovered_at=excluded.discovered_at,
     tags=excluded.tags`,
);

const insertShotAssetStmt = lazy(
  `INSERT INTO shot_assets (shot_id, asset_id, rank, selected, rejected, is_reserve)
   VALUES (?, ?, ?, 0, 0, ?)
   ON CONFLICT(shot_id, asset_id) DO UPDATE SET rank=excluded.rank, is_reserve=excluded.is_reserve`,
);

/** Insert a discovered candidate, returning the asset id (and license classification). */
export function persistCandidate(
  shotId: string,
  rank: number,
  c: AssetCandidate,
  projectId: string,
  isReserve = false,
): { assetId: string; license: ReturnType<typeof classifyLicense> } {
  const assetId = assetIdFor(c.provider, c.providerAssetId);
  const orientation = c.width >= c.height ? "landscape" : c.width === c.height ? "square" : "portrait";
  // Determine commercial_status at persist time based on the provider's license
  // policy. Pexels/Pixabay are LICENSE_SOURCE_CONFIRMED (free for commercial use,
  // no verification needed). Mixkit is RIGHTS_REVIEW_REQUIRED. Unknown providers
  // stay DISCOVERED.
  const policy = providerLicenseStatus(c.provider);
  const license = classifyLicense(c.sourceLicense, policy);
  const commercialStatus = license === "LICENSE_SOURCE_CONFIRMED"
    ? "LICENSE_SOURCE_CONFIRMED"
    : license === "RIGHTS_REVIEW_REQUIRED"
    ? "HUMAN_REVIEW_REQUIRED"
    : "DISCOVERED";
  insertAssetStmt().run(
    assetId,
    projectId,
    c.provider,
    c.providerAssetId,
    c.providerUrl,
    c.downloadUrl,
    c.title,
    c.creatorName,
    c.creatorUrl,
    c.width,
    c.height,
    c.durationSeconds,
    c.fps,
    orientation,
    c.thumbnailUrl,
    nowIso(),
    c.sourceLicense,
    c.licenseUrl,
    commercialStatus,
    c.tags.length > 0 ? JSON.stringify(c.tags) : null,
  );
  insertShotAssetStmt().run(shotId, assetId, rank, isReserve ? 1 : 0);
  return { assetId, license };
}

/** Persist a discovered candidate as a standalone asset (no shot link).
 *  Used by the provider-search feature on the Search page, where the user
 *  discovers new assets without a shot context. Idempotent on asset id. */
export function persistStandaloneCandidate(
  c: AssetCandidate,
  projectId: string,
): { assetId: string; license: ReturnType<typeof classifyLicense> } {
  const assetId = assetIdFor(c.provider, c.providerAssetId);
  const orientation = c.width >= c.height ? "landscape" : c.width === c.height ? "square" : "portrait";
  const policy = providerLicenseStatus(c.provider);
  const license = classifyLicense(c.sourceLicense, policy);
  const commercialStatus = license === "LICENSE_SOURCE_CONFIRMED"
    ? "LICENSE_SOURCE_CONFIRMED"
    : license === "RIGHTS_REVIEW_REQUIRED"
    ? "HUMAN_REVIEW_REQUIRED"
    : "DISCOVERED";
  insertAssetStmt().run(
    assetId,
    projectId,
    c.provider,
    c.providerAssetId,
    c.providerUrl,
    c.downloadUrl,
    c.title,
    c.creatorName,
    c.creatorUrl,
    c.width,
    c.height,
    c.durationSeconds,
    c.fps,
    orientation,
    c.thumbnailUrl,
    nowIso(),
    c.sourceLicense,
    c.licenseUrl,
    commercialStatus,
    c.tags.length > 0 ? JSON.stringify(c.tags) : null,
  );
  return { assetId, license };
}

/** Insert a user-uploaded (drag & drop) video as a fully-local asset.
 *  Provider is 'local'; license is the user's own ('LOCAL_UPLOAD') so the
 *  file counts as license-confirmed and lands in the project's Uploads
 *  folder. Idempotent on the content-addressed asset id. */
const insertLocalAssetStmt = lazy(
  `INSERT INTO assets (
     id, project_id, provider_id, provider_asset_id, provider_url, download_url,
     title, creator_name, creator_url, width, height, duration_seconds, fps,
     orientation, thumbnail_url, local_path, sha256, discovered_at, downloaded_at,
     source_license, license_url, commercial_status, rights_review_status,
     vision_status, tags, ready, final_score
   ) VALUES (?, ?, 'local', ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?,
     'LOCAL_UPLOAD', NULL, 'LICENSE_SOURCE_CONFIRMED', 'OK', 'NOT_RUN', NULL, 1, ?)
   ON CONFLICT(id) DO NOTHING`,
);

export interface LocalAssetInput {
  id: string;
  projectId: string;
  providerAssetId: string;
  title: string;
  providerUrl: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  fps: number | null;
  orientation: string | null;
  localPath: string;
  sha256: string;
  downloadedAt: string;
}

export function insertLocalAsset(inp: LocalAssetInput): void {
  insertLocalAssetStmt().run(
    inp.id,
    inp.projectId,
    inp.providerAssetId,
    inp.providerUrl,
    inp.title,
    inp.width,
    inp.height,
    inp.durationSeconds,
    inp.fps,
    inp.orientation,
    inp.localPath,
    inp.sha256,
    inp.downloadedAt,
    inp.downloadedAt,
    inp.width != null && inp.height != null && inp.durationSeconds != null ? 1 : null,
  );
}

const updateAssetStmt2 = lazy(
  `UPDATE assets SET
     local_path=?, sha256=?, perceptual_hash=?, duplicate_flag=?, aspect_flag=?,
     width=?, height=?, duration_seconds=?, fps=?, orientation=?,
     downloaded_at=?, commercial_status=?, rights_review_status=?,
     ai_relevance_score=?, technical_score=?, duplicate_score=?, final_score=?,
     diversity_penalty_applied=?, notes=?
   WHERE id=?`,
);

export interface UpdateAssetInput {
  localPath: string | null;
  sha256: string | null;
  perceptualHash: string | null;
  duplicateFlag: string;
  aspectFlag: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  fps: number | null;
  orientation: string | null;
  downloadedAt: string | null;
  commercialStatus: string;
  rightsReviewStatus: string;
  aiRelevanceScore: number | null;
  technicalScore: number | null;
  duplicateScore: number | null;
  finalScore: number | null;
  diversityPenaltyApplied: number;
  notes: string | null;
}

export function updateAsset(id: string, inp: UpdateAssetInput): void {
  updateAssetStmt2().run(
    inp.localPath,
    inp.sha256,
    inp.perceptualHash,
    inp.duplicateFlag,
    inp.aspectFlag,
    inp.width,
    inp.height,
    inp.durationSeconds,
    inp.fps,
    inp.orientation,
    inp.downloadedAt,
    inp.commercialStatus,
    inp.rightsReviewStatus,
    inp.aiRelevanceScore,
    inp.technicalScore,
    inp.duplicateScore,
    inp.finalScore,
    inp.diversityPenaltyApplied,
    inp.notes,
    id,
  );
}

const getAssetStmt = lazy(`SELECT * FROM assets WHERE id = ?`);
export function getAsset(id: string): AssetRow | undefined {
  return getAssetStmt().get(id) as unknown as AssetRow | undefined;
}

const getShotStmt = lazy(`SELECT * FROM shots WHERE id = ?`);
export function getShot(id: string): ShotRow | undefined {
  return getShotStmt().get(id) as unknown as ShotRow | undefined;
}

/** Find the primary (non-reserve) shot linked to an asset, if any.
 *  Used by acquireAssetById to determine the destination folder/filename. */
const primaryShotForAssetStmt = lazy(
  `SELECT s.* FROM shots s
   JOIN shot_assets sa ON sa.shot_id = s.id
   WHERE sa.asset_id = ? AND sa.is_reserve = 0
   ORDER BY sa.rank ASC LIMIT 1`,
);
export function primaryShotForAsset(assetId: string): ShotRow | undefined {
  return primaryShotForAssetStmt().get(assetId) as unknown as ShotRow | undefined;
}

// Project-scoped shot list. For __ALL__, returns every shot across projects.
const listShotsStmt = lazy(`SELECT * FROM shots ORDER BY shot_number ASC`);
const listShotsByProjectStmt = lazy(`SELECT * FROM shots WHERE project_id = ? ORDER BY shot_number ASC`);
export function listShots(projectId = PROJECT_ID_ALL): ShotRow[] {
  if (isAllProjects(projectId)) return listShotsStmt().all() as unknown as ShotRow[];
  return listShotsByProjectStmt().all(projectId) as unknown as ShotRow[];
}

const listAssetsForShotStmt = lazy(
  `SELECT a.* FROM assets a JOIN shot_assets sa ON sa.asset_id = a.id
   WHERE sa.shot_id = ? ORDER BY sa.rank ASC`,
);
export function listAssetsForShot(shotId: string, _projectId = PROJECT_ID_ALL): AssetRow[] {
  // shot_id is globally unique (project-prefixed or SHOT_### legacy), so no
  // extra project filter is needed; the join already scopes to the shot.
  void _projectId;
  return listAssetsForShotStmt().all(shotId) as unknown as AssetRow[];
}

const listShotAssetsStmt = lazy(`SELECT * FROM shot_assets WHERE shot_id = ?`);
export function listShotAssets(shotId: string, _projectId = PROJECT_ID_ALL): ShotAssetRow[] {
  void _projectId;
  return listShotAssetsStmt().all(shotId) as unknown as ShotAssetRow[];
}

// Assets already downloaded for a shot (local_path IS NOT NULL). Keyed by
// asset id → row, so the pipeline can skip re-downloading them on repeat
// acquisition runs.
const downloadedForShotStmt = lazy(
  `SELECT a.* FROM assets a JOIN shot_assets sa ON sa.asset_id = a.id
   WHERE sa.shot_id = ? AND a.local_path IS NOT NULL`,
);
export function downloadedAssetsForShot(shotId: string, _projectId = PROJECT_ID_ALL): Map<string, AssetRow> {
  void _projectId;
  const rows = downloadedForShotStmt().all(shotId) as unknown as AssetRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

const setShotStatusStmt = lazy(`UPDATE shots SET status = ? WHERE id = ?`);
export function setShotStatus(shotId: string, status: string): void {
  setShotStatusStmt().run(status, shotId);
}

// Update a shot's per-shot acquisition priority overrides (X/Y/Z).
// Any field left undefined is written as NULL, which makes the pipeline fall
// back to the shared defaults (see MIN_CANDIDATES_PER_SHOT_DEFAULT etc.).
const updateShotAcquireStmt = lazy(
  `UPDATE shots SET min_candidates = ?, acquire_count = ?, min_acquire_rating = ? WHERE id = ?`,
);
export interface ShotAcquireSettings {
  minCandidates: number | null;
  acquireCount: number | null;
  minAcquireRating: number | null;
}
export function updateShotAcquireSettings(shotId: string, s: ShotAcquireSettings): void {
  updateShotAcquireStmt().run(s.minCandidates, s.acquireCount, s.minAcquireRating, shotId);
}

const setSelectedStmt = lazy(
  `UPDATE shot_assets SET selected = 1, rejected = 0 WHERE shot_id = ? AND asset_id = ?`,
);
export function markSelected(shotId: string, assetId: string): void {
  setSelectedStmt().run(shotId, assetId);
}

// Human selection is exclusive per shot — picking a candidate clears the
// flag on the shot's other links so the timeline rail's first position always
// resolves to the user's pick. (The pipeline's auto-select stays additive; it
// only flags its top candidates without approval.)
const setSelectedExclusiveStmt = lazy(
  `UPDATE shot_assets
   SET selected = CASE WHEN asset_id = ? THEN 1 ELSE 0 END,
       rejected = CASE WHEN asset_id = ? THEN 0 ELSE rejected END
   WHERE shot_id = ?`,
);
export function markSelectedExclusive(shotId: string, assetId: string): void {
  setSelectedExclusiveStmt().run(assetId, assetId, shotId);
}

const setRejectedStmt = lazy(
  `UPDATE shot_assets SET rejected = 1, rejection_reason = ? WHERE shot_id = ? AND asset_id = ?`,
);
export function markRejected(shotId: string, assetId: string, reason: string): void {
  setRejectedStmt().run(reason, shotId, assetId);
}

// "ADD TO TIMELINE" on the shot review page: flags a linked candidate onto
// the shot's Timeline-page rail. Distinct from `selected` (KEEP/approval) —
// on_rail only controls rail visibility, not the chosen-clip semantics.
const setOnRailStmt = lazy(
  `UPDATE shot_assets SET on_rail = ? WHERE shot_id = ? AND asset_id = ?`,
);
export function setShotAssetOnRail(shotId: string, assetId: string, onRail: boolean): boolean {
  return setOnRailStmt().run(onRail ? 1 : 0, shotId, assetId).changes > 0;
}

const allAssetsStmt = lazy(`SELECT * FROM assets ORDER BY final_score DESC`);
const allAssetsByProjectStmt = lazy(`SELECT * FROM assets WHERE project_id = ? ORDER BY final_score DESC`);
export function listAllAssets(projectId = PROJECT_ID_ALL): AssetRow[] {
  if (isAllProjects(projectId)) return allAssetsStmt().all() as unknown as AssetRow[];
  return allAssetsByProjectStmt().all(projectId) as unknown as AssetRow[];
}

/** List all assets with their primary (non-reserve) shot_id via a single JOIN.
 *  Avoids N+1 queries in manifest generation. */
const assetsWithShotsStmt = lazy(
  `SELECT a.*, sa.shot_id AS primary_shot_id, s.shot_number AS primary_shot_number, s.section AS primary_shot_section, s.visual_description AS primary_shot_desc FROM assets a
   LEFT JOIN shot_assets sa ON sa.asset_id = a.id AND sa.is_reserve = 0
   LEFT JOIN shots s ON s.id = sa.shot_id
   ORDER BY a.final_score DESC`,
);
const assetsWithShotsByProjectStmt = lazy(
  `SELECT a.*, sa.shot_id AS primary_shot_id, s.shot_number AS primary_shot_number, s.section AS primary_shot_section, s.visual_description AS primary_shot_desc FROM assets a
   LEFT JOIN shot_assets sa ON sa.asset_id = a.id AND sa.is_reserve = 0
   LEFT JOIN shots s ON s.id = sa.shot_id
   WHERE a.project_id = ? ORDER BY a.final_score DESC`,
);
export interface AssetWithShotRow extends AssetRow {
  primary_shot_id: string | null;
  primary_shot_number: number | null;
  primary_shot_section: string | null;
  primary_shot_desc: string | null;
}
export function listAllAssetsWithShots(projectId = PROJECT_ID_ALL): AssetWithShotRow[] {
  if (isAllProjects(projectId)) return assetsWithShotsStmt().all() as unknown as AssetWithShotRow[];
  return assetsWithShotsByProjectStmt().all(projectId) as unknown as AssetWithShotRow[];
}

const setAssetReadyStmt = lazy(`UPDATE assets SET ready = ? WHERE id = ?`);
export function setAssetReady(id: string, ready: boolean): void {
  setAssetReadyStmt().run(ready ? 1 : 0, id);
}

const setAssetRatingStmt = lazy(`UPDATE assets SET rating = ? WHERE id = ?`);
export function setAssetRating(id: string, rating: number | null): void {
  // Clamp to 0-10; null clears the rating.
  const v = rating == null ? null : Math.max(0, Math.min(10, Math.round(rating)));
  setAssetRatingStmt().run(v, id);
}

const existingShaStmt = lazy(`SELECT id, sha256, perceptual_hash, provider_id, provider_asset_id, project_id FROM assets WHERE sha256 IS NOT NULL`);
const existingShaByProjectStmt = lazy(`SELECT id, sha256, perceptual_hash, provider_id, provider_asset_id, project_id FROM assets WHERE sha256 IS NOT NULL AND project_id = ?`);
export function existingHashes(projectId = PROJECT_ID_ALL): {
  sha256s: Set<string>;
  sourceIds: Set<string>;
  perceptualHashes: string[];
  rows: Array<{ id: string; sha256: string | null; perceptual_hash: string | null; provider_id: string; provider_asset_id: string | null; project_id: string }>;
} {
  const rows = (isAllProjects(projectId) ? existingShaStmt().all() : existingShaByProjectStmt().all(projectId)) as Array<{
    id: string; sha256: string | null; perceptual_hash: string | null; provider_id: string; provider_asset_id: string | null; project_id: string;
  }>;
  return {
    sha256s: new Set(rows.filter((r) => r.sha256).map((r) => r.sha256!)),
    sourceIds: new Set(rows.filter((r) => r.provider_asset_id).map((r) => `${r.provider_id}:${r.provider_asset_id}`)),
    perceptualHashes: rows.filter((r) => r.perceptual_hash).map((r) => r.perceptual_hash!),
    rows,
  };
}

// =============================================================================
// Timelines + timeline-aware shot queries + asset search/assignment
// (all project-scoped)
// =============================================================================

const listTimelinesStmt = lazy(`SELECT * FROM timelines ORDER BY created_at ASC`);
const listTimelinesByProjectStmt = lazy(`SELECT * FROM timelines WHERE project_id = ? ORDER BY created_at ASC`);
export function listTimelines(projectId = PROJECT_ID_ALL): TimelineRow[] {
  if (isAllProjects(projectId)) return listTimelinesStmt().all() as unknown as TimelineRow[];
  return listTimelinesByProjectStmt().all(projectId) as unknown as TimelineRow[];
}

/** List timelines with shot counts via a single JOIN+COUNT query (avoids N+1). */
const listTimelinesWithCountsStmt = lazy(
  `SELECT t.*, COUNT(s.id) AS shotCount FROM timelines t
   LEFT JOIN shots s ON s.timeline_id = t.id
   GROUP BY t.id ORDER BY t.created_at ASC`,
);
const listTimelinesWithCountsByProjectStmt = lazy(
  `SELECT t.*, COUNT(s.id) AS shotCount FROM timelines t
   LEFT JOIN shots s ON s.timeline_id = t.id
   WHERE t.project_id = ?
   GROUP BY t.id ORDER BY t.created_at ASC`,
);
export function listTimelinesWithCounts(projectId = PROJECT_ID_ALL): Array<TimelineRow & { shotCount: number }> {
  if (isAllProjects(projectId)) return listTimelinesWithCountsStmt().all() as unknown as Array<TimelineRow & { shotCount: number }>;
  return listTimelinesWithCountsByProjectStmt().all(projectId) as unknown as Array<TimelineRow & { shotCount: number }>;
}

const getTimelineStmt = lazy(`SELECT * FROM timelines WHERE id = ?`);
const getTimelineByProjectStmt = lazy(`SELECT * FROM timelines WHERE id = ? AND project_id = ?`);
export function getTimeline(id: string, projectId = PROJECT_ID_ALL): TimelineRow | undefined {
  if (isAllProjects(projectId)) return getTimelineStmt().get(id) as unknown as TimelineRow | undefined;
  return getTimelineByProjectStmt().get(id, projectId) as unknown as TimelineRow | undefined;
}

const insertTimelineStmt = lazy(
  `INSERT INTO timelines (id, name, project_id, created_at, updated_at, script_text) VALUES (?, ?, ?, ?, ?, ?)`,
);
export function createTimeline(id: string, name: string, projectId: string, scriptText?: string): TimelineRow {
  const now = nowIso();
  insertTimelineStmt().run(id, name, projectId, now, now, scriptText ?? null);
  return { id, name, project_id: projectId, created_at: now, updated_at: now, script_text: scriptText ?? null };
}

const renameTimelineStmt = lazy(`UPDATE timelines SET name = ?, updated_at = ? WHERE id = ?`);
export function renameTimeline(id: string, name: string): void {
  renameTimelineStmt().run(name, nowIso(), id);
}

const deleteTimelineStmt = lazy(`DELETE FROM timelines WHERE id = ?`);
export function deleteTimeline(id: string): void {
  // shots.timeline_id has ON DELETE SET NULL, so shots survive but become
  // unassigned (reachable via the "unassigned" fallback in the UI).
  deleteTimelineStmt().run(id);
}

// The kept candidate per shot — selected=1 AND commercial_status=
// 'APPROVED_FOR_EDIT' (set only by the KEEP review action; the pipeline's
// auto-select marks selected=1 too but leaves the status unapproved, so
// acquired-but-not-kept candidates don't leak onto the timeline). Prefers a
// downloaded file, then lowest rank. One row per shot via ROW_NUMBER.
const KEPT_ASSET_JOIN = `
  LEFT JOIN (
    SELECT shot_id, asset_id, has_file FROM (
      SELECT sa.shot_id, sa.asset_id,
             CASE WHEN a.local_path IS NOT NULL THEN 1 ELSE 0 END AS has_file,
             ROW_NUMBER() OVER (
               PARTITION BY sa.shot_id
               ORDER BY CASE WHEN a.local_path IS NOT NULL THEN 0 ELSE 1 END, sa.rank ASC
             ) AS rn
      FROM shot_assets sa JOIN assets a ON a.id = sa.asset_id
      WHERE sa.selected = 1 AND a.commercial_status = 'APPROVED_FOR_EDIT'
    ) WHERE rn = 1
  ) kept ON kept.shot_id = s.id`;
const listShotsByTimelineStmt = lazy(
  `SELECT s.*, kept.asset_id AS kept_asset_id, kept.has_file AS kept_downloaded
   FROM shots s ${KEPT_ASSET_JOIN}
   WHERE s.timeline_id = ? ORDER BY s.time_start_seconds ASC, s.shot_number ASC`,
);
const listShotsByTimelineByProjectStmt = lazy(
  `SELECT s.*, kept.asset_id AS kept_asset_id, kept.has_file AS kept_downloaded
   FROM shots s JOIN timelines t ON s.timeline_id = t.id ${KEPT_ASSET_JOIN}
   WHERE s.timeline_id = ? AND t.project_id = ?
   ORDER BY s.time_start_seconds ASC, s.shot_number ASC`,
);
export function listShotsByTimeline(timelineId: string, projectId = PROJECT_ID_ALL): ShotWithKeptRow[] {
  if (isAllProjects(projectId)) return listShotsByTimelineStmt().all(timelineId) as unknown as ShotWithKeptRow[];
  return listShotsByTimelineByProjectStmt().all(timelineId, projectId) as unknown as ShotWithKeptRow[];
}

// All candidates linked to the shots of one timeline, ordered by rank —
// powers the per-title horizontal candidate rail on the Timeline page.
// link_* aliases avoid column-name collisions with the assets columns.
export interface ShotCandidateRow extends AssetRow {
  link_shot_id: string;
  link_rank: number;
  link_selected: number;
  link_rejected: number;
  link_on_rail: number;
}
const listTimelineCandidatesStmt = lazy(
  `SELECT sa.shot_id AS link_shot_id, sa.rank AS link_rank, sa.selected AS link_selected,
          sa.rejected AS link_rejected, COALESCE(sa.on_rail, 0) AS link_on_rail, a.*
   FROM shot_assets sa
   JOIN assets a ON a.id = sa.asset_id
   WHERE sa.shot_id IN (SELECT id FROM shots WHERE timeline_id = ?)
   ORDER BY sa.shot_id,
     CASE WHEN COALESCE(sa.rejected, 0) = 1 OR a.commercial_status = 'REJECTED' THEN 1 ELSE 0 END,
     sa.rank ASC`,
);
export function listTimelineCandidates(timelineId: string): ShotCandidateRow[] {
  return listTimelineCandidatesStmt().all(timelineId) as unknown as ShotCandidateRow[];
}

// "Usable" candidates for a shot's rail: linked and not rejected — neither the
// link (human REJECT / pipeline markRejected) nor the asset itself
// (technical-filter/duplicate REJECTED). The timeline fetch uses this count to
// decide whether a shot already shows the requested number of videos.
const usableCandidateCountStmt = lazy(
  `SELECT COUNT(*) AS n FROM shot_assets sa JOIN assets a ON a.id = sa.asset_id
   WHERE sa.shot_id = ? AND COALESCE(sa.rejected, 0) = 0
     AND COALESCE(a.commercial_status, '') != 'REJECTED'`,
);
export function usableCandidateCountForShot(shotId: string): number {
  return (usableCandidateCountStmt().get(shotId) as { n: number }).n;
}

// Asset ids already linked to a shot but unusable (link-rejected or the asset
// is REJECTED globally). Re-persisting them on a re-fetch can't fill the rail.
const unusableCandidateIdsStmt = lazy(
  `SELECT sa.asset_id AS id FROM shot_assets sa JOIN assets a ON a.id = sa.asset_id
   WHERE sa.shot_id = ? AND (COALESCE(sa.rejected, 0) = 1 OR a.commercial_status = 'REJECTED')`,
);
export function unusableCandidateIdsForShot(shotId: string): Set<string> {
  const rows = unusableCandidateIdsStmt().all(shotId) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

const listShotsWithoutTimelineStmt = lazy(
  `SELECT * FROM shots WHERE timeline_id IS NULL ORDER BY shot_number ASC`,
);
const listShotsWithoutTimelineByProjectStmt = lazy(
  `SELECT * FROM shots WHERE timeline_id IS NULL AND project_id = ? ORDER BY shot_number ASC`,
);
export function listShotsWithoutTimeline(projectId = PROJECT_ID_ALL): ShotRow[] {
  if (isAllProjects(projectId)) return listShotsWithoutTimelineStmt().all() as unknown as ShotRow[];
  return listShotsWithoutTimelineByProjectStmt().all(projectId) as unknown as ShotRow[];
}

const setShotTimelineStmt = lazy(`UPDATE shots SET timeline_id = ? WHERE id = ?`);
export function setShotTimeline(shotId: string, timelineId: string | null): void {
  setShotTimelineStmt().run(timelineId, shotId);
}

const setShotTimeRangeStmt = lazy(
  `UPDATE shots SET time_start_seconds = ?, time_end_seconds = ? WHERE id = ?`,
);
export function setShotTimeRange(shotId: string, start: number | null, end: number | null): void {
  setShotTimeRangeStmt().run(start, end, shotId);
}

// Free-text search across the discovered/downloaded asset pool. Matches title,
// tags (JSON text), creator_name, and provider_id. Used by the "search for
// assets and add them to shots" feature.
// Free-text search across the discovered/downloaded asset pool. Matches title,
// tags (JSON text), creator_name, and provider_id on the asset itself, PLUS the
// visual_description / search_query / section of any shot linked to the asset
// via shot_assets. The shot-text join is essential because provider APIs often
// return little/no title/tags metadata — the shot's visual description is the
// primary human-readable text associated with a candidate.
const searchAssetsStmt = lazy(
  `SELECT * FROM assets
   WHERE title LIKE ? OR tags LIKE ? OR creator_name LIKE ? OR provider_id LIKE ?
     OR id IN (
       SELECT sa.asset_id FROM shot_assets sa
       JOIN shots s ON s.id = sa.shot_id
       WHERE s.visual_description LIKE ? OR s.search_query LIKE ? OR s.section LIKE ?
     )
   ORDER BY final_score DESC
   LIMIT ?`,
);
const searchAssetsByProjectStmt = lazy(
  `SELECT * FROM assets
   WHERE project_id = ? AND (title LIKE ? OR tags LIKE ? OR creator_name LIKE ? OR provider_id LIKE ?
     OR id IN (
       SELECT sa.asset_id FROM shot_assets sa
       JOIN shots s ON s.id = sa.shot_id
       WHERE s.project_id = assets.project_id
         AND (s.visual_description LIKE ? OR s.search_query LIKE ? OR s.section LIKE ?)
     ))
   ORDER BY final_score DESC
   LIMIT ?`,
);
export function searchAssets(query: string, projectId = PROJECT_ID_ALL, limit = 50): AssetRow[] {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q}%`;
  if (isAllProjects(projectId)) {
    return searchAssetsStmt().all(like, like, like, like, like, like, like, limit) as unknown as AssetRow[];
  }
  return searchAssetsByProjectStmt().all(projectId, like, like, like, like, like, like, like, limit) as unknown as AssetRow[];
}

// =============================================================================
// Advanced / structured asset search (PRD extension)
//
// Builds a dynamic WHERE clause with positional ? params. Safe from SQL
// injection because every user-supplied value is bound via a placeholder —
// no string interpolation of values into the SQL text. Only column names and
// SQL keywords go into the text, and those are picked from fixed allowlists.
//
// All filters are optional and combine with AND. An empty filter set returns
// every asset (subject to project scoping and the limit).
// =============================================================================

export type AssetSortKey =
  | "final_score_desc"
  | "final_score_asc"
  | "rating_desc"
  | "rating_asc"
  | "duration_desc"
  | "duration_asc"
  | "newest_downloaded"
  | "oldest_downloaded"
  | "newest_discovered"
  | "oldest_discovered"
  | "title_asc"
  | "title_desc";

const SORT_CLAUSES: Record<AssetSortKey, string> = {
  final_score_desc: "final_score DESC NULLS LAST",
  final_score_asc: "final_score ASC NULLS FIRST",
  rating_desc: "rating DESC NULLS LAST",
  rating_asc: "rating ASC NULLS FIRST",
  duration_desc: "duration_seconds DESC NULLS LAST",
  duration_asc: "duration_seconds ASC NULLS FIRST",
  newest_downloaded: "downloaded_at DESC NULLS LAST",
  oldest_downloaded: "downloaded_at ASC NULLS FIRST",
  newest_discovered: "discovered_at DESC NULLS LAST",
  oldest_discovered: "discovered_at ASC NULLS FIRST",
  title_asc: "title ASC NULLS LAST",
  title_desc: "title DESC NULLS FIRST",
};

const ALLOWED_ORIENTATIONS = new Set(["landscape", "portrait", "square"]);

export interface AssetSearchFilters {
  /** Free-text LIKE match across title, tags, creator_name, provider_id. */
  q?: string;
  /** Exact provider id match (e.g. "pexels"). */
  provider?: string;
  /** LIKE match on creator_name. */
  creator?: string;
  /** LIKE match on the JSON-encoded tags text. */
  tag?: string;
  /** LIKE match on title. */
  title?: string;
  /** Min duration (seconds), inclusive. */
  minDuration?: number;
  /** Max duration (seconds), inclusive. */
  maxDuration?: number;
  /** Min width (px), inclusive. */
  minWidth?: number;
  /** Min height (px), inclusive. */
  minHeight?: number;
  /** Max width (px), inclusive. */
  maxWidth?: number;
  /** Max height (px), inclusive. */
  maxHeight?: number;
  /** One of landscape | portrait | square. */
  orientation?: string;
  /** When true, only assets with local_path IS NOT NULL. */
  downloadedOnly?: boolean;
  /** When true, only assets with local_path IS NULL. */
  discoveredOnly?: boolean;
  /** Exact commercial_status match. */
  commercialStatus?: string;
  /** Exact rights_review_status match. */
  rightsReviewStatus?: string;
  /** LIKE match on source_license. */
  sourceLicense?: string;
  /** Min user rating (0-10), inclusive. */
  minRating?: number;
  /** Max user rating (0-10), inclusive. */
  maxRating?: number;
  /** Min final_score (0..1), inclusive. */
  minScore?: number;
  /** Max final_score (0..1), inclusive. */
  maxScore?: number;
  /** ISO date string; keeps assets discovered on/after this date. */
  discoveredAfter?: string;
  /** ISO date string; keeps assets discovered on/before this date. */
  discoveredBefore?: string;
  /** ISO date string; keeps assets downloaded on/after this date. */
  downloadedAfter?: string;
  /** ISO date string; keeps assets downloaded on/before this date. */
  downloadedBefore?: string;
  /** Sort key (defaults to final_score_desc). */
  sort?: AssetSortKey;
  /** Result cap (1..500, default 50). */
  limit?: number;
}

/** Apply the structured filters and return matching asset rows. */
export function searchAssetsAdvanced(
  filters: AssetSearchFilters,
  projectId = PROJECT_ID_ALL,
): AssetRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!isAllProjects(projectId)) {
    where.push("project_id = ?");
    params.push(projectId);
  }

  const q = filters.q?.trim();
  if (q) {
    const like = `%${q}%`;
    // Match asset text columns OR any linked shot's visual_description /
    // search_query / section. The subquery is project-scoped via a correlated
    // reference to assets.project_id so it respects the project filter.
    where.push(
      "(title LIKE ? OR tags LIKE ? OR creator_name LIKE ? OR provider_id LIKE ?"
        + " OR id IN (SELECT sa.asset_id FROM shot_assets sa"
        + " JOIN shots s ON s.id = sa.shot_id"
        + " WHERE s.project_id = assets.project_id"
        + " AND (s.visual_description LIKE ? OR s.search_query LIKE ? OR s.section LIKE ?)))",
    );
    params.push(like, like, like, like, like, like, like);
  }
  if (filters.provider) {
    where.push("provider_id = ?");
    params.push(filters.provider);
  }
  if (filters.creator) {
    where.push("creator_name LIKE ?");
    params.push(`%${filters.creator}%`);
  }
  if (filters.tag) {
    where.push("tags LIKE ?");
    params.push(`%${filters.tag}%`);
  }
  if (filters.title) {
    where.push("title LIKE ?");
    params.push(`%${filters.title}%`);
  }
  if (filters.minDuration != null) {
    where.push("duration_seconds >= ?");
    params.push(filters.minDuration);
  }
  if (filters.maxDuration != null) {
    where.push("duration_seconds <= ?");
    params.push(filters.maxDuration);
  }
  if (filters.minWidth != null) {
    where.push("width >= ?");
    params.push(filters.minWidth);
  }
  if (filters.minHeight != null) {
    where.push("height >= ?");
    params.push(filters.minHeight);
  }
  if (filters.maxWidth != null) {
    where.push("width <= ?");
    params.push(filters.maxWidth);
  }
  if (filters.maxHeight != null) {
    where.push("height <= ?");
    params.push(filters.maxHeight);
  }
  if (filters.orientation && ALLOWED_ORIENTATIONS.has(filters.orientation)) {
    where.push("orientation = ?");
    params.push(filters.orientation);
  }
  if (filters.downloadedOnly) {
    where.push("local_path IS NOT NULL");
  }
  if (filters.discoveredOnly) {
    where.push("local_path IS NULL");
  }
  if (filters.commercialStatus) {
    where.push("commercial_status = ?");
    params.push(filters.commercialStatus);
  }
  if (filters.rightsReviewStatus) {
    where.push("rights_review_status = ?");
    params.push(filters.rightsReviewStatus);
  }
  if (filters.sourceLicense) {
    where.push("source_license LIKE ?");
    params.push(`%${filters.sourceLicense}%`);
  }
  if (filters.minRating != null) {
    where.push("rating >= ?");
    params.push(filters.minRating);
  }
  if (filters.maxRating != null) {
    where.push("rating <= ?");
    params.push(filters.maxRating);
  }
  if (filters.minScore != null) {
    where.push("final_score >= ?");
    params.push(filters.minScore);
  }
  if (filters.maxScore != null) {
    where.push("final_score <= ?");
    params.push(filters.maxScore);
  }
  if (filters.discoveredAfter) {
    where.push("discovered_at >= ?");
    params.push(filters.discoveredAfter);
  }
  if (filters.discoveredBefore) {
    where.push("discovered_at <= ?");
    params.push(filters.discoveredBefore);
  }
  if (filters.downloadedAfter) {
    where.push("downloaded_at >= ?");
    params.push(filters.downloadedAfter);
  }
  if (filters.downloadedBefore) {
    where.push("downloaded_at <= ?");
    params.push(filters.downloadedBefore);
  }

  const sortKey: AssetSortKey = filters.sort ?? "final_score_desc";
  const orderBy = SORT_CLAUSES[sortKey] ?? SORT_CLAUSES.final_score_desc;
  const limit = Math.max(1, Math.min(500, Math.round(filters.limit ?? 50)));

  const sql = `SELECT * FROM assets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy} LIMIT ?`;
  params.push(limit);
  return db.all<AssetRow>(sql, ...params);
}

// Link an existing asset to a shot (manual curation). Idempotent: if the link
// already exists, only refresh the rank. Does NOT touch the asset row itself.
const addAssetToShotStmt = lazy(
  `INSERT INTO shot_assets (shot_id, asset_id, rank, selected, rejected, is_reserve)
   VALUES (?, ?, ?, 0, 0, 0)
   ON CONFLICT(shot_id, asset_id) DO UPDATE SET rank = excluded.rank`,
);
export function addAssetToShot(shotId: string, assetId: string, rank = 999): void {
  addAssetToShotStmt().run(shotId, assetId, rank);
}

const removeAssetFromShotStmt = lazy(
  `DELETE FROM shot_assets WHERE shot_id = ? AND asset_id = ?`,
);
export function removeAssetFromShot(shotId: string, assetId: string): void {
  removeAssetFromShotStmt().run(shotId, assetId);
}

// --- Shot CRUD (manual add-shot form) ----------------------------------------

/** Next available shot_number within a project (1-based). */
const maxShotNumberStmt = lazy(`SELECT MAX(shot_number) AS m FROM shots WHERE project_id = ?`);
export function nextShotNumber(projectId: string): number {
  const r = maxShotNumberStmt().get(projectId) as { m: number | null } | undefined;
  return (r?.m ?? 0) + 1;
}

const insertShotStmt = lazy(
  `INSERT INTO shots (id, project_id, shot_number, section, lyrics, visual_description, search_query,
      preferred_orientation, min_width, min_height, target_duration_seconds, priority, status, reference_image_url)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'landscape', 1920, 1080, ?, ?, 'SEARCH_PENDING', ?)`,
);
export interface CreateShotInput {
  id: string;
  projectId: string;
  shotNumber: number;
  section: string;
  visualDescription: string;
  searchQuery: string;
  targetDurationSeconds: number | null;
  priority: number;
  lyrics?: string | null;
  referenceImageUrl?: string | null;
}
export function createShot(inp: CreateShotInput): ShotRow {
  insertShotStmt().run(
    inp.id,
    inp.projectId,
    inp.shotNumber,
    inp.section,
    inp.lyrics ?? null,
    inp.visualDescription,
    inp.searchQuery,
    inp.targetDurationSeconds,
    inp.priority,
    inp.referenceImageUrl ?? null,
  );
  return getShot(inp.id)!;
}

const deleteShotStmt = lazy(`DELETE FROM shots WHERE id = ?`);
// shot_assets and edit_metadata reference shots(id) with no ON DELETE action
// (pre-CASCADE DBs), so dependents must be removed first or the delete fails
// with FOREIGN KEY constraint failed.
const deleteShotLinksStmt = lazy(`DELETE FROM shot_assets WHERE shot_id = ?`);
const deleteShotMetadataStmt = lazy(`DELETE FROM edit_metadata WHERE shot_id = ?`);
export function deleteShot(shotId: string): void {
  db.transaction(() => {
    deleteShotLinksStmt().run(shotId);
    deleteShotMetadataStmt().run(shotId);
    deleteShotStmt().run(shotId);
  });
}

const deleteProjectShotLinksStmt = lazy(
  `DELETE FROM shot_assets WHERE shot_id IN (SELECT id FROM shots WHERE project_id = ?)`,
);
const deleteProjectMetadataStmt = lazy(`DELETE FROM edit_metadata WHERE project_id = ?`);
const deleteShotsByProjectStmt = lazy(`DELETE FROM shots WHERE project_id = ?`);
/** Delete every shot in a project plus dependent shot_assets/edit_metadata
 *  rows. Not transactional itself — callers may wrap it in db.transaction. */
export function deleteShotsForProject(projectId: string): void {
  deleteProjectShotLinksStmt().run(projectId);
  deleteProjectMetadataStmt().run(projectId);
  deleteShotsByProjectStmt().run(projectId);
}
