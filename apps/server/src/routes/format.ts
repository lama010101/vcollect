// =============================================================================
// Format routes — /api/format/*
//   POST convert?project=   { assetId, aspect } — reframe a downloaded asset
//                           to 16:9 / 9:16 / 1:1 (center-crop, no upscale)
//   GET  renders?project=   converted MP4s
//   POST reveal?project=&name=  open the format folder (file selected) in the
//                           OS file explorer
// =============================================================================

import type { FastifyInstance } from "fastify";
import { basename, join } from "node:path";
import { DEFAULT_PROJECT_ID, formatConvertSchema } from "@twio/shared";
import { FormatError } from "../format/errors.js";
import { convertAsset, listRenders, projectFormatDir } from "../format/service.js";
import { revealInExplorer } from "./folders.js";

function projectOf(query: unknown): string {
  const q = ((query as Record<string, unknown>).project as string | undefined)?.trim();
  return q || DEFAULT_PROJECT_ID;
}

export async function registerFormatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/format/convert", async (req) => {
    const r = formatConvertSchema.safeParse(req.body);
    if (!r.success) throw new FormatError(400, "INVALID_REQUEST", r.error.message);
    return { file: await convertAsset(projectOf(req.query), r.data.assetId, r.data.aspect, { start: r.data.start, end: r.data.end }) };
  });

  app.get("/api/format/renders", async (req) => ({ renders: listRenders(projectOf(req.query)) }));

  // Open the format folder (or a specific converted file selected) in the OS
  // file explorer — basename() keeps the path inside the format dir.
  app.post("/api/format/reveal", async (req) => {
    const name = String((req.query as Record<string, unknown>).name ?? "");
    const dir = projectFormatDir(projectOf(req.query));
    return revealInExplorer(name ? join(dir, basename(name)) : dir);
  });
}
