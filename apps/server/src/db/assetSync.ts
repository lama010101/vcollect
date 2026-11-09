// =============================================================================
// Asset-folder sync — scans a project's dedicated assets folder
// (OUTPUT_ROOT/<slug>/assets/) recursively and registers any media file
// (video, image or audio) that has no DB row yet. This is how files that were
// copied into the folder outside the app (explorer, another tool) show up in
// Folders and — videos only — in the Music Edit source library: "all files in
// the folder" is the source of truth, not just files that came through
// downloads or drag & drop.
//
// Registration reuses the same shape as manual uploads: provider_id 'local',
// content-addressed id LOCAL_<project>_<sha16> (identical content dedupes
// automatically), sha256 + probed metadata (ffprobe for videos, sharp for
// images, ffprobe audio stream for audio) + a thumbnail.
// =============================================================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { createReadStream } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { AUDIO_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, OUTPUT_ROOT, projectPaths, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { db } from "./client.js";
import { getProject } from "./projectRepository.js";
import { getAsset, insertLocalAsset } from "./repository.js";
import { isPlayableVideo, probe, probeAudio } from "../video/ffprobe.js";
import { generateAudioThumbnail, generateImageThumbnail, generateThumbnail } from "../video/thumbnails.js";

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
  /** Files skipped: not a playable video/readable image/readable audio or unreadable. */
  skipped: number;
}

/** Recursively collect video + image + audio files under `dir`. */
function walkMedia(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMedia(p, out);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (VIDEO_FILE_EXTENSIONS.has(ext) || IMAGE_FILE_EXTENSIONS.has(ext) || AUDIO_FILE_EXTENSIONS.has(ext)) out.push(p);
    }
  }
  return out;
}

/** Extension-based media kind for a file path ("."-prefixed lowercase ext). */
function mediaKindOfPath(file: string): "video" | "image" | "audio" {
  const ext = extname(file).toLowerCase();
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return "audio";
  return "video";
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
    const kind = mediaKindOfPath(abs);
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
      if (kind === "image") {
        // Images validate + measure via sharp — a file that sharp can't
        // decode isn't a usable image asset.
        const meta = await sharp(abs).metadata().catch(() => null);
        if (!meta?.width || !meta.height) {
          skipped++;
          continue;
        }
        width = meta.width;
        height = meta.height;
      } else if (kind === "audio") {
        // Audio validates via ffprobe's audio stream — an unreadable file
        // isn't a usable audio asset.
        const a = await probeAudio(abs).catch(() => null);
        if (!a) {
          skipped++;
          continue;
        }
        durationSeconds = a.durationSeconds;
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
      await (kind === "image"
        ? generateImageThumbnail(abs, assetId)
        : kind === "audio"
          ? generateAudioThumbnail(abs, assetId)
          : generateThumbnail(abs, assetId)
      ).catch(() => null);
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

// =============================================================================
// Physical folder tree — drives the Library's folder nav. walkMedia finds
// FILES; this walks DIRECTORIES so user-made subfolders (even empty ones)
// show up exactly as they exist on disk.
// =============================================================================

export interface AssetFolderEntry {
  /** Path relative to <slug>/assets/ using "/" separators ("" = assets root). */
  path: string;
  /** Last path segment ("assets" for the root). */
  name: string;
  /** 0 = assets root, 1 = top-level subfolder, … */
  depth: number;
  /** Media files directly in this folder (extension match, like walkMedia). */
  fileCount: number;
  /** Media files in this folder and all descendant folders. */
  subtreeCount: number;
}

interface FolderTreeNode {
  path: string;
  name: string;
  fileCount: number;
  children: FolderTreeNode[];
}

function walkFolderTree(abs: string, rel: string, name: string): FolderTreeNode {
  const node: FolderTreeNode = { path: rel, name, fileCount: 0, children: [] };
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    // Symlinked dirs are not isDirectory — skipped, which also prevents cycles.
    if (entry.isDirectory()) {
      node.children.push(
        walkFolderTree(join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name, entry.name),
      );
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (VIDEO_FILE_EXTENSIONS.has(ext) || IMAGE_FILE_EXTENSIONS.has(ext) || AUDIO_FILE_EXTENSIONS.has(ext)) node.fileCount++;
    }
  }
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  return node;
}

/** List every directory under the project's assets folder as a flat DFS list
 *  (parents before children, siblings alphabetical), with per-folder and
 *  subtree media-file counts. Empty subfolders are included — the tree mirrors
 *  the disk, not the DB. */
export function listAssetFolders(
  projectId: string,
): { projectId: string; assetsRoot: string; folders: AssetFolderEntry[] } {
  const project = getProject(projectId);
  const assetsRoot = project && !project.isVirtual ? projectPaths(project.slug).assets : "";
  const folders: AssetFolderEntry[] = [];
  if (!assetsRoot || !existsSync(assetsRoot)) return { projectId, assetsRoot, folders };

  const emit = (node: FolderTreeNode, depth: number): number => {
    const entry: AssetFolderEntry = {
      path: node.path,
      name: node.name,
      depth,
      fileCount: node.fileCount,
      subtreeCount: node.fileCount,
    };
    folders.push(entry);
    for (const c of node.children) entry.subtreeCount += emit(c, depth + 1);
    return entry.subtreeCount;
  };
  emit(walkFolderTree(assetsRoot, "", "assets"), 0);
  return { projectId, assetsRoot, folders };
}

// =============================================================================
// Moving assets between folders — the Library's drag-onto-folder gesture moves
// the real file inside <slug>/assets/ and repoints local_path. The DB is the
// index but the folder on disk is the source of truth, so a move is a plain
// renameSync + UPDATE (sha256 unchanged → sync never re-registers it).
// =============================================================================

/** Validate + normalize a `folder` param: a path relative to <slug>/assets/
 *  using "/" separators. Returns "" for the assets root itself, null when the
 *  input is unusable (traversal, drive letters, empty segments) — callers
 *  decide the fallback (400 vs default dir). */
export function sanitizeAssetFolder(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const norm = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (norm === "") return "";
  if (/^[a-zA-Z]:/.test(norm)) return null; // drive-letter absolute path
  const parts = norm.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

/** First non-existing destination inside `dir`, suffixing _1, _2, … on
 *  collision (same convention as uploads' uniqueDest — kept local to avoid a
 *  routes→db import cycle). */
function uniqueDestPath(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = join(dir, `${stem}_${i}${ext}`);
    if (!existsSync(cand)) return cand;
  }
}

const err = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode });

/** Move an asset's local file into another folder inside the project's
 *  assets dir (<slug>/assets/<folder>/ — "" = the assets root). Creates the
 *  destination if needed, suffixes the name on collision, and repoints
 *  local_path (+ title to the new basename, matching sync's repoint). */
export function moveAssetToFolder(
  assetId: string,
  folder: string,
): { assetId: string; localPath: string; folder: string } {
  const asset = getAsset(assetId);
  if (!asset) throw err(404, "asset not found");
  if (!asset.local_path) throw err(400, "asset has no local file");
  const project = getProject(asset.project_id);
  if (!project || project.isVirtual) throw err(404, "project not found");

  const folderRel = sanitizeAssetFolder(folder);
  if (folderRel == null) throw err(400, `invalid folder "${folder}"`);

  const rel = asset.local_path.replace(/\\/g, "/");
  const srcAbs = resolve(OUTPUT_ROOT, rel);
  if (!existsSync(srcAbs)) throw err(404, "file is missing on disk — run sync");

  const assetsRoot = projectPaths(project.slug).assets;
  const destDir = folderRel ? resolve(assetsRoot, folderRel) : assetsRoot;
  if (!destDir.startsWith(assetsRoot + sep) && destDir !== assetsRoot) {
    throw err(400, "folder must stay inside the project's assets dir");
  }
  if (dirname(srcAbs) === destDir) {
    return { assetId, localPath: rel, folder: folderRel }; // already there
  }

  mkdirSync(destDir, { recursive: true });
  let destAbs = join(destDir, basename(srcAbs));
  if (existsSync(destAbs)) destAbs = uniqueDestPath(destDir, basename(srcAbs));
  renameSync(srcAbs, destAbs);

  const newRel = relative(OUTPUT_ROOT, destAbs).split(sep).join("/");
  db.prepare(`UPDATE assets SET local_path = ?, title = ? WHERE id = ?`).run(newRel, basename(destAbs), assetId);
  return { assetId, localPath: newRel, folder: folderRel };
}
