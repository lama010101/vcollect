// =============================================================================
// Asset routes — pool search, per-asset actions, file/thumb serving, folders
//   GET  /api/assets/search?project=    legacy free-text OR structured filters
//   POST /api/assets/:id/copy           copy the asset to another project
//   GET  /api/folders?project=          section-folder tree of downloaded files
//   POST /api/folders/reveal?project=   open the project's assets folder in
//                                       the OS file explorer
//   POST /api/assets/:id/reveal         reveal the file in the OS explorer
//   POST /api/assets/:id/ready          flag/unflag ready-for-edit
//   POST /api/assets/:id/rating         set 0–10 rating (null clears)
//   GET  /api/assets/:id                asset row
//   GET  /api/assets/:id/file           stream the local file
//   GET  /api/assets/:id/thumb          generated JPEG thumbnail
// =============================================================================

import type { FastifyInstance } from "fastify";
import { basename, resolve } from "node:path";
import { createReadStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import sharp from "sharp";
import { mediaMimeForFile, OUTPUT_ROOT, projectPaths, THUMBNAILS_DIR } from "../config.js";
import { THUMB_MAX_DIM } from "../video/thumbnails.js";
import { copyAssetToProject } from "../db/assetCopy.js";
import {
  getAsset,
  searchAssets,
  searchAssetsAdvanced,
  setAssetRating,
  setAssetReady,
  type AssetSearchFilters,
  type AssetSortKey,
} from "../db/repository.js";
import { PROJECT_ID_ALL } from "@twio/shared";
import { assetAbsolutePath, getFolders, getProjectRow, revealInExplorer } from "./folders.js";
import { clampInt, projectOfQuery } from "./helpers.js";

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  // --- Asset search + manual shot/asset assignment ----------------------------
  // Search the discovered/downloaded asset pool. Supports two modes:
  //   1. Legacy free-text: ?q=...&limit=...&project=... (backward compatible)
  //   2. Structured filters: any of provider/creator/tag/title/minDuration/
  //      maxDuration/minWidth/minHeight/maxWidth/maxHeight/orientation/
  //      downloadedOnly/discoveredOnly/commercialStatus/rightsReviewStatus/
  //      sourceLicense/minRating/maxRating/minScore/maxScore/discoveredAfter/
  //      discoveredBefore/downloadedAfter/downloadedBefore/sort/limit/project
  //
  // When any structured filter (other than q/limit/project) is present, the
  // structured path is used; otherwise the legacy free-text path runs.
  app.get("/api/assets/search", async (req) => {
    const query = req.query as Record<string, unknown>;
    const projectId = projectOfQuery(query);
    const limit = clampInt(query.limit, 1, 500, 50) ?? 50;
    const q = ((query.q as string | undefined) ?? "").toString().trim();

    // Detect whether any structured filter is present (excluding the legacy
    // params q/limit/project). If so, take the structured path.
    const structuredKeys = [
      "provider", "creator", "tag", "title",
      "minDuration", "maxDuration", "minWidth", "minHeight", "maxWidth", "maxHeight",
      "orientation", "downloadedOnly", "discoveredOnly",
      "commercialStatus", "rightsReviewStatus", "sourceLicense",
      "minRating", "maxRating", "minScore", "maxScore",
      "discoveredAfter", "discoveredBefore", "downloadedAfter", "downloadedBefore",
      "sort",
    ];
    const hasStructured = structuredKeys.some((k) => query[k] != null && query[k] !== "");

    if (!hasStructured) {
      return { query: q, assets: searchAssets(q, projectId, limit) };
    }

    const num = (v: unknown): number | undefined => {
      if (v == null || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (v: unknown): string | undefined => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s === "" ? undefined : s;
    };
    const bool = (v: unknown): boolean | undefined => {
      if (v == null || v === "") return undefined;
      if (v === true || v === 1 || v === "1" || v === "true" || v === "True") return true;
      if (v === false || v === 0 || v === "0" || v === "false" || v === "False") return false;
      return undefined;
    };

    const filters: AssetSearchFilters = {
      q: q || undefined,
      provider: str(query.provider),
      creator: str(query.creator),
      tag: str(query.tag),
      title: str(query.title),
      minDuration: num(query.minDuration),
      maxDuration: num(query.maxDuration),
      minWidth: num(query.minWidth),
      minHeight: num(query.minHeight),
      maxWidth: num(query.maxWidth),
      maxHeight: num(query.maxHeight),
      orientation: str(query.orientation),
      downloadedOnly: bool(query.downloadedOnly),
      discoveredOnly: bool(query.discoveredOnly),
      commercialStatus: str(query.commercialStatus),
      rightsReviewStatus: str(query.rightsReviewStatus),
      sourceLicense: str(query.sourceLicense),
      minRating: num(query.minRating),
      maxRating: num(query.maxRating),
      minScore: num(query.minScore),
      maxScore: num(query.maxScore),
      discoveredAfter: str(query.discoveredAfter),
      discoveredBefore: str(query.discoveredBefore),
      downloadedAfter: str(query.downloadedAfter),
      downloadedBefore: str(query.downloadedBefore),
      sort: str(query.sort) as AssetSortKey | undefined,
      limit,
    };
    const assets = searchAssetsAdvanced(filters, projectId);
    return { query: q, filters, count: assets.length, assets };
  });

  // --- Copy asset to another project (multi-project) -------------------------
  app.post("/api/assets/:id/copy", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { toProjectId?: string; targetShotId?: string | null };
    const toProjectId = (body.toProjectId ?? "").toString();
    if (!toProjectId) return reply.code(400).send({ error: "toProjectId required" });
    if (toProjectId === PROJECT_ID_ALL) return reply.code(400).send({ error: "cannot copy to All Projects" });
    try {
      const r = copyAssetToProject({ assetId: id, toProjectId, targetShotId: body.targetShotId ?? null });
      return { ok: true, result: r };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // --- Assets ----------------------------------------------------------------
  app.get("/api/folders", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    return getFolders(projectId);
  });

  // Open the folder the project keeps its asset files in — the same
  // "footage root" the Folders page reports (OUTPUT_ROOT/<slug>/assets, or
  // OUTPUT_ROOT itself for the virtual All Projects view).
  app.post("/api/folders/reveal", async (req, reply) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (projectId === PROJECT_ID_ALL) return revealInExplorer(OUTPUT_ROOT);
    const p = getProjectRow(projectId);
    if (!p) return reply.code(404).send({ ok: false, error: "project not found" });
    return revealInExplorer(projectPaths(p.slug).assets);
  });

  app.post("/api/assets/:id/reveal", async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = getAsset(id);
    if (!a?.local_path) return reply.code(404).send({ ok: false, error: "no local file" });
    const abs = assetAbsolutePath(a.local_path);
    return revealInExplorer(abs);
  });

  app.post("/api/assets/:id/ready", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { ready?: boolean } | null;
    const a = getAsset(id);
    if (!a) return reply.code(404).send({ ok: false, error: "asset not found" });
    const ready = body?.ready ?? !(a.ready !== 0);
    setAssetReady(id, ready);
    return { ok: true, id, ready };
  });

  app.post("/api/assets/:id/rating", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { rating?: number | null } | null;
    const a = getAsset(id);
    if (!a) return reply.code(404).send({ ok: false, error: "asset not found" });
    const raw = body?.rating ?? null;
    const rating = raw == null ? null : Math.max(0, Math.min(10, Math.round(raw)));
    setAssetRating(id, rating);
    return { ok: true, id, rating };
  });

  app.get("/api/assets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const asset = getAsset(id);
    if (!asset) return reply.code(404).send({ error: "not found" });
    return asset;
  });
  app.get("/api/assets/:id/file", async (req, reply) => {
    const a = getAsset((req.params as { id: string }).id);
    if (!a?.local_path) return reply.code(404).send({ error: "no local file" });
    const abs = resolve(OUTPUT_ROOT, a.local_path);
    if (!existsSync(abs)) return reply.code(404).send({ error: "file missing" });
    reply.type(mediaMimeForFile(a.local_path));
    return reply.send(createReadStream(abs));
  });
  // Legacy thumbs were written at source resolution (0.5–3 MB each) — far
  // too heavy for grid views (a full Library page fetched hundreds of MB).
  // Anything over the budget is re-encoded once, in place, on first serve.
  const THUMB_SERVE_MAX_BYTES = 200 * 1024;
  app.get("/api/assets/:id/thumb", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dest = resolve(THUMBNAILS_DIR, `${basename(id)}.jpg`);
    if (!existsSync(dest)) return reply.code(404).send({ error: "no thumbnail" });
    if (statSync(dest).size > THUMB_SERVE_MAX_BYTES) {
      const tmp = `${dest}.tmp`;
      try {
        await sharp(dest)
          .rotate() // honor EXIF orientation
          .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 78, mozjpeg: true })
          .toFile(tmp);
        renameSync(tmp, dest);
      } catch {
        try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
      }
    }
    const st = statSync(dest);
    const ims = Date.parse(req.headers["if-modified-since"] ?? "");
    if (!Number.isNaN(ims) && Math.floor(st.mtimeMs / 1000) <= Math.floor(ims / 1000)) {
      return reply.code(304).send();
    }
    reply.header("Cache-Control", "public, max-age=86400");
    reply.header("Last-Modified", st.mtime.toUTCString());
    reply.type("image/jpeg");
    return reply.send(createReadStream(dest));
  });
}
