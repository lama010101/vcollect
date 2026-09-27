// =============================================================================
// Reconcile — scan footage directories and re-link downloaded files to the DB.
//
// When the DB is recreated (e.g. by a fresh migrate+seed on a new machine or
// after data loss), the asset rows are gone but the downloaded .mp4 files may
// still exist on disk. This command scans the footage folders, parses the
// filename convention (SHOT_###_<PROVIDER>_<providerAssetId>.mp4), and:
//
//   1. Updates existing asset rows with the correct local_path, sha256, and
//      probed metadata (width/height/duration/fps/orientation).
//   2. Inserts minimal asset rows for files whose asset isn't in the DB yet.
//   3. Creates shot_assets links if missing.
//   4. Regenerates thumbnails.
//   5. Updates shot statuses to REVIEW for shots that now have downloaded
//      candidates.
//
// This is NOT a re-acquisition — no provider API calls are made. We only
// reconstruct DB state from the files already on disk.
// =============================================================================

import { readdirSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { ffmpegService } from "./video/ffmpeg.js";
import { probe, type ProbeResult } from "./video/ffprobe.js";
import { generateThumbnail } from "./video/thumbnails.js";
import { computePHash } from "./video/phash.js";
import { technicalFilter, technicalScore } from "./scoring/technical.js";
import { db } from "./db/client.js";
import { OUTPUT_ROOT } from "./config.js";
import { DEFAULT_PROJECT_ID } from "@twio/shared";
import type { AspectFlag, Orientation } from "@twio/shared";

// Filename pattern: SHOT_###_<PROVIDER>_<providerAssetId>.mp4
const FILENAME_RE = /^SHOT_(\d{3})_([A-Z]+)_(.+)\.mp4$/;

interface ScannedFile {
  absolutePath: string;
  relativePath: string; // relative to OUTPUT_ROOT (for local_path column)
  shotId: string;       // SHOT_001
  shotNumber: number;   // 1
  providerId: string;   // lowercase: pexels, pixabay
  providerAssetId: string; // 19975560
  assetId: string;      // PEXELS_19975560
}

/** Recursively scan a directory for .mp4 files. */
function scanMp4(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanMp4(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      results.push(full);
    }
  }
  return results;
}

/** Parse a filename like SHOT_001_PEXELS_19975560.mp4 into structured data.
 *  `relativePath` is computed relative to OUTPUT_ROOT (for the local_path column). */
function parseFilename(absPath: string): ScannedFile | null {
  const name = basename(absPath);
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  const shotNumber = parseInt(m[1]!, 10);
  const providerUpper = m[2]!;
  const providerAssetId = m[3]!;
  return {
    absolutePath: absPath,
    relativePath: relative(OUTPUT_ROOT, absPath).replace(/\\/g, "/"),
    shotId: `SHOT_${String(shotNumber).padStart(3, "0")}`,
    shotNumber,
    providerId: providerUpper.toLowerCase(),
    providerAssetId,
    assetId: `${providerUpper}_${providerAssetId}`,
  };
}

/** Compute SHA-256 of a file (streaming, works on any OS). */
async function sha256FileStream(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("end", () => resolve(h.digest("hex")));
    stream.on("error", reject);
  });
}

/** Look up a shot by ID to get its section + preferred orientation + target duration. */
function getShotInfo(shotId: string, projectId: string): { section: string; preferredOrientation: Orientation; targetDuration: number | null } | null {
  const row = db.prepare(
    `SELECT section, preferred_orientation, target_duration_seconds FROM shots WHERE id = ? AND project_id = ?`,
  ).get(shotId, projectId) as { section: string; preferred_orientation: string | null; target_duration_seconds: number | null } | undefined;
  if (!row) return null;
  return {
    section: row.section,
    preferredOrientation: (row.preferred_orientation ?? "landscape") as Orientation,
    targetDuration: row.target_duration_seconds,
  };
}

/** Check if an asset row exists (scoped to project). */
function assetExists(assetId: string, projectId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM assets WHERE id = ? AND project_id = ?`).get(assetId, projectId);
  return !!row;
}

/** Check if a shot_assets link exists. */
function shotAssetExists(shotId: string, assetId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM shot_assets WHERE shot_id = ? AND asset_id = ?`).get(shotId, assetId);
  return !!row;
}

/** Get provider commercial_license_policy. */
function providerPolicy(providerId: string): string {
  const row = db.prepare(`SELECT commercial_license_policy FROM providers WHERE id = ?`).get(providerId) as { commercial_license_policy: string } | undefined;
  return row?.commercial_license_policy ?? "LICENSE_UNKNOWN";
}

/** Insert a minimal asset row for a file that has no DB record. */
function insertMinimalAsset(sf: ScannedFile, projectId: string, commercialStatus: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (
       id, project_id, provider_id, provider_asset_id, provider_url, download_url,
       title, creator_name, creator_url, width, height, duration_seconds, fps,
       orientation, thumbnail_url, discovered_at, source_license, license_url,
       commercial_status, rights_review_status, vision_status, tags
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, 'OK', 'NOT_RUN', NULL)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    sf.assetId,
    projectId,
    sf.providerId,
    sf.providerAssetId,
    `https://${sf.providerId}.com/`,
    now,
    commercialStatus,
  );
}

/** Update an asset row with downloaded file metadata. */
function updateAssetWithFile(
  assetId: string,
  localPath: string,
  sha256: string,
  pHash: string | null,
  probeResult: ProbeResult,
  aspectFlag: AspectFlag,
  orientation: Orientation,
  techScore: number,
  commercialStatus: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE assets SET
       local_path=?, sha256=?, perceptual_hash=?, duplicate_flag=?, aspect_flag=?,
       width=?, height=?, duration_seconds=?, fps=?, orientation=?,
       downloaded_at=?, commercial_status=?, rights_review_status=?,
       technical_score=?, final_score=COALESCE(final_score, ?),
       diversity_penalty_applied=COALESCE(diversity_penalty_applied, 0)
     WHERE id=?`,
  ).run(
    localPath,
    sha256,
    pHash,
    "NONE",
    aspectFlag,
    probeResult.width,
    probeResult.height,
    probeResult.durationSeconds,
    probeResult.fps,
    orientation,
    now,
    commercialStatus,
    "OK",
    techScore,
    techScore, // final_score fallback = technical_score if not already set
    assetId,
  );
}

/** Create a shot_assets link if it doesn't exist. */
function ensureShotAssetLink(shotId: string, assetId: string, rank: number): void {
  db.prepare(
    `INSERT INTO shot_assets (shot_id, asset_id, rank, selected, rejected, is_reserve)
     VALUES (?, ?, ?, 0, 0, 0)
     ON CONFLICT(shot_id, asset_id) DO NOTHING`,
  ).run(shotId, assetId, rank);
}

/** Mark the first downloaded non-rejected asset as selected for a shot. */
function selectFirstDownloaded(shotId: string, projectId: string): void {
  db.prepare(
    `UPDATE shot_assets SET selected = 1, rejected = 0
     WHERE shot_id = ? AND asset_id = (
       SELECT a.id FROM assets a
       JOIN shot_assets sa ON sa.asset_id = a.id
       WHERE sa.shot_id = ? AND a.project_id = ? AND a.local_path IS NOT NULL
         AND a.commercial_status != 'REJECTED'
       ORDER BY sa.rank ASC LIMIT 1
     )`,
  ).run(shotId, shotId, projectId);
}

/** Update shot status to REVIEW if it has downloaded candidates. */
function updateShotStatus(shotId: string, projectId: string): void {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM assets a
     JOIN shot_assets sa ON sa.asset_id = a.id
     WHERE sa.shot_id = ? AND a.project_id = ? AND a.local_path IS NOT NULL AND a.commercial_status != 'REJECTED'`,
  ).get(shotId, projectId) as { cnt: number };
  if (row.cnt > 0) {
    db.prepare(`UPDATE shots SET status = 'REVIEW' WHERE id = ? AND project_id = ? AND status NOT IN ('DONE', 'REVIEW')`).run(shotId, projectId);
  }
}

export interface ReconcileResult {
  scanned: number;
  updated: number;
  inserted: number;
  linksCreated: number;
  skipped: number;
  errors: string[];
}

export async function reconcile(
  projectId = DEFAULT_PROJECT_ID,
  opts: { dryRun?: boolean; skipThumbnails?: boolean; skipPHash?: boolean } = {},
): Promise<ReconcileResult> {
  await ffmpegService.ensure();

  const result: ReconcileResult = {
    scanned: 0,
    updated: 0,
    inserted: 0,
    linksCreated: 0,
    skipped: 0,
    errors: [],
  };

  // Scan OUTPUT_ROOT subfolders for .mp4 files. Real files are now stored
  // under OUTPUT_ROOT/<search_query>/SHOT_###_<PROVIDER>_<id>.mp4.
  // Also scan legacy dirs (Assets/, footage/, Collector/) for backwards compat.
  const legacyAssetsDir = join(OUTPUT_ROOT, "Assets");
  const legacyFootageDir = join(OUTPUT_ROOT, "footage");
  const scanDirs: Array<{ dir: string; label: string }> = [];

  // Scan all subfolders of OUTPUT_ROOT (excluding thumbnails, database, and
  // per-project manifest dirs which don't contain .mp4 files).
  if (existsSync(OUTPUT_ROOT)) {
    for (const entry of readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (["thumbnails", "database"].includes(entry.name)) continue;
      const full = join(OUTPUT_ROOT, entry.name);
      scanDirs.push({ dir: full, label: `output/${entry.name}` });
    }
  }
  // Also scan legacy Assets dir if it exists.
  if (existsSync(legacyAssetsDir)) {
    scanDirs.push({ dir: legacyAssetsDir, label: "legacy Assets (global)" });
  }
  // Also scan legacy footage dir if it exists.
  if (existsSync(legacyFootageDir)) {
    scanDirs.push({ dir: legacyFootageDir, label: "legacy root footage" });
  }

  console.log(`[reconcile] scanning for .mp4 files...`);
  const allFiles: ScannedFile[] = [];
  for (const sd of scanDirs) {
    const files = scanMp4(sd.dir);
    console.log(`[reconcile]   ${sd.label} (${sd.dir}): ${files.length} file(s)`);
    for (const absPath of files) {
      const sf = parseFilename(absPath);
      if (!sf) {
        result.skipped++;
        result.errors.push(`unparseable filename: ${basename(absPath)}`);
        continue;
      }
      allFiles.push(sf);
    }
  }
  console.log(`[reconcile] found ${allFiles.length} .mp4 file(s) on disk`);

  // Group files by shot to assign ranks. Deduplicate by asset_id (if a file
  // exists in both locations, prefer the project-scoped path).
  const seenAssets = new Set<string>();
  const byShot = new Map<string, ScannedFile[]>();
  for (const sf of allFiles) {
    if (seenAssets.has(sf.assetId)) continue;
    seenAssets.add(sf.assetId);
    result.scanned++;
    const arr = byShot.get(sf.shotId) ?? [];
    arr.push(sf);
    byShot.set(sf.shotId, arr);
  }

  if (opts.dryRun) {
    console.log(`[reconcile] DRY RUN — no DB changes will be made`);
    for (const [shotId, files] of byShot) {
      console.log(`  ${shotId}: ${files.length} file(s)`);
    }
    return result;
  }

  db.transaction(() => {
    // Phase 1: insert minimal asset rows for files not yet in DB.
    for (const [shotId, files] of byShot) {
      const shotInfo = getShotInfo(shotId, projectId);
      if (!shotInfo) {
        result.skipped += files.length;
        result.errors.push(`shot not found in DB: ${shotId}`);
        continue;
      }
      for (const sf of files) {
        if (!assetExists(sf.assetId, projectId)) {
          const policy = providerPolicy(sf.providerId);
          insertMinimalAsset(sf, projectId, policy);
          result.inserted++;
        }
      }
    }
  });

  // Phase 2: probe + update each asset with file metadata (outside transaction
  // because ffprobe/sharp are async and can't run inside a sync transaction).
  let processed = 0;
  for (const [shotId, files] of byShot) {
    const shotInfo = getShotInfo(shotId, projectId);
    if (!shotInfo) continue;

    for (let i = 0; i < files.length; i++) {
      const sf = files[i]!;
      const rank = i + 1;
      processed++;

      try {
        // Check if the asset already has local_path set — skip if so.
        const existing = db.prepare(
          `SELECT local_path, sha256 FROM assets WHERE id = ?`,
        ).get(sf.assetId) as { local_path: string | null; sha256: string | null } | undefined;

        if (existing?.local_path && existing.sha256) {
          // Already linked — just ensure the shot_assets link exists.
          if (!shotAssetExists(shotId, sf.assetId)) {
            ensureShotAssetLink(shotId, sf.assetId, rank);
            result.linksCreated++;
          }
          continue;
        }

        // Probe the video file.
        const probeResult = await probe(sf.absolutePath);
        const tf = technicalFilter(probeResult);
        if (!tf.passed) {
          result.errors.push(`technical filter failed for ${sf.assetId}: ${tf.reasons.join("; ")}`);
          // Still link it but mark as rejected.
          if (!shotAssetExists(shotId, sf.assetId)) {
            ensureShotAssetLink(shotId, sf.assetId, rank);
            result.linksCreated++;
          }
          db.prepare(`UPDATE shot_assets SET rejected = 1, rejection_reason = ? WHERE shot_id = ? AND asset_id = ?`)
            .run(`technical_filter: ${tf.reasons.join("; ")}`, shotId, sf.assetId);
          continue;
        }

        // Compute SHA-256.
        const sha256 = await sha256FileStream(sf.absolutePath);

        // Compute pHash (optional, can be slow).
        let pHash: string | null = null;
        if (!opts.skipPHash) {
          try {
            pHash = await computePHash(sf.absolutePath);
          } catch (e) {
            result.errors.push(`pHash failed for ${sf.assetId}: ${(e as Error).message}`);
          }
        }

        // Compute technical score.
        const techScore = technicalScore(
          probeResult,
          tf.orientation,
          tf.aspectFlag,
          shotInfo.preferredOrientation,
          shotInfo.targetDuration ?? undefined,
        );

        // Determine commercial status from provider policy.
        const policy = providerPolicy(sf.providerId);
        const commercialStatus = policy === "LICENSE_SOURCE_CONFIRMED" ? "LICENSE_SOURCE_CONFIRMED" : "HUMAN_REVIEW_REQUIRED";

        // Update the asset row.
        updateAssetWithFile(
          sf.assetId,
          sf.relativePath,
          sha256,
          pHash,
          probeResult,
          tf.aspectFlag,
          tf.orientation,
          techScore,
          commercialStatus,
        );
        result.updated++;

        // Ensure shot_assets link.
        if (!shotAssetExists(shotId, sf.assetId)) {
          ensureShotAssetLink(shotId, sf.assetId, rank);
          result.linksCreated++;
        }

        // Regenerate thumbnail (optional).
        if (!opts.skipThumbnails) {
          try {
            await generateThumbnail(sf.absolutePath, sf.assetId);
          } catch (e) {
            result.errors.push(`thumbnail failed for ${sf.assetId}: ${(e as Error).message}`);
          }
        }

        if (processed % 50 === 0) {
          console.log(`[reconcile] processed ${processed}/${result.scanned} files...`);
        }
      } catch (e) {
        result.errors.push(`failed to process ${sf.assetId}: ${(e as Error).message}`);
      }
    }
  }

  // Phase 3: update shot statuses and auto-select first downloaded asset.
  db.transaction(() => {
    for (const shotId of byShot.keys()) {
      selectFirstDownloaded(shotId, projectId);
      updateShotStatus(shotId, projectId);
    }
  });

  console.log(`[reconcile] done: scanned=${result.scanned} updated=${result.updated} inserted=${result.inserted} links=${result.linksCreated} skipped=${result.skipped}`);
  if (result.errors.length > 0) {
    console.log(`[reconcile] ${result.errors.length} error(s):`);
    for (const e of result.errors.slice(0, 20)) console.log(`  - ${e}`);
    if (result.errors.length > 20) console.log(`  ... and ${result.errors.length - 20} more`);
  }

  return result;
}
