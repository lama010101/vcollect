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
import { basename, extname, join, relative, sep } from "node:path";
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

async function sha256File(file: string): Promise<string> {
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
  if (!project || project.isVirtual) return { scanned: 0, added: 0, known: 0, skipped: 0 };

  const assetsDir = projectPaths(project.slug).assets;
  const files = walkMedia(assetsDir);

  // Files already tracked by this project's rows (local_path is relative to
  // OUTPUT_ROOT with forward slashes).
  const known = new Set(
    (
      db.all(
        `SELECT local_path FROM assets WHERE project_id = ? AND local_path IS NOT NULL`,
        projectId,
      ) as Array<{ local_path: string }>
    ).map((r) => r.local_path.replace(/\\/g, "/")),
  );

  let added = 0;
  let skipped = 0;
  for (const abs of files) {
    const rel = relative(OUTPUT_ROOT, abs).split(sep).join("/");
    if (known.has(rel)) continue;
    const isImage = IMAGE_FILE_EXTENSIONS.has(extname(abs).toLowerCase());
    try {
      const sha256 = await sha256File(abs);
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

  if (added > 0) console.log(`[sync] ${project.slug}: +${added} asset(s) registered from disk`);
  return { scanned: files.length, added, known: files.length - added - skipped, skipped };
}
