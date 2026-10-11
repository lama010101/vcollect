// =============================================================================
// Asset-folder sync — scans a project's dedicated assets folder
// (OUTPUT_ROOT/<slug>/assets/) recursively and registers any media file
// (video or image) that has no DB row yet. This is how files that were copied
// into the folder outside the app (explorer, another tool) show up in Folders
// and — videos only — in the Music Edit source library: "all files in the
// folder" is the source of truth, not just files that came through downloads
// or drag & drop.
//
// Registration reuses the same shape as manual uploads: provider_id 'local',
// content-addressed id LOCAL_<project>_<sha16> (identical content dedupes
// automatically), sha256 + probed metadata (ffprobe for videos, sharp for
// images) + a thumbnail.
// =============================================================================

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createReadStream } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { IMAGE_FILE_EXTENSIONS, OUTPUT_ROOT, projectPaths, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { db } from "./client.js";
import { getProject } from "./projectRepository.js";
import { insertLocalAsset } from "./repository.js";
import { isPlayableVideo, probe } from "../video/ffprobe.js";
import { generateImageThumbnail, generateThumbnail } from "../video/thumbnails.js";

export interface AssetSyncResult {
  scanned: number;
  added: number;
  /** Files whose content was already tracked under another path (the file
   *  moved/was reorganized on disk) — the row's local_path was repointed. */
  moved: number;
  /** Tracked local_paths pointing at files that no longer exist — cleared
   *  back to "not downloaded" (sha256 stays, so a restored file relinks). */
  missing: number;
  /** Media files found but already tracked by a DB row. */
  known: number;
  /** Files skipped: not a playable video/readable image or unreadable. */
  skipped: number;
}

/** Recursively collect video + image files under `dir`. */
function walkMedia(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMedia(p, out);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (VIDEO_FILE_EXTENSIONS.has(ext) || IMAGE_FILE_EXTENSIONS.has(ext)) out.push(p);
    }
  }
  return out;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("end", () => resolvePromise(h.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Scan the project's assets folder and create DB rows for media files
 * (videos + images) that are not tracked yet. Cheap when nothing changed —
 * existing local_paths are skipped before hashing/probing.
 */
export async function syncProjectAssets(projectId: string): Promise<AssetSyncResult> {
  const project = getProject(projectId);
  if (!project || project.isVirtual) return { scanned: 0, added: 0, moved: 0, missing: 0, known: 0, skipped: 0 };

  const assetsDir = projectPaths(project.slug).assets;
  const files = walkMedia(assetsDir);

  // Files already tracked by this project's rows (local_path is relative to
  // OUTPUT_ROOT with forward slashes). bySha maps content → row so files that
  // were MOVED to a new path get their row repointed instead of being
  // re-probed and dropped by the content-addressed id conflict — which would
  // otherwise leave the stale path forever and re-hash on every sync. Rows
  // with a NULL local_path (cleared by the missing-file pass below) stay in
  // bySha so a file that comes back re-links to its old row.
  const rows = db.all(
    `SELECT id, local_path, sha256 FROM assets WHERE project_id = ?`,
    projectId,
  ) as Array<{ id: string; local_path: string | null; sha256: string | null }>;
  const known = new Set(
    rows.filter((r) => r.local_path != null).map((r) => r.local_path!.replace(/\\/g, "/")),
  );
  const bySha = new Map<string, { id: string; localPath: string | null }>();
  for (const r of rows) {
    if (r.sha256) bySha.set(r.sha256, { id: r.id, localPath: r.local_path?.replace(/\\/g, "/") ?? null });
  }
  const repointStmt = db.prepare(`UPDATE assets SET local_path = ?, title = ?, downloaded_at = ? WHERE id = ?`);

  let added = 0;
  let moved = 0;
  let skipped = 0;
  for (const abs of files) {
    const rel = relative(OUTPUT_ROOT, abs).split(sep).join("/");
    if (known.has(rel)) continue;
    const isImage = IMAGE_FILE_EXTENSIONS.has(extname(abs).toLowerCase());
    try {
      const sha256 = await sha256File(abs);
      // Same content already tracked under a different path → the file was
      // moved/renamed on disk. Repoint the row at the real location so the
      // asset stays playable and the new path becomes "known". When the old
      // path still exists the disk has two copies — keep the first-found one.
      const existing = bySha.get(sha256);
      if (existing) {
        if (existing.localPath == null || !existsSync(resolve(OUTPUT_ROOT, existing.localPath))) {
          repointStmt.run(rel, basename(abs), new Date().toISOString(), existing.id);
          existing.localPath = rel;
          moved++;
        }
        known.add(rel);
        continue;
      }
      let width: number | null = null;
      let height: number | null = null;
      let durationSeconds: number | null = null;
      let fps: number | null = null;
      if (isImage) {
        // Images validate + measure via sharp — a file that sharp can't
        // decode isn't a usable image asset.
        const meta = await sharp(abs).metadata().catch(() => null);
        if (!meta?.width || !meta.height) {
          skipped++;
          continue;
        }
        width = meta.width;
        height = meta.height;
      } else {
        if (!(await isPlayableVideo(abs))) {
          skipped++;
          continue;
        }
        const p = await probe(abs).catch(() => null);
        width = p?.width ?? null;
        height = p?.height ?? null;
        durationSeconds = p?.durationSeconds ?? null;
        fps = p?.fps ?? null;
      }
      const assetId = `LOCAL_${project.id}_${sha256.slice(0, 16)}`;
      insertLocalAsset({
        id: assetId,
        projectId: project.id,
        providerAssetId: sha256.slice(0, 16),
        title: basename(abs),
        providerUrl: "local://file",
        width,
        height,
        durationSeconds,
        fps,
        orientation:
          width != null && height != null
            ? width > height ? "landscape" : width === height ? "square" : "portrait"
            : null,
        localPath: rel,
        sha256,
        downloadedAt: new Date().toISOString(),
      });
      await (isImage ? generateImageThumbnail(abs, assetId) : generateThumbnail(abs, assetId)).catch(() => null);
      known.add(rel);
      added++;
    } catch (e) {
      console.warn(`[sync] skipped ${rel}: ${(e as Error).message}`);
      skipped++;
    }
  }

  // Missing files: tracked local_paths that resolve to nothing on disk —
  // the file was deleted or moved out of the folder. Clear the path so the
  // asset reverts to "not downloaded" instead of pointing at a 404 forever.
  // sha256 is kept, so if the file comes back the repoint pass relinks it.
  const clearStmt = db.prepare(`UPDATE assets SET local_path = NULL, downloaded_at = NULL WHERE id = ?`);
  let missing = 0;
  for (const r of rows) {
    const cur = (r.sha256 ? bySha.get(r.sha256)?.localPath : undefined) ?? r.local_path?.replace(/\\/g, "/") ?? null;
    if (cur == null) continue;
    if (!existsSync(resolve(OUTPUT_ROOT, cur))) {
      clearStmt.run(r.id);
      missing++;
    }
  }

  if (added > 0 || moved > 0 || missing > 0) {
    console.log(`[sync] ${project.slug}: +${added} new, ${moved} moved, ${missing} missing asset(s) on disk`);
  }
  return { scanned: files.length, added, moved, missing, known: files.length - added - moved - skipped, skipped };
}
