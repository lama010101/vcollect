// =============================================================================
// Local media uploads — drag & drop files (videos, images AND audio) onto the
// webapp land here.
//
// POST /api/assets/upload?project=<id>&name=<filename>[&folder=<sub>] with
// the raw file as the request body (Content-Type: application/octet-stream,
// video/*, image/* or audio/*). The request body is STREAMED to a temp file
// (hashed in-flight, byte-capped) — multi-hundred-MB uploads never sit in
// memory. The file is then validated (extension + real content — ffprobe for
// videos, sharp metadata for images, ffprobe audio stream for audio) and moved
// into the target project's dedicated assets folder:
//   OUTPUT_ROOT/<slug>/assets/<folder>/<filename>
// where <folder> defaults to uploads/unknown (unfiled drops). The optional
// `folder` param is a path relative to <slug>/assets/ — the Library sends its
// selected sidebar folder so drops land exactly where the user targeted.
// A 'local'-provider asset row is created so the upload shows up in Folders
// (Uploads section); video uploads also appear in the Music Edit source
// library, and audio uploads can be imported into the Music Edit song pool
// or the Visualizer stem pool from their pages.
// =============================================================================

import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { AUDIO_FILE_EXTENSIONS, config, IMAGE_FILE_EXTENSIONS, OUTPUT_ROOT, projectPaths, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { db } from "../db/client.js";
import { getAsset, insertLocalAsset } from "../db/repository.js";
import { listAssetFolders, sanitizeAssetFolder, syncProjectAssets } from "../db/assetSync.js";
import { isPlayableVideo, probe, probeAudio } from "../video/ffprobe.js";
import { generateAudioThumbnail, generateImageThumbnail, generateThumbnail } from "../video/thumbnails.js";
import { PROJECT_ID_ALL, DEFAULT_PROJECT_ID } from "@twio/shared";

/** Video file extensions accepted for upload (canonical set in config.ts). */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = VIDEO_FILE_EXTENSIONS;

/** Image file extensions accepted for upload (canonical set in config.ts). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = IMAGE_FILE_EXTENSIONS;

/** Audio file extensions accepted for upload (canonical set in config.ts —
 *  the same list the Music Edit / Visualizer audio pools accept). */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = AUDIO_FILE_EXTENSIONS;

export type MediaKind = "video" | "image" | "audio";

/** Classify an extension (with leading dot, any case) as video/image/audio. */
export function mediaKindForExt(ext: string): MediaKind | null {
  const e = ext.toLowerCase();
  if (VIDEO_FILE_EXTENSIONS.has(e)) return "video";
  if (IMAGE_FILE_EXTENSIONS.has(e)) return "image";
  if (AUDIO_FILE_EXTENSIONS.has(e)) return "audio";
  return null;
}

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

/** An upload already spooled to a temp file by the streaming content-type
 *  parser — the sha256 was computed in-flight so saving needs no re-hash. */
export interface StagedUpload {
  /** Absolute path to the spooled request body (OS temp dir). */
  tmpPath: string;
  /** Bytes written to the temp file. */
  sizeBytes: number;
  /** SHA-256 hex digest computed while streaming. */
  sha256: string;
}

/** Type guard for the object the streaming content-type parser produces. */
function isStagedUpload(body: unknown): body is StagedUpload {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as StagedUpload).tmpPath === "string"
  );
}

/** Default drop folder (relative to <slug>/assets/) — unfiled files land
 *  here; drops that target a specific folder pass `?folder=` instead. */
export const DEFAULT_UPLOAD_FOLDER = "uploads/unknown";

/**
 * Persist an uploaded video or image into a project's dedicated assets
 * folder. `data` is either a Buffer (tests / in-memory callers — hashed and
 * written here) or a StagedUpload (the HTTP route — the request body was
 * already spooled to a temp file and hashed while streaming, so it's just
 * moved into place). Throws an Error with a `.statusCode` (400/415/422) on
 * validation failure — the route maps it to an HTTP status.
 */
export async function saveUploadedFile(
  projectId: string,
  rawName: string,
  data: Buffer | StagedUpload,
  folder?: string,
): Promise<UploadResult> {
  const err = (statusCode: number, message: string): Error =>
    Object.assign(new Error(message), { statusCode });

  const staged: StagedUpload | null = Buffer.isBuffer(data) ? null : data;
  // Remove the spooled temp file on every early exit that leaves it behind.
  const cleanupTmp = (): void => {
    if (staged) { try { rmSync(staged.tmpPath, { force: true }); } catch { /* ignore */ } }
  };

  const project = getProject(projectId);
  if (!project || project.isVirtual) {
    cleanupTmp();
    throw err(404, `project not found: ${projectId}`);
  }

  const filename = sanitizeFilename(rawName) || "upload.mp4";
  const ext = extname(filename).toLowerCase();
  const kind = mediaKindForExt(ext);
  if (!kind) {
    cleanupTmp();
    throw err(415, `unsupported file type "${ext || "(none)"}" — allowed: ${[...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS].join(", ")}`);
  }
  const sizeBytes = Buffer.isBuffer(data) ? data.length : data.sizeBytes;
  if (sizeBytes === 0) {
    cleanupTmp();
    throw err(400, "empty upload");
  }

  // Content-addressed asset id: re-uploading the same file is a no-op. The
  // staged path reuses the digest computed while streaming — no re-hash.
  const sha256 = Buffer.isBuffer(data) ? createHash("sha256").update(data).digest("hex") : data.sha256;
  const assetId = `LOCAL_${project.id}_${sha256.slice(0, 16)}`;

  // Destination: the requested subfolder under <slug>/assets/, or the default
  // unfiled folder (uploads/unknown). Invalid folder input → 400, never a
  // silent escape outside the assets dir.
  const relFolder = folder == null ? DEFAULT_UPLOAD_FOLDER : sanitizeAssetFolder(folder);
  if (relFolder == null || relFolder === "") {
    throw err(400, `invalid folder "${folder}"`);
  }
  const destDir = resolve(projectPaths(project.slug).assets, relFolder);

  const existing = getAsset(assetId);
  if (existing?.local_path) {
    const abs = resolve(OUTPUT_ROOT, existing.local_path);
    if (existsSync(abs)) {
      cleanupTmp(); // already stored — the spooled temp file is redundant
      return { assetId, filename: basename(existing.local_path), localPath: existing.local_path, sizeBytes, alreadyUploaded: true };
    }
  }

  // Pick the destination. If the asset row already exists (file was deleted),
  // recreate it under the canonical uploads dir — keeping the row's basename
  // — and repoint the row so re-uploads never resurrect a retired layout
  // path. Otherwise use the upload's name with a suffix on collision
  // (same name, different content).
  let localPath: string;
  let destAbs: string;
  if (existing?.local_path) {
    const base = basename(existing.local_path);
    destAbs = join(destDir, base);
    if (destAbs !== resolve(OUTPUT_ROOT, existing.local_path) && existsSync(destAbs)) {
      destAbs = uniqueDest(destDir, base);
    }
    localPath = `${project.slug}/assets/${relFolder}/${basename(destAbs)}`;
    if (localPath !== existing.local_path) {
      db.prepare(`UPDATE assets SET local_path = ? WHERE id = ?`).run(localPath, assetId);
    }
  } else {
    destAbs = join(destDir, filename);
    if (existsSync(destAbs)) destAbs = uniqueDest(destDir, filename);
    localPath = `${project.slug}/assets/${relFolder}/${basename(destAbs)}`;
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  if (Buffer.isBuffer(data)) {
    writeFileSync(destAbs, data);
  } else {
    // Move the spooled temp file into place. os.tmpdir() can live on a
    // different drive than OUTPUT_ROOT (C: vs D: on this box) — renameSync
    // may fail with EXDEV, so fall back to copy + unlink.
    try {
      renameSync(data.tmpPath, destAbs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") {
        cleanupTmp();
        throw e;
      }
      try {
        copyFileSync(data.tmpPath, destAbs);
      } catch (copyErr) {
        cleanupTmp();
        throw copyErr;
      }
      rmSync(data.tmpPath, { force: true });
    }
  }

  let width: number | null = null;
  let height: number | null = null;
  let durationSeconds: number | null = null;
  let fps: number | null = null;

  if (kind === "image") {
    // Never trust the extension — verify sharp can decode real pixel metadata.
    try {
      const meta = await sharp(destAbs).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      if (!width || !height) throw new Error("no dimensions");
    } catch {
      try { rmSync(destAbs, { force: true }); } catch { /* ignore */ }
      throw err(422, `"${filename}" is not a readable image file`);
    }
  } else if (kind === "audio") {
    // Never trust the extension — verify ffprobe finds a real audio stream.
    try {
      const a = await probeAudio(destAbs);
      durationSeconds = a.durationSeconds;
    } catch {
      try { rmSync(destAbs, { force: true }); } catch { /* ignore */ }
      throw err(422, `"${filename}" is not a readable audio file`);
    }
  } else {
    // Never trust the extension — verify it's a real video container.
    if (!(await isPlayableVideo(destAbs))) {
      try { rmSync(destAbs, { force: true }); } catch { /* ignore */ }
      throw err(422, `"${filename}" is not a playable video file`);
    }
    try {
      const p = await probe(destAbs);
      width = p.width;
      height = p.height;
      durationSeconds = p.durationSeconds;
      fps = p.fps;
    } catch { /* metadata stays null — the file still counts as uploaded */ }
  }

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
  await (kind === "image"
    ? generateImageThumbnail(destAbs, assetId)
    : kind === "audio"
      ? generateAudioThumbnail(destAbs, assetId)
      : generateThumbnail(destAbs, assetId)
  ).catch(() => null);

  return { assetId, filename: basename(destAbs), localPath, sizeBytes, alreadyUploaded: false };
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // Scan the project's assets folder and register media files (videos +
  // images) that were placed there outside the app (explorer copy, another
  // tool, …) so they show up in Folders and in the Music Edit source library
  // (videos only). __ALL__ syncs every project (the library aggregates
  // across projects in that view).
  app.post("/api/assets/sync", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const projectId = String(q.project ?? DEFAULT_PROJECT_ID).trim();
    if (projectId === PROJECT_ID_ALL) {
      const ids = (db.all(`SELECT id FROM projects`) as Array<{ id: string }>).map((r) => r.id);
      const totals = { scanned: 0, added: 0, moved: 0, missing: 0, known: 0, skipped: 0 };
      for (const id of ids) {
        const r = await syncProjectAssets(id);
        totals.scanned += r.scanned;
        totals.added += r.added;
        totals.moved += r.moved;
        totals.missing += r.missing;
        totals.known += r.known;
        totals.skipped += r.skipped;
      }
      return totals;
    }
    const project = getProject(projectId);
    if (!project || project.isVirtual) return reply.code(404).send({ error: "project not found" });
    return syncProjectAssets(projectId);
  });

  // Real folder tree of the project's assets folder (<slug>/assets/) — every
  // directory on disk (including empty user-made subfolders) with media file
  // counts. Drives the Library's folder nav; combined with the `folder`
  // search filter (subtree match) to show one branch of the library.
  app.get("/api/assets/folder-tree", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const projectId = String(q.project ?? DEFAULT_PROJECT_ID).trim();
    if (projectId === PROJECT_ID_ALL) {
      return reply.code(400).send({ error: "folder tree needs a specific project" });
    }
    const project = getProject(projectId);
    if (!project || project.isVirtual) return reply.code(404).send({ error: "project not found" });
    return listAssetFolders(projectId);
  });

  await app.register(async (scope) => {
    // Raw file body, streamed to a temp file. No `parseAs` — Fastify hands the
    // parser the raw request stream, so multi-hundred-MB uploads never sit in
    // memory. The size cap (same limit as provider downloads) is enforced by
    // the byte-counting transform below — Fastify's `bodyLimit` option only
    // applies to string/buffer parsers. The webapp always sends
    // application/octet-stream; video/* + image/* + audio/* are matched by
    // RegExp (Fastify doesn't treat "video/*" strings as wildcards) so direct
    // API callers can send a proper media type.
    const uploadByteLimit = config.maxDownloadMb * 1024 * 1024;
    scope.addContentTypeParser(
      /^application\/octet-stream$|^video\/|^image\/|^audio\//,
      (_req, body, done) => {
        const tmpPath = join(tmpdir(), `twio-upload-${randomUUID()}`);
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            sizeBytes += chunk.length;
            if (sizeBytes > uploadByteLimit) {
              cb(Object.assign(
                new Error(`upload exceeds the ${config.maxDownloadMb} MB limit`),
                // Fastify maps err.statusCode → HTTP status; `code` matches
                // what the old buffered parser's bodyLimit produced.
                { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" },
              ));
              return;
            }
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        pipeline(body, meter, createWriteStream(tmpPath))
          .then(() => done(null, { tmpPath, sizeBytes, sha256: hash.digest("hex") }))
          .catch((e: Error) => {
            // pipeline() already destroyed every stream in the chain — just
            // drop the partial temp file.
            try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
            done(e);
          });
      },
    );

    scope.post("/api/assets/upload", async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const projectId = String(q.project ?? DEFAULT_PROJECT_ID).trim();
      const name = String(q.name ?? "upload.mp4");
      const folder = typeof q.folder === "string" ? q.folder : undefined;
      const staged = isStagedUpload(req.body) ? req.body : null;
      if (projectId === PROJECT_ID_ALL) {
        if (staged) { try { rmSync(staged.tmpPath, { force: true }); } catch { /* ignore */ } }
        return reply.code(400).send({ error: "select a specific project before uploading" });
      }
      if (!staged) {
        return reply.code(400).send({ error: "send the file as the raw request body" });
      }
      const result = await saveUploadedFile(projectId, name, staged, folder);
      return reply.code(result.alreadyUploaded ? 200 : 201).send({
        ...result,
        asset: getAsset(result.assetId) ?? null,
      });
    });
  });
}
