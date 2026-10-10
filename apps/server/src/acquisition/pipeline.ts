// =============================================================================
// Acquisition pipeline (PRD §20)
//
// Per shot:
//   search (Pexels then Pixabay, ≤30 each)
//   → dedupe candidates
//   → technical filter (after probe of downloadUrl metadata; here we use the
//     provider-supplied width/height/duration as a pre-filter, full ffprobe
//     runs after download)
//   → rank
//   → select top N
//   → download top N
//   → thumbnails + pHash + dedup flags
//   → persist + assign to shot
// =============================================================================

import {
  ACQUIRE_COUNT_DEFAULT,
  CANDIDATES_PER_PROVIDER_DEFAULT,
  MAX_POOL_PER_SHOT,
  MIN_ACQUIRE_RATING_DEFAULT,
  MIN_CANDIDATES_PER_SHOT_DEFAULT,
  MIN_DURATION_SECONDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  PROJECT_ID_ALL,
} from "@twio/shared";
import type { AssetCandidate, ProviderName, SearchOptions } from "@twio/shared";
import { config } from "../config.js";
import { resolveProviders } from "../providers/factory.js";
import type { Provider } from "../providers/types.js";
import { allQueries } from "./queryExpansion.js";
import {
  downloadedAssetsForShot,
  existingHashes,
  getAsset,
  getShot,
  listShots,
  listShotsByTimeline,
  primaryShotForAsset,
  markRejected,
  markSelected,
  persistCandidate,
  setShotStatus,
  unusableCandidateIdsForShot,
  updateAsset,
  usableCandidateCountForShot,
} from "../db/repository.js";
import { getProjectRow } from "../db/projectRepository.js";
import type { AssetRow, ProjectRow, ShotRow } from "../db/schema.js";
import { classifyDuplicate } from "../scoring/duplicate.js";
import {
  diversityScore,
  emptyDiversityContext,
  recordSelection,
  type DiversityContext,
} from "../scoring/diversity.js";
import { actionMatchScore, relevanceScore } from "../scoring/relevance.js";
import { rank } from "../scoring/ranker.js";
import { technicalFilter, technicalScore } from "../scoring/technical.js";
import { screenPersonRisk } from "../scoring/personRisk.js";
import { probe, type ProbeResult } from "../video/ffprobe.js";
import { computePHash } from "../video/phash.js";
import { downloadAsset, ourFilename, PauseGate, type DownloadController } from "../video/download.js";
import { generateThumbnail } from "../video/thumbnails.js";
import { classifyLicense } from "../state/machine.js";
import { providerLicenseStatus } from "@twio/shared";

export interface PipelineProgress {
  shotId: string;
  shotNumber: number;
  candidatesFound: number;
  downloaded: number;
  selectedAssetId: string | null;
  status: string;
  error?: string | null;
  downloadErrors?: string[];
}

/** Per-asset download progress, surfaced to the UI for live progress bars. */
export interface AssetDownloadProgress {
  assetId: string;
  assetName: string;
  receivedBytes: number;
  totalBytes: number;
  pct: number; // 0–100 (0 when total unknown)
}

export type AssetProgressCb = (p: AssetDownloadProgress | null) => void;

interface RankedCandidate {
  candidate: AssetCandidate;
  assetId: string;
  license: ReturnType<typeof classifyLicense>;
  finalScore: number;
  diversityScore: number;
  diversityPenalty: boolean;
  diversityReject: boolean;
  rejectionReason: string | null;
}

const providers = resolveProviders();

export function searchOpts(shot: ShotRow, project?: ProjectRow): SearchOptions {
  // candidates_per_provider: there's no per-shot override, so the project
  // value (if set) always wins; otherwise the shared constant default.
  const perPage = project?.candidates_per_provider ?? CANDIDATES_PER_PROVIDER_DEFAULT;
  return {
    orientation: (shot.preferred_orientation ?? "landscape") as "landscape" | "portrait" | "square",
    minWidth: shot.min_width ?? MIN_WIDTH,
    minHeight: shot.min_height ?? MIN_HEIGHT,
    perPage,
  };
}

/** Pre-filter candidates using provider-supplied metadata (before download). */
function preFilter(c: AssetCandidate): boolean {
  if (c.width && c.height && (c.width < MIN_WIDTH || c.height < MIN_HEIGHT)) return false;
  if (c.durationSeconds && c.durationSeconds < MIN_DURATION_SECONDS) return false;
  if (!c.downloadUrl) return false;
  return true;
}

function dedupeCandidates(all: AssetCandidate[]): AssetCandidate[] {
  const seen = new Set<string>();
  const out: AssetCandidate[] = [];
  for (const c of all) {
    const key = `${c.provider}:${c.providerAssetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Resolve the per-shot minimum-candidates floor (X).
 *  Precedence: project.enforce → project value (or constant); else shot override;
 *  else project value (non-enforced); else shared constant. */
export function minCandidatesForShot(shot: ShotRow, project?: ProjectRow): number {
  if (project?.enforce_min_candidates) return project.min_candidates ?? MIN_CANDIDATES_PER_SHOT_DEFAULT;
  if (shot.min_candidates != null) return shot.min_candidates;
  if (project?.min_candidates != null) return project.min_candidates;
  return MIN_CANDIDATES_PER_SHOT_DEFAULT;
}

/** Resolve the per-shot acquire count (Y). Same precedence as X. */
export function acquireCountForShot(shot: ShotRow, project?: ProjectRow): number {
  if (project?.enforce_acquire_count) return project.acquire_count ?? ACQUIRE_COUNT_DEFAULT;
  if (shot.acquire_count != null) return shot.acquire_count;
  if (project?.acquire_count != null) return project.acquire_count;
  return ACQUIRE_COUNT_DEFAULT;
}

/** Resolve the per-shot minimum acquire rating (Z, 0..1). Same precedence. */
export function minAcquireRatingForShot(shot: ShotRow, project?: ProjectRow): number {
  if (project?.enforce_min_acquire_rating) return project.min_acquire_rating ?? MIN_ACQUIRE_RATING_DEFAULT;
  if (shot.min_acquire_rating != null) return shot.min_acquire_rating;
  if (project?.min_acquire_rating != null) return project.min_acquire_rating;
  return MIN_ACQUIRE_RATING_DEFAULT;
}

export async function searchShot(
  shot: ShotRow,
  project?: ProjectRow,
  opts: { tolerateProviderFailure?: boolean; warnings?: string[] } = {},
): Promise<AssetCandidate[]> {
  const providerOpts = searchOpts(shot, project);
  const queries = allQueries(shot.search_query);
  // Priority order step 1: fetch a MINIMUM of X candidates per shot. Keep
  // expanding query variants (across both providers) until the deduped pool
  // reaches X or every expansion is exhausted. If the pool is still < X after
  // all expansions, we proceed with what we have (non-fatal — logged).
  const minCandidates = minCandidatesForShot(shot, project);
  const pool: AssetCandidate[] = [];
  const failures: string[] = [];

  // Pexels then Pixabay (PRD §10). A failed provider signals an error — there
  // is no mock fallback and no silent degradation.
  const providerList = [providers.pexels, providers.pixabay] as Provider[];

  // Primary query first, from every provider.
  for (const provider of providerList) {
    try {
      pool.push(...(await provider.search(shot.search_query, providerOpts)));
    } catch (e) {
      failures.push(`${provider.id}:${(e as Error).message}`);
    }
  }

  // If the primary query didn't reach the floor, walk the expansions across
  // all providers, stopping once the deduped pool >= X (capped at MAX_POOL).
  const expansions = queries.slice(1);
  for (const q of expansions) {
    if (dedupeCandidates(pool).length >= minCandidates) break;
    if (pool.length >= MAX_POOL_PER_SHOT) break;
    for (const provider of providerList) {
      if (pool.length >= MAX_POOL_PER_SHOT) break;
      try {
        pool.push(...(await provider.search(q, providerOpts)));
      } catch (e) {
        failures.push(`${provider.id}:${q}: ${(e as Error).message}`);
      }
    }
  }

  const deduped = dedupeCandidates(pool);
  if (deduped.length === 0) {
    // No usable results at all — always an error, never a silent pass.
    throw new Error(
      failures.length > 0
        ? `Search failed for ${shot.id}: ${failures.join(" | ")}`
        : `Search returned zero candidates for ${shot.id} (query: "${shot.search_query}") — both providers returned empty.`,
    );
  }
  if (failures.length > 0) {
    // A provider failed but the remaining provider(s) still returned real
    // candidates. Strict callers (acquire-all, single-shot acquire) treat any
    // provider failure as an error — never silently degrade. The timeline
    // fetch opts into tolerance so a partial provider outage can't zero out a
    // shot; the failure is still surfaced as a warning.
    if (!opts.tolerateProviderFailure) {
      throw new Error(`Search failed for ${shot.id}: ${failures.join(" | ")}`);
    }
    const msg = `${shot.id}: ${failures.join(" | ")} — continuing with ${deduped.length} candidate(s) from the remaining provider(s)`;
    console.warn(`[search] ${msg}`);
    opts.warnings?.push(msg);
  }
  if (deduped.length < minCandidates) {
    // Non-fatal shortfall: proceed with what we have, but surface it so the
    // user can see which shots fell short of the requested minimum.
    console.warn(
      `[search] ${shot.id}: only ${deduped.length} candidates found (min requested ${minCandidates}) — proceeding with available pool.`,
    );
  }
  return deduped.slice(0, MAX_POOL_PER_SHOT); // max 60 (PRD §10)
}

/** Rank all candidates for a shot (P1 heuristics). */
export function rankCandidates(
  shot: ShotRow,
  candidates: AssetCandidate[],
  ctx: DiversityContext,
  projectId = shot.project_id,
): RankedCandidate[] {
  const queries = allQueries(shot.search_query);
  const existing = existingHashes(projectId);
  const ranked: RankedCandidate[] = [];

  for (const c of candidates) {
    const providerPolicy = providerLicenseStatus(c.provider);
    const license = classifyLicense(c.sourceLicense, providerPolicy);
    const { personRisk, reason: personReason } = screenPersonRisk(shot.search_query, c.tags);

    // Pre-filter hard rejections.
    let hardRejection: string | null = null;
    if (license === "UNKNOWN" || license === "NOT_APPROVED") {
      hardRejection = "license_unknown_or_not_approved";
    }
    if (c.width && c.height && (c.width < MIN_WIDTH || c.height < MIN_HEIGHT)) {
      hardRejection = "resolution_too_low";
    }

    // Build a synthetic ProbeResult from provider metadata for ranking (the
    // real probe runs after download to confirm).
    const fakeProbe: ProbeResult = {
      streams: [],
      format: {},
      video: { width: c.width, height: c.height, duration: String(c.durationSeconds), r_frame_rate: c.fps ? `${c.fps}/1` : undefined },
      width: c.width,
      height: c.height,
      rotation: 0,
      durationSeconds: c.durationSeconds,
      fps: c.fps,
      codec: null,
      container: null,
      sizeBytes: null,
    };
    const tf = technicalFilter(fakeProbe);
    if (!tf.passed && !hardRejection) hardRejection = tf.reasons.join("; ");

    const tScore = technicalScore(fakeProbe, tf.orientation, tf.aspectFlag, (shot.preferred_orientation ?? "landscape") as "landscape" | "portrait" | "square", shot.target_duration_seconds ?? undefined);
    const rScore = relevanceScore(shot.search_query, queries.slice(1), c);
    const aScore = actionMatchScore(shot.search_query, c);

    // Diversity (uses a minimal AssetRow stub).
    const stub: AssetRow = {
      id: `${c.provider.toUpperCase()}_${c.providerAssetId}`,
      provider_id: c.provider,
      provider_asset_id: c.providerAssetId,
      creator_name: c.creatorName,
      perceptual_hash: null,
      width: c.width, height: c.height, duration_seconds: c.durationSeconds, fps: c.fps,
    } as unknown as AssetRow;
    const div = diversityScore(stub, ctx, null);

    const r = rank({
      relevanceScore: rScore,
      visualQualityScore: tScore, // P1 substitution (PRD §19)
      technicalScore: tScore,
      diversityScore: div.score,
      actionMatchScore: aScore,
      licenseStatus: license,
      hardRejection: hardRejection,
    });

    // Duplicate classification (L2 pre-download using provider+assetId).
    const dup = classifyDuplicate(
      { sha256: null, provider: c.provider, providerAssetId: c.providerAssetId, perceptualHash: null },
      { sha256s: existing.sha256s, sourceIds: existing.sourceIds, perceptualHashes: existing.perceptualHashes, threshold: config.phashHammingThreshold },
    );

    ranked.push({
      candidate: c,
      assetId: `${c.provider.toUpperCase()}_${c.providerAssetId}`,
      license,
      finalScore: r.finalScore,
      diversityScore: div.score,
      diversityPenalty: div.penaltyApplied,
      diversityReject: div.reject && !hardRejection,
      rejectionReason: hardRejection ?? (div.reject ? div.reason : null) ?? (dup.flag === "SAME_SOURCE" || dup.flag === "EXACT" ? `duplicate:${dup.flag}` : null),
    });
    void personRisk;
    void personReason;
  }

  // Sort by final score desc; rejected ones go last.
  ranked.sort((a, b) => {
    if (!!a.rejectionReason !== !!b.rejectionReason) return a.rejectionReason ? 1 : -1;
    return b.finalScore - a.finalScore;
  });
  return ranked;
}

/** Run the full acquisition for a single shot.
 *
 * By default (`download: false`) this only searches providers, ranks and
 * persists candidates — nothing is downloaded. Clips are downloaded later, on
 * demand, when a human KEEPs a candidate in review (the KEEP route enqueues a
 * tracked download task). Pass `{ download: true }` to restore the legacy
 * "download top-Y candidates immediately" behavior. */
export async function acquireShot(
  shotId: string,
  ctx: DiversityContext = emptyDiversityContext(),
  onAssetProgress?: AssetProgressCb,
  controller?: DownloadController,
  opts: {
    download?: boolean;
    maxCandidates?: number;
    /** Timeline-fetch mode: one provider failing doesn't fail the shot when
     *  the other still returned candidates (failures surface via `warnings`). */
    tolerateProviderFailure?: boolean;
    warnings?: string[];
  } = {},
): Promise<PipelineProgress> {
  const shot = getShot(shotId);
  if (!shot) throw new Error(`Shot not found: ${shotId}`);
  const projectId = shot.project_id;
  const project = getProjectRow(projectId); // may be undefined for legacy rows
  setShotStatus(shotId, "SEARCHING");
  const progress: PipelineProgress = {
    shotId,
    shotNumber: shot.shot_number,
    candidatesFound: 0,
    downloaded: 0,
    selectedAssetId: null,
    status: "SEARCH_PENDING",
    downloadErrors: [],
  };

  let candidates: AssetCandidate[];
  try {
    candidates = await searchShot(shot, project, {
      tolerateProviderFailure: opts.tolerateProviderFailure,
      warnings: opts.warnings,
    });
  } catch (e) {
    setShotStatus(shotId, "FAILED");
    progress.status = "FAILED";
    progress.error = (e as Error).message;
    // Re-throw so the caller knows the search failed — no silent fallback.
    throw e;
  }
  progress.candidatesFound = candidates.length;
  setShotStatus(shotId, "SEARCHED");

  if (controller?.signal.aborted) {
    progress.status = "CANCELLED";
    setShotStatus(shotId, "CANCELLED");
    return progress;
  }

  const ranked = rankCandidates(shot, candidates, ctx, projectId);
  setShotStatus(shotId, "ACQUIRING");

  // Persist candidates (PRD: keep the pool). maxCandidates caps the pool to
  // the top-ranked N — used by the timeline "fetch videos" rail. On a re-run,
  // candidates already linked to this shot as unusable (link- or
  // asset-rejected) can't fill the rail, so the cap skips them — a partial
  // previous run is topped up with genuinely usable candidates instead of
  // re-persisting the same rejected ones.
  const skipIds = opts.maxCandidates != null ? unusableCandidateIdsForShot(shotId) : null;
  const toPersist = opts.maxCandidates != null
    ? ranked.filter((rc) => !skipIds!.has(rc.assetId)).slice(0, Math.max(0, opts.maxCandidates))
    : ranked;
  for (let i = 0; i < toPersist.length; i++) {
    if (controller?.signal.aborted) {
      progress.status = "CANCELLED";
      setShotStatus(shotId, "CANCELLED");
      return progress;
    }
    await controller?.waitIfPaused();
    const rc = toPersist[i]!;
    persistCandidate(shotId, i + 1, rc.candidate, projectId);
  }

  // Priority order step 2: acquire up to Y candidates whose finalScore >= Z.
  // Y and Z are per-shot overrides (shots.acquire_count / min_acquire_rating),
  // falling back to the shared defaults when NULL.
  // With opts.download off (default), nothing is downloaded here — KEEPing a
  // candidate in review is what triggers its download task.
  const acquireCount = acquireCountForShot(shot, project);
  const minRating = minAcquireRatingForShot(shot, project);
  const toDownload = opts.download === true
    ? ranked
        .filter((r) => !r.rejectionReason && r.finalScore >= minRating)
        .slice(0, acquireCount)
    : [];

  // Skip assets already downloaded for this shot on repeat acquisition runs.
  // The candidate row is still re-persisted (refreshes rank / discovery
  // metadata), but the file is not re-fetched and post-processing is not
  // re-run. The existing asset row is left untouched.
  const alreadyDownloaded = toDownload.length > 0
    ? downloadedAssetsForShot(shotId, projectId)
    : new Map<string, AssetRow>();

  let selected: string | null = null;
  for (const rc of toDownload) {
    if (controller?.signal.aborted) break;
    if (alreadyDownloaded.has(rc.assetId)) {
      const existing = alreadyDownloaded.get(rc.assetId)!;
      if (existing.commercial_status !== "REJECTED") {
        progress.downloaded++;
        if (!selected) {
          // Preserve the previously auto-selected asset so review state is
          // stable across re-runs.
          markSelected(shotId, rc.assetId);
          selected = rc.assetId;
          recordSelection(
            { id: rc.assetId, creator_name: rc.candidate.creatorName, perceptual_hash: existing.perceptual_hash } as unknown as AssetRow,
            ctx,
            existing.perceptual_hash,
          );
        }
      }
      continue;
    }
    try {
      const assetName = ourFilename(shot.shot_number, rc.candidate.provider, rc.candidate.providerAssetId);
      const dl = await downloadAsset(
        rc.candidate.downloadUrl,
        shot.shot_number,
        shot.section,
        rc.candidate.provider,
        rc.candidate.providerAssetId,
        "video/*",
        (received, total) => onAssetProgress?.({
          assetId: rc.assetId,
          assetName,
          receivedBytes: received,
          totalBytes: total,
          pct: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        }),
        { projectSlug: project?.slug ?? projectId, searchQuery: shot.search_query },
        controller,
      );
      onAssetProgress?.(null);
      // Confirm with real ffprobe (PRD §34).
      const realProbe = await probe(dl.localPath);
      const tf = technicalFilter(realProbe);
      if (!tf.passed) {
        markRejected(shotId, rc.assetId, `technical_filter: ${tf.reasons.join("; ")}`);
        updateAsset(rc.assetId, {
          localPath: dl.relativePath,
          sha256: dl.sha256,
          perceptualHash: null,
          duplicateFlag: "NONE",
          aspectFlag: tf.aspectFlag,
          width: realProbe.width,
          height: realProbe.height,
          durationSeconds: realProbe.durationSeconds,
          fps: realProbe.fps,
          orientation: tf.orientation,
          downloadedAt: new Date().toISOString(),
          commercialStatus: "REJECTED",
          rightsReviewStatus: "REJECTED",
          aiRelevanceScore: null,
          technicalScore: technicalScore(realProbe, tf.orientation, tf.aspectFlag, (shot.preferred_orientation ?? "landscape") as "landscape" | "portrait" | "square", shot.target_duration_seconds ?? undefined),
          duplicateScore: 1,
          finalScore: rc.finalScore,
          diversityPenaltyApplied: rc.diversityPenalty ? 1 : 0,
          notes: `technical_filter_failed: ${tf.reasons.join("; ")}`,
        });
        continue;
      }

      // pHash + dedup L1/L3 (PRD §16).
      let pHash: string | null = null;
      try {
        pHash = await computePHash(dl.localPath);
      } catch (e) {
        console.warn(`[pipeline] pHash failed for ${rc.assetId}: ${(e as Error).message}`);
      }
      const existing = existingHashes(projectId);
      const dup = classifyDuplicate(
        { sha256: dl.sha256, provider: rc.candidate.provider, providerAssetId: rc.candidate.providerAssetId, perceptualHash: pHash },
        { sha256s: existing.sha256s, sourceIds: existing.sourceIds, perceptualHashes: existing.perceptualHashes, threshold: config.phashHammingThreshold },
      );

      // Thumbnail (PRD §21).
      const thumbPath = await generateThumbnail(dl.localPath, rc.assetId);

      // Person-risk screening — informational only for providers whose license
      // is already LICENSE_SOURCE_CONFIRMED (Pexels/Pixabay are free for
      // commercial use, no verification needed). For providers with
      // RIGHTS_REVIEW_REQUIRED policy (e.g. Mixkit), person-risk still routes
      // to HUMAN_REVIEW_REQUIRED.
      const personScreen = screenPersonRisk(shot.search_query, rc.candidate.tags);
      let commercialStatus = "LICENSE_SOURCE_CONFIRMED";
      let rightsReviewStatus = "OK";
      if (rc.license === "RIGHTS_REVIEW_REQUIRED") {
        commercialStatus = "HUMAN_REVIEW_REQUIRED";
        rightsReviewStatus = "REVIEW";
      }
      if (dup.flag === "EXACT" || dup.flag === "SAME_SOURCE") {
        commercialStatus = "REJECTED";
        rightsReviewStatus = "REJECTED";
        markRejected(shotId, rc.assetId, `duplicate:${dup.flag}`);
      }

      const realTechScore = technicalScore(realProbe, tf.orientation, tf.aspectFlag, (shot.preferred_orientation ?? "landscape") as "landscape" | "portrait" | "square", shot.target_duration_seconds ?? undefined);
      const div = diversityScore(
        { id: rc.assetId, creator_name: rc.candidate.creatorName, perceptual_hash: pHash } as unknown as AssetRow,
        ctx,
        pHash,
      );

      updateAsset(rc.assetId, {
        localPath: dl.relativePath,
        sha256: dl.sha256,
        perceptualHash: pHash,
        duplicateFlag: dup.flag,
        aspectFlag: tf.aspectFlag,
        width: realProbe.width,
        height: realProbe.height,
        durationSeconds: realProbe.durationSeconds,
        fps: realProbe.fps,
        orientation: tf.orientation,
        downloadedAt: new Date().toISOString(),
        commercialStatus,
        rightsReviewStatus,
        aiRelevanceScore: rank({
          relevanceScore: relevanceScore(shot.search_query, allQueries(shot.search_query).slice(1), rc.candidate),
          visualQualityScore: realTechScore,
          technicalScore: realTechScore,
          diversityScore: div.score,
          actionMatchScore: actionMatchScore(shot.search_query, rc.candidate),
          licenseStatus: rc.license,
          hardRejection: null,
        }).finalScore,
        technicalScore: realTechScore,
        duplicateScore: dup.flag === "NONE" ? 1 : 0,
        finalScore: rc.finalScore,
        diversityPenaltyApplied: div.penaltyApplied ? 1 : 0,
        notes: dup.flag !== "NONE" ? `duplicate:${dup.flag}` : personScreen.reason ?? null,
      });
      void thumbPath;

      if (commercialStatus !== "REJECTED") {
        progress.downloaded++;
        if (!selected) {
          // The top-scoring non-rejected downloaded asset is auto-selected as
          // the candidate for review (NOT auto-approved — human must KEEP it).
          markSelected(shotId, rc.assetId);
          selected = rc.assetId;
          recordSelection(
            { id: rc.assetId, creator_name: rc.candidate.creatorName, perceptual_hash: pHash } as unknown as AssetRow,
            ctx,
            pHash,
          );
        }
      }
    } catch (e) {
      const msg = `download_failed for ${rc.assetId}: ${(e as Error).message}`;
      console.warn(`[pipeline] ${msg}`);
      progress.downloadErrors!.push(msg);
      markRejected(shotId, rc.assetId, `download_failed: ${(e as Error).message}`);
    }
  }

  progress.selectedAssetId = selected;
  // Without downloads, REVIEW just means "there are candidates to review".
  progress.status = selected || progress.downloaded > 0 || progress.candidatesFound > 0 ? "REVIEW" : "FAILED";
  if (progress.downloadErrors!.length > 0 && !selected) {
    progress.error = `${progress.downloadErrors!.length} download(s) failed: ${progress.downloadErrors!.join("; ")}`;
  }
  if (progress.status === "FAILED" && progress.candidatesFound === 0) {
    progress.error = "no candidates found";
  }
  setShotStatus(shotId, progress.status);
  return progress;
}

/** Run acquisition for all 100 shots. */
export interface AcquireAllProgress {
  running: boolean;
  total: number;
  completed: number;
  currentShotId: string | null;
  currentAsset: AssetDownloadProgress | null;
  results: PipelineProgress[];
  startedAt: string | null;
  error: string | null;
  shotErrors: string[];
}
export const acquireAllProgress: AcquireAllProgress = {
  running: false, total: 0, completed: 0, currentShotId: null, currentAsset: null, results: [], startedAt: null, error: null, shotErrors: [],
};

/** Progress for a single-shot acquire (polled by the review UI). */
export interface AcquireShotProgress {
  running: boolean;
  paused: boolean;
  shotId: string | null;
  currentAsset: AssetDownloadProgress | null;
  lastResult: PipelineProgress | null;
  error: string | null;
}
export const acquireShotProgress: AcquireShotProgress = {
  running: false, paused: false, shotId: null, currentAsset: null, lastResult: null, error: null,
};

export async function acquireAll(
  onProgress?: (p: PipelineProgress) => void,
  projectId: string = PROJECT_ID_ALL,
): Promise<PipelineProgress[]> {
  const shots = listShots(projectId);
  const ctx = emptyDiversityContext();
  const results: PipelineProgress[] = [];
  acquireAllProgress.running = true;
  acquireAllProgress.total = shots.length;
  acquireAllProgress.completed = 0;
  acquireAllProgress.currentShotId = null;
  acquireAllProgress.currentAsset = null;
  acquireAllProgress.results = [];
  acquireAllProgress.startedAt = new Date().toISOString();
  acquireAllProgress.error = null;
  acquireAllProgress.shotErrors = [];
  try {
    for (const shot of shots) {
      acquireAllProgress.currentShotId = shot.id;
      try {
        const p = await acquireShot(shot.id, ctx, (ap) => {
          acquireAllProgress.currentAsset = ap;
        });
        results.push(p);
        acquireAllProgress.results.push(p);
        acquireAllProgress.completed++;
        if (p.error) {
          acquireAllProgress.shotErrors.push(`${p.shotId}: ${p.error}`);
        }
        onProgress?.(p);
        console.log(`[acquire] ${p.shotId} (shot ${p.shotNumber}/${shots.length}): ${p.status} — ${p.candidatesFound} found, ${p.downloaded} downloaded`);
      } catch (e) {
        // Record the error and continue — the UI surfaces shotErrors so the
        // user sees exactly which shots failed and why.
        const msg = `${shot.id}: ${(e as Error).message}`;
        acquireAllProgress.shotErrors.push(msg);
        console.error(`[acquire] shot ${shot.id} failed: ${(e as Error).message}`);
        // Push a FAILED result so the count stays consistent.
        const failedProgress: PipelineProgress = {
          shotId: shot.id,
          shotNumber: shot.shot_number,
          candidatesFound: 0,
          downloaded: 0,
          selectedAssetId: null,
          status: "FAILED",
          error: (e as Error).message,
          downloadErrors: [],
        };
        results.push(failedProgress);
        acquireAllProgress.results.push(failedProgress);
        acquireAllProgress.completed++;
      }
    }
  } finally {
    acquireAllProgress.running = false;
    acquireAllProgress.currentShotId = null;
    acquireAllProgress.currentAsset = null;
    if (acquireAllProgress.shotErrors.length > 0) {
      acquireAllProgress.error = `${acquireAllProgress.shotErrors.length} shot(s) failed`;
    }
  }
  return results;
}

/**
 * Run acquisition for a single shot in the background, updating
 * `acquireShotProgress` so the UI can poll per-asset download progress.
 * The run gets a DownloadController so the UI can pause / resume / cancel it.
 */
let shotAcquireCtl: { abort: AbortController; gate: PauseGate } | null = null;

export function acquireShotBackground(shotId: string): { started: boolean } | { alreadyRunning: boolean } {
  if (acquireShotProgress.running) return { alreadyRunning: true };
  if (acquireAllProgress.running) return { alreadyRunning: true };
  const abort = new AbortController();
  const gate = new PauseGate(abort.signal);
  shotAcquireCtl = { abort, gate };
  const controller: DownloadController = {
    signal: abort.signal,
    isPaused: () => gate.isPaused(),
    waitIfPaused: () => gate.waitIfPaused(),
  };
  acquireShotProgress.running = true;
  acquireShotProgress.paused = false;
  acquireShotProgress.shotId = shotId;
  acquireShotProgress.currentAsset = null;
  acquireShotProgress.lastResult = null;
  acquireShotProgress.error = null;
  acquireShot(shotId, emptyDiversityContext(), (ap) => {
    acquireShotProgress.currentAsset = ap;
  }, controller)
    .then((p) => {
      acquireShotProgress.lastResult = p;
      if (p.error) {
        acquireShotProgress.error = p.error;
      }
    })
    .catch((e) => {
      const msg = (e as Error).message;
      console.error(`[acquire shot ${shotId}] fatal: ${msg}`);
      acquireShotProgress.error = msg;
    })
    .finally(() => {
      acquireShotProgress.running = false;
      acquireShotProgress.paused = false;
      acquireShotProgress.shotId = null;
      acquireShotProgress.currentAsset = null;
      shotAcquireCtl = null;
    });
  return { started: true };
}

/** Cancel the running single-shot acquire (the search/persist phase). */
export function cancelShotAcquire(shotId?: string): { ok: boolean } {
  if (!acquireShotProgress.running) return { ok: false };
  if (shotId && acquireShotProgress.shotId !== shotId) return { ok: false };
  shotAcquireCtl?.abort.abort();
  return { ok: true };
}

export function pauseShotAcquire(shotId?: string): { ok: boolean } {
  if (!acquireShotProgress.running) return { ok: false };
  if (shotId && acquireShotProgress.shotId !== shotId) return { ok: false };
  shotAcquireCtl?.gate.pause();
  acquireShotProgress.paused = true;
  return { ok: true };
}

export function resumeShotAcquire(shotId?: string): { ok: boolean } {
  if (!acquireShotProgress.running) return { ok: false };
  if (shotId && acquireShotProgress.shotId !== shotId) return { ok: false };
  shotAcquireCtl?.gate.resume();
  acquireShotProgress.paused = false;
  return { ok: true };
}

// =============================================================================
// Timeline "fetch videos" — run candidate discovery for every shot of one
// timeline (search + persist, no downloads). Driven by the Timeline page;
// kept clips then download on demand via the review route.
// =============================================================================

export interface TimelineFetchProgress {
  running: boolean;
  paused: boolean;
  timelineId: string | null;
  total: number;
  completed: number;
  currentShotId: string | null;
  /** The requested candidates-per-shot this run is topping up to. */
  maxPerShot: number;
  /** Candidates persisted so far (capped per shot by maxPerShot). */
  persisted: number;
  /** Shots that ended the run with >= maxPerShot usable candidates —
   *  either already satisfied before the run or topped up by it. */
  satisfied: number;
  error: string | null;
  shotErrors: string[];
  /** Non-fatal issues: provider partial failures tolerated mid-run and
   *  shots that still can't reach the requested candidate count. */
  warnings: string[];
}
export const timelineFetchProgress: TimelineFetchProgress = {
  running: false, paused: false, timelineId: null, total: 0, completed: 0,
  currentShotId: null, maxPerShot: 0, persisted: 0, satisfied: 0, error: null,
  shotErrors: [], warnings: [],
};

let timelineFetchCtl: { abort: AbortController; gate: PauseGate } | null = null;

export function fetchTimelineBackground(
  timelineId: string,
  maxPerShot: number,
): { started: boolean; total?: number } | { alreadyRunning: boolean } {
  if (timelineFetchProgress.running || acquireShotProgress.running || acquireAllProgress.running) {
    return { alreadyRunning: true };
  }
  const shots = listShotsByTimeline(timelineId);
  const abort = new AbortController();
  const gate = new PauseGate(abort.signal);
  timelineFetchCtl = { abort, gate };
  const controller: DownloadController = {
    signal: abort.signal,
    isPaused: () => gate.isPaused(),
    waitIfPaused: () => gate.waitIfPaused(),
  };
  Object.assign(timelineFetchProgress, {
    running: true, paused: false, timelineId, total: shots.length,
    completed: 0, currentShotId: null, maxPerShot, persisted: 0, satisfied: 0,
    error: null, shotErrors: [], warnings: [],
  });
  (async () => {
    for (const shot of shots) {
      if (controller.signal.aborted) break;
      await controller.waitIfPaused();
      if (controller.signal.aborted) break;
      timelineFetchProgress.currentShotId = shot.id;
      try {
        // Completion-oriented: every shot must end the run showing
        // maxPerShot usable candidates. A shot already at the requested
        // count (e.g. from an earlier run) is skipped — a re-run after a
        // partial failure only tops up the shots left short instead of
        // re-burning provider calls on satisfied ones.
        if (usableCandidateCountForShot(shot.id) >= maxPerShot) {
          timelineFetchProgress.satisfied++;
        } else {
          const p = await acquireShot(shot.id, emptyDiversityContext(), undefined, controller, {
            maxCandidates: maxPerShot,
            tolerateProviderFailure: true,
            warnings: timelineFetchProgress.warnings,
          });
          timelineFetchProgress.persisted += Math.min(p.candidatesFound, maxPerShot);
          const usable = usableCandidateCountForShot(shot.id);
          if (usable >= maxPerShot) {
            timelineFetchProgress.satisfied++;
          } else {
            timelineFetchProgress.warnings.push(
              `${shot.id}: only ${usable}/${maxPerShot} candidates available`,
            );
          }
        }
      } catch (e) {
        timelineFetchProgress.shotErrors.push(`${shot.id}: ${(e as Error).message}`);
      }
      timelineFetchProgress.completed++;
    }
  })()
    .catch((e) => {
      timelineFetchProgress.error = (e as Error).message;
      console.error(`[timeline-fetch] fatal: ${timelineFetchProgress.error}`);
    })
    .finally(() => {
      timelineFetchProgress.running = false;
      timelineFetchProgress.paused = false;
      timelineFetchProgress.currentShotId = null;
      timelineFetchCtl = null;
    });
  return { started: true, total: shots.length };
}

export function cancelTimelineFetch(timelineId?: string): { ok: boolean } {
  if (!timelineFetchProgress.running) return { ok: false };
  if (timelineId && timelineFetchProgress.timelineId !== timelineId) return { ok: false };
  timelineFetchCtl?.abort.abort();
  return { ok: true };
}

export function pauseTimelineFetch(timelineId?: string): { ok: boolean } {
  if (!timelineFetchProgress.running) return { ok: false };
  if (timelineId && timelineFetchProgress.timelineId !== timelineId) return { ok: false };
  timelineFetchCtl?.gate.pause();
  timelineFetchProgress.paused = true;
  return { ok: true };
}

export function resumeTimelineFetch(timelineId?: string): { ok: boolean } {
  if (!timelineFetchProgress.running) return { ok: false };
  if (timelineId && timelineFetchProgress.timelineId !== timelineId) return { ok: false };
  timelineFetchCtl?.gate.resume();
  timelineFetchProgress.paused = false;
  return { ok: true };
}

// =============================================================================
// Acquire a single discovered asset by id (search-page acquisition)
//
// Downloads an already-discovered asset row (one that has a download_url but
// no local_path), runs the full post-processing pipeline (ffprobe → technical
// filter → pHash → dedup → thumbnail → scoring), and updates the asset row.
//
// The destination folder/filename is derived from the asset's primary shot
// (if linked via shot_assets) so the file lands in the right section folder.
// If the asset is not linked to any shot, it goes to a "SEARCH" section folder
// with shot_number 0.
// =============================================================================

const SEARCH_SECTION = "SEARCH";
const SEARCH_SHOT_NUMBER = 0;

export interface AcquireAssetResult {
  assetId: string;
  status: "downloaded" | "already_downloaded" | "rejected" | "failed";
  error?: string;
  reason?: string;
}

export async function acquireAssetById(
  assetId: string,
  onAssetProgress?: AssetProgressCb,
  controller?: DownloadController,
): Promise<AcquireAssetResult> {
  const asset = getAsset(assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  if (asset.local_path) return { assetId, status: "already_downloaded" };
  if (!asset.download_url) throw new Error(`Asset ${assetId} has no download_url`);

  const projectId = asset.project_id;

  // Resolve the destination section + shot number from the primary shot, if
  // the asset is linked to one. Otherwise use the SEARCH fallback.
  const shot = primaryShotForAsset(assetId);
  const shotNumber = shot?.shot_number ?? SEARCH_SHOT_NUMBER;
  const section = shot?.section ?? SEARCH_SECTION;

  const provider = asset.provider_id;
  const providerAssetId = asset.provider_asset_id ?? asset.id;

  try {
    const assetName = ourFilename(shotNumber, provider, providerAssetId);
    const dl = await downloadAsset(
      asset.download_url,
      shotNumber,
      section,
      provider,
      providerAssetId,
      "video/*",
      (received, total) => onAssetProgress?.({
        assetId,
        assetName,
        receivedBytes: received,
        totalBytes: total,
        pct: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
      }),
      { projectSlug: getProjectRow(projectId)?.slug ?? projectId, searchQuery: shot?.search_query },
      controller,
    );
    onAssetProgress?.(null);

    // Confirm with real ffprobe (PRD §34).
    const realProbe = await probe(dl.localPath);
    const tf = technicalFilter(realProbe);
    if (!tf.passed) {
      updateAsset(assetId, {
        localPath: dl.relativePath,
        sha256: dl.sha256,
        perceptualHash: null,
        duplicateFlag: "NONE",
        aspectFlag: tf.aspectFlag,
        width: realProbe.width,
        height: realProbe.height,
        durationSeconds: realProbe.durationSeconds,
        fps: realProbe.fps,
        orientation: tf.orientation,
        downloadedAt: new Date().toISOString(),
        commercialStatus: "REJECTED",
        rightsReviewStatus: "REJECTED",
        aiRelevanceScore: null,
        technicalScore: technicalScore(realProbe, tf.orientation, tf.aspectFlag, "landscape", undefined),
        duplicateScore: 1,
        finalScore: asset.final_score,
        diversityPenaltyApplied: 0,
        notes: `technical_filter_failed: ${tf.reasons.join("; ")}`,
      });
      return { assetId, status: "rejected", reason: `technical_filter: ${tf.reasons.join("; ")}` };
    }

    // pHash + dedup L1/L3 (PRD §16).
    let pHash: string | null = null;
    try {
      pHash = await computePHash(dl.localPath);
    } catch (e) {
      console.warn(`[acquire-asset] pHash failed for ${assetId}: ${(e as Error).message}`);
    }
    const existing = existingHashes(projectId);
    const dup = classifyDuplicate(
      { sha256: dl.sha256, provider, providerAssetId: asset.provider_asset_id, perceptualHash: pHash },
      { sha256s: existing.sha256s, sourceIds: existing.sourceIds, perceptualHashes: existing.perceptualHashes, threshold: config.phashHammingThreshold },
    );

    // Thumbnail (PRD §21).
    await generateThumbnail(dl.localPath, assetId);

    // License classification — reuse the asset's existing commercial_status
    // if it was already classified at persist time, otherwise classify now.
    const providerPolicy = providerLicenseStatus(provider as ProviderName);
    const license = classifyLicense(asset.source_license, providerPolicy);
    let commercialStatus = "LICENSE_SOURCE_CONFIRMED";
    let rightsReviewStatus = "OK";
    if (license === "RIGHTS_REVIEW_REQUIRED") {
      commercialStatus = "HUMAN_REVIEW_REQUIRED";
      rightsReviewStatus = "REVIEW";
    }
    if (dup.flag === "EXACT" || dup.flag === "SAME_SOURCE") {
      commercialStatus = "REJECTED";
      rightsReviewStatus = "REJECTED";
    }

    const realTechScore = technicalScore(realProbe, tf.orientation, tf.aspectFlag, "landscape", undefined);

    updateAsset(assetId, {
      localPath: dl.relativePath,
      sha256: dl.sha256,
      perceptualHash: pHash,
      duplicateFlag: dup.flag,
      aspectFlag: tf.aspectFlag,
      width: realProbe.width,
      height: realProbe.height,
      durationSeconds: realProbe.durationSeconds,
      fps: realProbe.fps,
      orientation: tf.orientation,
      downloadedAt: new Date().toISOString(),
      commercialStatus,
      rightsReviewStatus,
      aiRelevanceScore: asset.ai_relevance_score,
      technicalScore: realTechScore,
      duplicateScore: dup.flag === "NONE" ? 1 : 0,
      finalScore: asset.final_score,
      diversityPenaltyApplied: 0,
      notes: dup.flag !== "NONE" ? `duplicate:${dup.flag}` : asset.notes,
    });

    if (commercialStatus === "REJECTED") {
      return { assetId, status: "rejected", reason: `duplicate:${dup.flag}` };
    }
    return { assetId, status: "downloaded" };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[acquire-asset] failed for ${assetId}: ${msg}`);
    return { assetId, status: "failed", error: msg };
  }
}

// --- Background acquire-asset with progress polling -------------------------

export interface AcquireAssetProgress {
  running: boolean;
  assetId: string | null;
  currentAsset: AssetDownloadProgress | null;
  lastResult: AcquireAssetResult | null;
  error: string | null;
}
export const acquireAssetProgress: AcquireAssetProgress = {
  running: false, assetId: null, currentAsset: null, lastResult: null, error: null,
};

/** Run acquireAssetById in the background, updating acquireAssetProgress. */
export function acquireAssetBackground(assetId: string): { started: boolean } | { alreadyRunning: boolean } {
  if (acquireAssetProgress.running) return { alreadyRunning: true };
  acquireAssetProgress.running = true;
  acquireAssetProgress.assetId = assetId;
  acquireAssetProgress.currentAsset = null;
  acquireAssetProgress.lastResult = null;
  acquireAssetProgress.error = null;
  acquireAssetById(assetId, (ap) => {
    acquireAssetProgress.currentAsset = ap;
  })
    .then((r) => {
      acquireAssetProgress.lastResult = r;
      if (r.status === "failed" && r.error) acquireAssetProgress.error = r.error;
    })
    .catch((e) => {
      const msg = (e as Error).message;
      console.error(`[acquire asset ${assetId}] fatal: ${msg}`);
      acquireAssetProgress.error = msg;
    })
    .finally(() => {
      acquireAssetProgress.running = false;
      acquireAssetProgress.assetId = null;
      acquireAssetProgress.currentAsset = null;
    });
  return { started: true };
}

// --- Background batch acquire (Acquire All on the search page) --------------

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

export const acquireBatchProgress: AcquireBatchProgress = {
  running: false,
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  currentAssetId: null,
  currentAsset: null,
  results: [],
  error: null,
};

/** Acquire multiple discovered assets sequentially in the background. Updates
 *  acquireBatchProgress so the frontend can poll overall progress. Skips
 *  assets that are already downloaded. */
export function acquireAssetsBatchBackground(assetIds: string[]): { started: boolean } | { alreadyRunning: boolean } {
  if (acquireBatchProgress.running) return { alreadyRunning: true };
  acquireBatchProgress.running = true;
  acquireBatchProgress.total = assetIds.length;
  acquireBatchProgress.completed = 0;
  acquireBatchProgress.succeeded = 0;
  acquireBatchProgress.failed = 0;
  acquireBatchProgress.currentAssetId = null;
  acquireBatchProgress.currentAsset = null;
  acquireBatchProgress.results = [];
  acquireBatchProgress.error = null;

  (async () => {
    for (const id of assetIds) {
      acquireBatchProgress.currentAssetId = id;
      acquireBatchProgress.currentAsset = null;
      try {
        const r = await acquireAssetById(id, (ap) => {
          acquireBatchProgress.currentAsset = ap;
        });
        acquireBatchProgress.results.push(r);
        if (r.status === "downloaded" || r.status === "already_downloaded") {
          acquireBatchProgress.succeeded++;
        } else {
          acquireBatchProgress.failed++;
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[acquire-batch] fatal for ${id}: ${msg}`);
        acquireBatchProgress.results.push({ assetId: id, status: "failed", error: msg });
        acquireBatchProgress.failed++;
      }
      acquireBatchProgress.completed++;
    }
  })()
    .catch((e) => {
      const msg = (e as Error).message;
      console.error(`[acquire-batch] fatal: ${msg}`);
      acquireBatchProgress.error = msg;
    })
    .finally(() => {
      acquireBatchProgress.running = false;
      acquireBatchProgress.currentAssetId = null;
      acquireBatchProgress.currentAsset = null;
    });

  return { started: true };
}
