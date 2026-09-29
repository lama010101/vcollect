// =============================================================================
// Music edit service — songs per project, source resolution (downloaded
// assets or plain files), plan building and background render jobs.
// =============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { BeatAnalysis, EditPlan, MusicEditSettings } from "@twio/shared";
import { OUTPUT_ROOT, projectPaths } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { getAsset } from "../db/repository.js";
import { assetAbsolutePath } from "../routes/folders.js";
import { probe } from "../video/ffprobe.js";
import { analyzeSong, type AnalyzedSong } from "./beatAnalysis.js";
import { planEdit, type PlanSource } from "./edl.js";
import { MusicEditError } from "./errors.js";
import { renderEdit, type RenderProgress, type RenderSource } from "./render.js";

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus"];
export const MAX_SONG_BYTES = 300 * 1024 * 1024;

export interface ResolvedSource extends PlanSource {
  path: string;
}

function projectMusicDir(projectId: string, sub: "songs" | "renders"): string {
  const project = getProject(projectId);
  if (!project || project.isVirtual) throw new MusicEditError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  const dir = resolve(projectPaths(project.slug).output, "music_edit", sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Public /files/ URL for a path under OUTPUT_ROOT. */
export function fileUrl(absPath: string): string {
  return "/files/" + relative(OUTPUT_ROOT, absPath).split(sep).map(encodeURIComponent).join("/");
}

export function sanitizeSongName(name: string): string {
  const base = basename(name).replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 160);
  const ext = extname(base).toLowerCase();
  if (!base || !AUDIO_EXTENSIONS.includes(ext)) {
    throw new MusicEditError(415, "UNSUPPORTED_AUDIO_FORMAT", `Unsupported audio format "${ext || name}". Use ${AUDIO_EXTENSIONS.join(", ")}.`);
  }
  return base;
}

export interface SongInfo {
  name: string;
  sizeBytes: number;
  url: string;
  modifiedAt: string;
}

export function listSongs(projectId: string): SongInfo[] {
  const dir = projectMusicDir(projectId, "songs");
  return readdirSync(dir)
    .filter((f) => AUDIO_EXTENSIONS.includes(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      return { name: f, sizeBytes: st.size, url: fileUrl(p), modifiedAt: st.mtime.toISOString() };
    });
}

export function saveSong(projectId: string, name: string, data: Buffer): SongInfo {
  const safe = sanitizeSongName(name);
  if (data.length === 0) throw new MusicEditError(400, "MISSING_AUDIO", "Uploaded song is empty.");
  const p = join(projectMusicDir(projectId, "songs"), safe);
  writeFileSync(p, data);
  const st = statSync(p);
  return { name: safe, sizeBytes: st.size, url: fileUrl(p), modifiedAt: st.mtime.toISOString() };
}

export function songPath(projectId: string, name: string): string {
  if (!name) throw new MusicEditError(400, "MISSING_AUDIO", "Select a song.");
  const p = join(projectMusicDir(projectId, "songs"), sanitizeSongName(name));
  if (!existsSync(p)) throw new MusicEditError(404, "AUDIO_NOT_FOUND", `Song not found: ${name}`);
  return p;
}

/** Probe one video file into a planner source. */
export async function probeSource(id: string, label: string, path: string): Promise<ResolvedSource> {
  if (!existsSync(path)) throw new MusicEditError(404, "VIDEO_FILE_MISSING", `Video file for "${label}" is missing: ${path}`);
  let p;
  try {
    p = await probe(path);
  } catch (e) {
    throw new MusicEditError(422, "CORRUPT_VIDEO", `Cannot read video "${label}": ${(e as Error).message}`);
  }
  if (!p.durationSeconds || p.durationSeconds <= 0 || !p.width || !p.height) {
    throw new MusicEditError(422, "CORRUPT_VIDEO", `Video "${label}" has no usable duration or dimensions.`);
  }
  return { id, label, path, duration: p.durationSeconds, width: p.width, height: p.height };
}

function assertUnique(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new MusicEditError(400, "DUPLICATE_SOURCE_VIDEO", `Video ${id} is listed more than once.`);
    seen.add(id);
  }
}

/** Resolve ordered asset ids to downloaded local files. */
export async function resolveAssetSources(assetIds: string[]): Promise<ResolvedSource[]> {
  if (assetIds.length === 0) throw new MusicEditError(400, "NO_SOURCE_VIDEOS", "Select at least one source video.");
  assertUnique(assetIds);
  return Promise.all(
    assetIds.map((id) => {
      const a = getAsset(id);
      if (!a) throw new MusicEditError(404, "VIDEO_NOT_FOUND", `Video asset not found: ${id}`);
      if (!a.local_path) throw new MusicEditError(422, "VIDEO_NOT_DOWNLOADED", `Video "${a.title ?? id}" has not been downloaded.`);
      return probeSource(id, basename(a.local_path), assetAbsolutePath(a.local_path, ""));
    }),
  );
}

/** Resolve ordered plain file paths (CLI / tests). Ids are the file paths. */
export async function resolveFileSources(paths: string[]): Promise<ResolvedSource[]> {
  if (paths.length === 0) throw new MusicEditError(400, "NO_SOURCE_VIDEOS", "Select at least one source video.");
  const abs = paths.map((p) => resolve(p));
  assertUnique(abs);
  return Promise.all(abs.map((p) => probeSource(p, basename(p), p)));
}

export interface PreparedEdit {
  song: AnalyzedSong;
  sources: ResolvedSource[];
  plan: EditPlan;
}

export function buildPlan(song: AnalyzedSong, sources: ResolvedSource[], settings: MusicEditSettings): EditPlan {
  return planEdit({
    beatTimes: song.analysis.beats.map((b) => b.time),
    bpm: song.analysis.bpm,
    audioDuration: song.audio.durationSeconds,
    sources,
    settings,
  });
}

export async function prepareEdit(songFile: string, sources: ResolvedSource[], settings: MusicEditSettings): Promise<PreparedEdit> {
  const song = await analyzeSong(songFile);
  return { song, sources, plan: buildPlan(song, sources, settings) };
}

export function renderSourceMap(sources: ResolvedSource[]): Map<string, RenderSource> {
  return new Map(sources.map((s) => [s.id, { path: s.path, duration: s.duration }]));
}

/** Analysis summary for the API (song-level facts + beats). */
export function analysisSummary(song: AnalyzedSong): BeatAnalysis & { audioDuration: number; audioCodec: string; cached: boolean } {
  return { ...song.analysis, audioDuration: song.audio.durationSeconds, audioCodec: song.audio.codec, cached: song.cached };
}

// --- Render jobs --------------------------------------------------------------

export interface RenderJob {
  id: string;
  projectId: string;
  status: "running" | "done" | "failed" | "cancelled";
  progress: RenderProgress;
  error: { code: string; message: string } | null;
  outputUrl: string | null;
  edlUrl: string;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  segmentCount: number;
}

const jobs = new Map<string, RenderJob & { controller: AbortController }>();

function publicJob(j: RenderJob & { controller: AbortController }): RenderJob {
  const { controller: _c, ...rest } = j;
  return rest;
}

export function startRenderJob(projectId: string, songName: string, prepared: PreparedEdit, audioSongPath: string): RenderJob {
  for (const j of jobs.values()) {
    if (j.status === "running") throw new MusicEditError(409, "RENDER_IN_PROGRESS", "Another music-video render is already running.");
  }
  const dir = projectMusicDir(projectId, "renders");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `${basename(songName, extname(songName))}-${prepared.plan.timing === "detected_beats" ? `${prepared.plan.beatsPerCut}beat` : "grid"}-${stamp}`;
  const outPath = join(dir, `${stem}.mp4`);
  const edlPath = join(dir, `${stem}.edl.json`);
  writeFileSync(edlPath, JSON.stringify({ song: songName, sources: prepared.sources.map(({ path: _p, ...s }) => s), plan: prepared.plan }, null, 2));
  const job: RenderJob & { controller: AbortController } = {
    id: randomUUID(),
    projectId,
    status: "running",
    progress: { phase: "segments", done: 0, total: prepared.plan.entries.length },
    error: null,
    outputUrl: null,
    edlUrl: fileUrl(edlPath),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationSeconds: null,
    segmentCount: prepared.plan.entries.length,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  renderEdit(prepared.plan, renderSourceMap(prepared.sources), {
    songPath: audioSongPath,
    audioCodec: prepared.song.audio.codec,
    outPath,
    signal: job.controller.signal,
    onProgress: (p) => (job.progress = p),
  })
    .then((r) => {
      job.status = "done";
      job.outputUrl = fileUrl(outPath);
      job.durationSeconds = r.durationSeconds;
    })
    .catch((e: Error & { code?: string }) => {
      job.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = { code: e.code ?? "RENDER_FAILED", message: e.message };
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return publicJob(job);
}

export function getRenderJob(id: string): RenderJob {
  const j = jobs.get(id);
  if (!j) throw new MusicEditError(404, "RENDER_NOT_FOUND", `Render job not found: ${id}`);
  return publicJob(j);
}

export function cancelRenderJob(id: string): RenderJob {
  const j = jobs.get(id);
  if (!j) throw new MusicEditError(404, "RENDER_NOT_FOUND", `Render job not found: ${id}`);
  if (j.status === "running") j.controller.abort();
  return publicJob(j);
}

export interface RenderedFile {
  name: string;
  url: string;
  edlUrl: string | null;
  sizeBytes: number;
  createdAt: string;
}

export function listRenders(projectId: string): RenderedFile[] {
  const dir = projectMusicDir(projectId, "renders");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      const edl = join(dir, f.replace(/\.mp4$/, ".edl.json"));
      return { name: f, url: fileUrl(p), edlUrl: existsSync(edl) ? fileUrl(edl) : null, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
