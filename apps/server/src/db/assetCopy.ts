// =============================================================================
// Asset copy — link an existing asset into a target project. Used by the
// "Copy to project..." action in the Folders and ShotReview UI.
//
// Since real files live under OUTPUT_ROOT/<query>/, "copying" no longer
// duplicates the file — it creates a new asset row (with a project-scoped id)
// that references the same file path. The thumbnail is copied from the global
// thumbnails dir under the new asset id.
// =============================================================================

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { db } from "./client.js";
import { OUTPUT_ROOT, THUMBNAILS_DIR } from "../config.js";
import { getAsset, addAssetToShot } from "./repository.js";
import { getProject } from "./projectRepository.js";
import type { AssetRow } from "./schema.js";

type Stmt = ReturnType<typeof db.prepare>;
function lazy(sql: string): () => Stmt {
  let s: Stmt | null = null;
  return () => (s ??= db.prepare(sql));
}

function nowIso(): string {
  return new Date().toISOString();
}

const insertCopiedAssetStmt = lazy(
  `INSERT INTO assets (
     id, project_id, provider_id, provider_asset_id, provider_url, download_url,
     title, creator_name, creator_url, width, height, duration_seconds, fps,
     orientation, thumbnail_url, local_path, sha256, perceptual_hash,
     duplicate_flag, aspect_flag, discovered_at, downloaded_at, source_license,
     license_url, commercial_status, rights_review_status, vision_status, tags,
     ai_relevance_score, technical_score, duplicate_score, final_score,
     diversity_penalty_applied, notes, ready, rating
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_RUN', ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     local_path=excluded.local_path, downloaded_at=excluded.downloaded_at,
     project_id=excluded.project_id`,
);

export interface CopyAssetInput {
  assetId: string;
  toProjectId: string;
  targetShotId?: string | null;
}

export interface CopyAssetResult {
  ok: boolean;
  newAssetId: string;
  toProjectId: string;
  linkedFile: boolean;
  copiedThumbnail: boolean;
}

/** Link an existing asset into a target project. The source asset must exist
 *  and have a `local_path` (only downloaded assets are copyable). The target
 *  project must be a concrete project (not __ALL__).
 *
 *  Since real files live under OUTPUT_ROOT/<query>/, this does NOT copy the
 *  video file. It creates a new asset row referencing the same file path. */
export function copyAssetToProject(inp: CopyAssetInput): CopyAssetResult {
  const src = getAsset(inp.assetId);
  if (!src) throw new Error(`asset not found: ${inp.assetId}`);
  if (!src.local_path) throw new Error(`asset has no downloaded file: ${inp.assetId}`);
  const target = getProject(inp.toProjectId);
  if (!target || target.isVirtual) throw new Error(`target project not found or virtual: ${inp.toProjectId}`);

  // New asset id: prefix with the target project slug to keep ids unique
  // across projects.
  const newAssetId = `${target.slug}_${src.id}`.slice(0, 200);

  // The real file is under OUTPUT_ROOT/<query>/ — no need to copy it.
  // Just reference the same local_path in the new asset row.
  const globalFile = resolve(OUTPUT_ROOT, src.local_path.replace(/\\/g, "/"));
  const linkedFile = existsSync(globalFile);

  // Copy the thumbnail from the global thumbnails dir under the new asset id.
  const srcThumb = join(THUMBNAILS_DIR, `${src.id}.jpg`);
  const dstThumb = join(THUMBNAILS_DIR, `${newAssetId}.jpg`);
  let copiedThumbnail = false;
  if (existsSync(srcThumb) && srcThumb !== dstThumb) {
    mkdirSync(THUMBNAILS_DIR, { recursive: true });
    copyFileSync(srcThumb, dstThumb);
    copiedThumbnail = true;
  }

  // Insert the copied asset row. local_path stays the same (points to the
  // global Assets/ file).
  insertCopiedAssetStmt().run(
    newAssetId,
    target.id,
    src.provider_id,
    src.provider_asset_id,
    src.provider_url,
    src.download_url,
    src.title,
    src.creator_name,
    src.creator_url,
    src.width,
    src.height,
    src.duration_seconds,
    src.fps,
    src.orientation,
    src.thumbnail_url,
    src.local_path, // same global path (relative to OUTPUT_ROOT)
    src.sha256,
    src.perceptual_hash,
    src.duplicate_flag ?? "NONE",
    src.aspect_flag ?? "STANDARD",
    src.discovered_at ?? nowIso(),
    src.downloaded_at ?? nowIso(),
    src.source_license,
    src.license_url,
    src.commercial_status ?? "DISCOVERED",
    src.rights_review_status ?? "OK",
    src.tags,
    src.ai_relevance_score,
    src.technical_score,
    src.duplicate_score,
    src.final_score,
    src.diversity_penalty_applied ?? 0,
    src.notes,
    src.ready ?? 1,
    src.rating ?? null,
  );

  // Optionally link the copied asset to a target shot.
  if (inp.targetShotId) {
    addAssetToShot(inp.targetShotId, newAssetId);
  }

  return {
    ok: true,
    newAssetId,
    toProjectId: target.id,
    linkedFile,
    copiedThumbnail,
  };
}

// Re-export for callers that want the copied row.
export function getCopiedAsset(newAssetId: string): AssetRow | undefined {
  return getAsset(newAssetId);
}
