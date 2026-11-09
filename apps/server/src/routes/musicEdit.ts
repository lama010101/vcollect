// =============================================================================
// Music edit routes — /api/music-edit/*
//   GET  status                 analyzer availability (built-in tracker + ffmpeg)
//   GET  songs?project=         list project songs
//   POST songs?project=&name=   upload a song (raw body)
//   POST songs/import?project=  { assetId } — copy a library audio asset into
//                               the song pool (drag & drop / folder-sync files)
//   POST analyze?project=       { song } → detected BPM + beat timestamps
//   POST plan?project=          { song, assetIds, settings } → edit decision list
//   POST render?project=        same body → background render job
//   GET  render/:id             job progress / result
//   POST render/:id/cancel
//   GET  renders?project=       rendered MP4s + EDL files
//   POST reveal?project=&name=  open the renders folder (file selected) in the
//                               OS file explorer
//   POST import-session?project=  { sessionId } — reuse a saved 4D-timeline
//                               session: stems → songs pool, media layers →
//                               ordered source-video list
// =============================================================================

import type { FastifyInstance } from "fastify";
import { basename, join } from "node:path";
import { DEFAULT_PROJECT_ID, musicEditAnalyzeSchema, musicEditImportSessionSchema, musicEditPlanSchema } from "@twio/shared";
import { analyzeSong, analyzerStatus } from "../musicEdit/beatAnalysis.js";
import { MusicEditError } from "../musicEdit/errors.js";
import {
  analysisSummary,
  buildPlan,
  cancelRenderJob,
  getRenderJob,
  importSongFromAsset,
  listRenders,
  listSongs,
  MAX_SONG_BYTES,
  projectMusicDir,
  resolveAssetSources,
  saveSong,
  songPath,
  startRenderJob,
} from "../musicEdit/service.js";
import { sessionToMusicEdit } from "../visualizer/sessions.js";
import { revealInExplorer } from "./folders.js";

function projectOf(query: unknown): string {
  const q = ((query as Record<string, unknown>).project as string | undefined)?.trim();
  return q || DEFAULT_PROJECT_ID;
}

function parseBody<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new MusicEditError(400, "INVALID_REQUEST", r.error.message);
  return r.data;
}

export async function registerMusicEditRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/music-edit/status", async () => analyzerStatus());

  app.get("/api/music-edit/songs", async (req) => ({ songs: listSongs(projectOf(req.query)) }));

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ["application/octet-stream", "audio/*"],
      { parseAs: "buffer", bodyLimit: MAX_SONG_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.post("/api/music-edit/songs", async (req) => {
      const name = String((req.query as Record<string, unknown>).name ?? "");
      if (!Buffer.isBuffer(req.body)) {
        throw new MusicEditError(400, "MISSING_AUDIO", "Upload the song as the raw request body (Content-Type: application/octet-stream).");
      }
      return { song: saveSong(projectOf(req.query), name, req.body) };
    });
  });

  // Copy a downloaded audio asset (project=<id>&assetId in the JSON body) into
  // the songs pool — lets a dragged-in mp3/wav become the Video Cutter song
  // without a second upload.
  app.post("/api/music-edit/songs/import", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
    if (!assetId) throw new MusicEditError(400, "MISSING_ASSET", "assetId is required.");
    return { song: await importSongFromAsset(projectOf(req.query), assetId) };
  });

  app.post("/api/music-edit/analyze", async (req) => {
    const { song } = parseBody(musicEditAnalyzeSchema, req.body);
    return { analysis: analysisSummary(await analyzeSong(songPath(projectOf(req.query), song))) };
  });

  app.post("/api/music-edit/plan", async (req) => {
    const input = parseBody(musicEditPlanSchema, req.body);
    const projectId = projectOf(req.query);
    const song = await analyzeSong(songPath(projectId, input.song));
    const sources = await resolveAssetSources(input.assetIds);
    const plan = buildPlan(song, sources, input.settings);
    return {
      analysis: analysisSummary(song),
      sources: sources.map(({ path: _p, ...s }) => s),
      plan,
    };
  });

  app.post("/api/music-edit/render", async (req) => {
    const input = parseBody(musicEditPlanSchema, req.body);
    const projectId = projectOf(req.query);
    const file = songPath(projectId, input.song);
    const song = await analyzeSong(file);
    const sources = await resolveAssetSources(input.assetIds);
    const plan = buildPlan(song, sources, input.settings);
    return { job: startRenderJob(projectId, input.song, { song, sources, plan }, file) };
  });

  app.get("/api/music-edit/render/:id", async (req) => ({ job: getRenderJob((req.params as { id: string }).id) }));

  app.post("/api/music-edit/render/:id/cancel", async (req) => ({ job: cancelRenderJob((req.params as { id: string }).id) }));

  app.get("/api/music-edit/renders", async (req) => ({ renders: listRenders(projectOf(req.query)) }));

  // Reuse a saved 4D-timeline session: restores its media, copies its stems
  // into the songs pool and returns the layer videos as the source list.
  app.post("/api/music-edit/import-session", async (req) => {
    const { sessionId } = parseBody(musicEditImportSessionSchema, req.body);
    return sessionToMusicEdit(projectOf(req.query), sessionId);
  });

  // Open the renders folder (or a specific rendered file selected) in the OS
  // file explorer — basename() keeps the path inside the renders dir.
  app.post("/api/music-edit/reveal", async (req) => {
    const name = String((req.query as Record<string, unknown>).name ?? "");
    const dir = projectMusicDir(projectOf(req.query), "renders");
    return revealInExplorer(name ? join(dir, basename(name)) : dir);
  });
}
