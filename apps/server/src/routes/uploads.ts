// =============================================================================
// Local video uploads — drag & drop files onto the webapp land here.
//
// POST /api/assets/upload?project=<id>&name=<filename> with the raw video as
// the request body (Content-Type: application/octet-stream or video/*). The
// file is validated (extension + real container via ffprobe), hashed, probed
// and stored inside the target project's dedicated assets folder:
//   OUTPUT_ROOT/<slug>/assets/uploads/<filename>
// A 'local'-provider asset row is created so the upload shows up in Folders
// (Uploads section) and in the Music Edit source library.
// =============================================================================

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { config, OUTPUT_ROOT, projectAssetDir, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { db } from "../db/client.js";
import { getAsset, insertLocalAsset } from "../db/repository.js";
import { syncProjectAssets } from "../db/assetSync.js";
import { isPlayableVideo, probe } from "../video/ffprobe.js";
import { generateThumbnail } from "../video/thumbnails.js";
import { PROJECT_ID_ALL, DEFAULT_PROJECT_ID } from "@twio/shared";

/** Video file extensions accepted for upload (canonical set in config.ts). */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = VIDEO_FILE_EXTENSIONS;

/** Strip path separators + filesystem-unsafe characters from an uploaded
 *  filename — never trust client-supplied paths. The original name (and its
 *  extension) is preserved for display. */
export function sanitizeFilename(name: string): string {
  const unsafe = /[<>:"/\\|?*]/g;
  const base = basename(name)
    .replace(unsafe, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, ""); // no dotfiles
  // Strip control characters (keeps unicode letters — e.g. "видео.mp4").
  return [...base].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "_" : c)).join("");
}

/** Find a non-existing destination by appending _1, _2, … before the ext. */
export function uniqueDest(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = join(dir, `${stem}_${i}${ext}`);
    if (!existsSync(cand)) return cand;
  }
}

export interface UploadResult {
  assetId: string;
  filename: string;
  localPath: string;
  sizeBytes: number;
  alreadyUploaded: boolean;
}

/**
 * Persist an uploaded video buffer into a project's dedicated assets folder.
 * Throws an Error with a `.statusCode` (400/415/422) on validation failure —
 * the route maps it to an HTTP status.
 */
export async function saveUploadedVideo(
  projectId: string,
  rawName: string,
  data: Buffer,
): Promise<UploadResult> {
  const err = (statusCode: number, message: string): Error =>
    Object.assign(new Error(message), { statusCode });

  const project = getProject(projectId);
  if (!project || project.isVirtual) throw err(404, `project not found: ${projectId}`);

  const filename = sanitizeFilename(rawName) || "upload.mp4";
  const ext = extname(filename).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw err(415, `unsupported file type "${ext || "(none)"}" — allowed: ${[...VIDEO_EXTENSIONS].join(", ")}`);
  }
  if (data.length === 0) throw err(400, "empty upload");

  // Content-addressed asset id: re-uploading the same file is a no-op.
  const sha256 = createHash("sha256").update(data).digest("hex");
  const assetId = `LOCAL_${project.id}_${sha256.slice(0, 16)}`;
  const uploadsDir = projectAssetDir(project.slug, "uploads");

  const existing = getAsset(assetId);
  if (existing?.local_path) {
    const abs = resolve(OUTPUT_ROOT, existing.local_path);
    if (existsSync(abs)) {
      return { assetId, filename: basename(existing.local_path), localPath: existing.local_path, sizeBytes: data.length, alreadyUploaded: true };
    }
  }

  // Pick the destination. If the asset row already exists (file was deleted),
  // recreate it at the row's canonical path; otherwise use the upload's name
  // with a suffix on collision (same name, different content).
  let localPath: string;
  let destAbs: string;
  if (existing?.local_path) {
    localPath = existing.local_path;
    destAbs = resolve(OUTPUT_ROOT, localPath);
    mkdirSync(dirname(destAbs), { recursive: true });
  } else {
    destAbs = join(uploadsDir, filename);
    if (existsSync(destAbs)) destAbs = uniqueDest(uploadsDir, filename);
    localPath = `${project.slug}/assets/uploads/${basename(destAbs)}`;
  }
  writeFileSync(destAbs, data);

  // Never trust the extension — verify it's a real video container.
  if (!(await isPlayableVideo(destAbs))) {
    try { rmSync(destAbs, { force: true }); } catch { /* ignore */ }
    throw err(422, `"${filename}" is not a playable video file`);
  }

  let width: number | null = null;
  let height: number | null = null;
  let durationSeconds: number | null = null;
  let fps: number | null = null;
  try {
    const p = await probe(destAbs);
    width = p.width;
    height = p.height;
    durationSeconds = p.durationSeconds;
    fps = p.fps;
  } catch { /* metadata stays null — the file still counts as uploaded */ }

  const orientation =
    width != null && height != null
      ? width > height ? "landscape" : width === height ? "square" : "portrait"
      : null;

  insertLocalAsset({
    id: assetId,
    projectId: project.id,
    providerAssetId: sha256.slice(0, 16),
    title: filename,
    providerUrl: "local://upload",
    width,
    height,
    durationSeconds,
    fps,
    orientation,
    localPath,
    sha256,
    downloadedAt: new Date().toISOString(),
  });

  // Thumbnail is best-effort — never fail the upload over it.
  await generateThumbnail(destAbs, assetId).catch(() => null);

  return { assetId, filename: basename(destAbs), localPath, sizeBytes: data.length, alreadyUploaded: false };
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // Scan the project's assets folder and register video files that were
  // placed there outside the app (explorer copy, another tool, …) so they
  // show up in Folders and the Music Edit source library. __ALL__ syncs every
  // project (the library aggregates across projects in that view).
  app.post("/api/assets/sync", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const projectId = String(q.project ?? DEFAULT_PROJECT_ID).trim();
    if (projectId === PROJECT_ID_ALL) {
      const ids = (db.all(`SELECT id FROM projects`) as Array<{ id: string }>).map((r) => r.id);
      const totals = { scanned: 0, added: 0, known: 0, skipped: 0 };
      for (const id of ids) {
        const r = await syncProjectAssets(id);
        totals.scanned += r.scanned;
        totals.added += r.added;
        totals.known += r.known;
        totals.skipped += r.skipped;
      }
      return totals;
    }
    const project = getProject(projectId);
    if (!project || project.isVirtual) return reply.code(404).send({ error: "project not found" });
    return syncProjectAssets(projectId);
  });

  await app.register(async (scope) => {
    // Raw video body. Cap at the same limit used for provider downloads.
    scope.addContentTypeParser(
      ["application/octet-stream", "video/*"],
      { parseAs: "buffer", bodyLimit: config.maxDownloadMb * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );

    scope.post("/api/assets/upload", async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const projectId = String(q.project ?? DEFAULT_PROJECT_ID).trim();
      if (projectId === PROJECT_ID_ALL) {
        return reply.code(400).send({ error: "select a specific project before uploading" });
      }
      const name = String(q.name ?? "upload.mp4");
      if (!Buffer.isBuffer(req.body)) {
        return reply.code(400).send({ error: "send the video file as the raw request body" });
      }
      const result = await saveUploadedVideo(projectId, name, req.body);
      return reply.code(result.alreadyUploaded ? 200 : 201).send({
        ...result,
        asset: getAsset(result.assetId) ?? null,
      });
    });
  });
}
