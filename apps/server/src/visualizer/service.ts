// =============================================================================
// Visualizer service — per-project stem files, render jobs and rendered MP4s.
// Mirrors musicEdit/service.ts: stems are plain files under
// OUTPUT_ROOT/<slug>/visualizer/stems/, jobs are in-memory + AbortController.
// =============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { buildPeakSeries, buildStemSignal, isStemAudible, resolveStem, visualizerRenderSchema, type FrameStem, type VisualizerRenderInput } from "@twio/shared";
import { IMAGE_FILE_EXTENSIONS, projectPaths, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { getAsset } from "../db/repository.js";
import { AUDIO_EXTENSIONS, MAX_SONG_BYTES, fileUrl } from "../musicEdit/service.js";
import { assetAbsolutePath } from "../routes/folders.js";
import { probe, probeAudio } from "../video/ffprobe.js";
import { decodeStem } from "./decode.js";
import { VisualizerError } from "./errors.js";
import { stemFeaturesOrNull } from "./features.js";
import { ensureKeyedVideo } from "./keying.js";
import { renderVisualizer, type VizRenderLayer, type VizRenderProgress } from "./render.js";
import { stemSignalPayload } from "./signals.js";

export { MAX_SONG_BYTES };

export function visualizerDir(projectId: string, sub: "stems" | "renders" | "sessions"): string {
  const project = getProject(projectId);
  if (!project || project.isVirtual) throw new VisualizerError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  const dir = resolve(projectPaths(project.slug).output, "visualizer", sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeStemName(name: string): string {
  const base = basename(name).replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 160);
  const ext = extname(base).toLowerCase();
  if (!base || !AUDIO_EXTENSIONS.includes(ext)) {
    throw new VisualizerError(415, "UNSUPPORTED_AUDIO_FORMAT", `Unsupported audio format "${ext || name}". Use ${AUDIO_EXTENSIONS.join(", ")}.`);
  }
  return base;
}

export interface StemInfo {
  name: string;
  sizeBytes: number;
  url: string;
  modifiedAt: string;
  durationSec: number | null;
}

export async function listStems(projectId: string): Promise<StemInfo[]> {
  const dir = visualizerDir(projectId, "stems");
  const names = readdirSync(dir)
    .filter((f) => AUDIO_EXTENSIONS.includes(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const out: StemInfo[] = [];
  for (const f of names) {
    const p = join(dir, f);
    const st = statSync(p);
    let durationSec: number | null = null;
    try {
      durationSec = (await probeAudio(p)).durationSeconds;
    } catch {
      /* unreadable audio still lists — render will reject it */
    }
    out.push({ name: f, sizeBytes: st.size, url: fileUrl(p), modifiedAt: st.mtime.toISOString(), durationSec });
  }
  return out;
}

/** Save an uploaded stem. Verifies it decodes as real audio (never trust ext). */
export async function saveStem(projectId: string, name: string, data: Buffer): Promise<StemInfo> {
  const safe = sanitizeStemName(name);
  if (data.length === 0) throw new VisualizerError(400, "MISSING_AUDIO", "Uploaded stem is empty.");
  const p = join(visualizerDir(projectId, "stems"), safe);
  writeFileSync(p, data);
  try {
    const probe = await probeAudio(p);
    const st = statSync(p);
    // Warm the signal-payload cache in the background so the first preview
    // fetch is instant and the analysis runs exactly once per stem content.
    void stemSignalPayload(p).catch(() => { /* warmup only — fetches retry */ });
    return { name: safe, sizeBytes: st.size, url: fileUrl(p), modifiedAt: st.mtime.toISOString(), durationSec: probe.durationSeconds };
  } catch {
    rmSync(p, { force: true });
    throw new VisualizerError(422, "CORRUPT_AUDIO", `"${safe}" is not a readable audio file.`);
  }
}

export function stemPath(projectId: string, name: string): string {
  if (!name) throw new VisualizerError(400, "MISSING_STEM", "Stem name is required.");
  const p = join(visualizerDir(projectId, "stems"), sanitizeStemName(name));
  if (!existsSync(p)) throw new VisualizerError(404, "STEM_NOT_FOUND", `Stem not found: ${name}`);
  return p;
}

export function deleteStem(projectId: string, name: string): void {
  rmSync(stemPath(projectId, name), { force: true });
}

// --- Render jobs --------------------------------------------------------------

export interface VizRenderJob {
  id: string;
  projectId: string;
  status: "running" | "done" | "failed" | "cancelled";
  progress: VizRenderProgress;
  error: { code: string; message: string } | null;
  outputUrl: string | null;
  /** Absolute filesystem path of the MP4 (for "show in folder"). */
  outputPath: string | null;
  configUrl: string;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  frameCount: number;
}

const jobs = new Map<string, VizRenderJob & { controller: AbortController }>();

function publicJob(j: VizRenderJob & { controller: AbortController }): VizRenderJob {
  const { controller: _c, ...rest } = j;
  return rest;
}

export function startRenderJob(projectId: string, raw: VisualizerRenderInput): VizRenderJob {
  for (const j of jobs.values()) {
    if (j.status === "running") throw new VisualizerError(409, "RENDER_IN_PROGRESS", "Another visualizer render is already running.");
  }
  // Re-validate + resolve stems now so config errors fail fast (HTTP 4xx).
  const cfg = visualizerRenderSchema.parse(raw);
  const resolved = cfg.stems.map((s, i) => resolveStem(s, i));
  for (const s of resolved) stemPath(projectId, s.name); // 404 if missing

  // Layer stack — resolve + validate every media row's project asset now so a
  // bad pick fails the request (4xx) instead of the job. `kind:"visuals"` rows
  // are placeholders keeping the array aligned with cfg.globalVisuals.video
  // .layers (same row order = the render's z-order). Hidden media rows get the
  // same placeholder: nothing draws at that slot, so a stale asset shouldn't
  // fail the render and no decoder/probe/keying work is spent on it.
  const videoLayers: VizRenderLayer[] = [];
  cfg.globalVisuals.video.layers.forEach((l, i) => {
    if (l.kind !== "media" || l.hidden) {
      videoLayers.push({ kind: "visuals" });
      return;
    }
    const a = getAsset(l.assetId);
    if (!a || a.project_id !== projectId) {
      throw new VisualizerError(404, "LAYER_ASSET_NOT_FOUND", `Layer ${i + 1}: asset not found in this project: ${l.assetId}`);
    }
    if (!a.local_path) {
      throw new VisualizerError(422, "LAYER_NOT_DOWNLOADED", `Layer ${i + 1}: asset "${a.title ?? a.id}" has no downloaded file — download it first.`);
    }
    const abs = assetAbsolutePath(a.local_path, "");
    if (!existsSync(abs)) {
      throw new VisualizerError(404, "LAYER_FILE_MISSING", `Layer ${i + 1}: the asset's file is missing on disk: ${a.local_path}`);
    }
    const ext = extname(abs).toLowerCase();
    const isImage = IMAGE_FILE_EXTENSIONS.has(ext);
    if (!isImage && !VIDEO_FILE_EXTENSIONS.has(ext)) {
      throw new VisualizerError(422, "LAYER_UNSUPPORTED_MEDIA", `Layer ${i + 1}: "${a.title ?? a.id}" is neither a video nor an image.`);
    }
    if (isImage && l.key.method === "cutout") {
      throw new VisualizerError(422, "LAYER_CUTOUT_NEEDS_VIDEO", `Layer ${i + 1}: AI cutout applies to videos — image layers already carry their own alpha.`);
    }
    videoLayers.push({ kind: "media", path: abs, isImage, key: l.key, zoomPan: l.zoomPan });
  });

  const dir = visualizerDir(projectId, "renders");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Draft renders get a marker so the fast low-quality pass is easy to spot
  // in the renders list (and won't be mistaken for the final MP4).
  const draftTag = cfg.renderSettings.draft ? "draft-" : "";
  const outPath = join(dir, `viz-${draftTag}${cfg.renderSettings.width}x${cfg.renderSettings.height}-${cfg.renderSettings.fps}fps-${stamp}.mp4`);
  const cfgPath = join(dir, `${basename(outPath, ".mp4")}.viz.json`);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const job: VizRenderJob & { controller: AbortController } = {
    id: randomUUID(),
    projectId,
    status: "running",
    progress: { phase: "decode", done: 0, total: resolved.length },
    error: null,
    outputUrl: null,
    outputPath: outPath,
    configUrl: fileUrl(cfgPath),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationSeconds: null,
    frameCount: 0,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);

  (async () => {
    const anySolo = resolved.some((s) => s.solo);
    const stems: FrameStem[] = [];
    const audiblePaths: string[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const s = resolved[i]!;
      const path = stemPath(projectId, s.name);
      job.progress = { phase: "decode", done: i, total: resolved.length, detail: s.name };
      const d = await decodeStem(path);
      const signal = buildStemSignal(d.pcm, d.sr);
      if (d.stereo) {
        signal.peaksL = buildPeakSeries(d.stereo.pcmL, d.sr);
        signal.peaksR = buildPeakSeries(d.stereo.pcmR, d.sr);
      }
      // Engine features are enrichment — render works without them.
      signal.features = (await stemFeaturesOrNull(path, { signal: job.controller.signal })) ?? undefined;
      stems.push({ cfg: s, signal });
      if (isStemAudible(s, anySolo)) audiblePaths.push(path);
      job.progress = { phase: "decode", done: i + 1, total: resolved.length };
      if (job.controller.signal.aborted) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
    }
    for (const [i, l] of videoLayers.entries()) {
      if (l.kind !== "media" || l.isImage) continue;
      try {
        const pv = await probe(l.path); // throws when there is no decodable video stream
        // Source dims → the decoder's zoom/pan crop filter. ffmpeg autorotates
        // before the filter graph, so use the ORIENTED dims (swap on 90|270);
        // keyed WebMs keep the source dims, so the same rect applies to
        // keyedPath too.
        const swap = pv.rotation === 90 || pv.rotation === 270;
        l.mediaW = (swap ? pv.height : pv.width) ?? undefined;
        l.mediaH = (swap ? pv.width : pv.height) ?? undefined;
      } catch (e) {
        throw new VisualizerError(422, "VIDEO_NOT_PLAYABLE", `Layer ${i + 1}: the selected video is not playable: ${(e as Error).message}`);
      }
      // AI cutout: the engine bakes the matte into a cached VP9-alpha WebM —
      // generated here when the UI didn't already produce one (cache hits are
      // instant, so a prepared preview costs the render nothing).
      if (l.key.method === "cutout") {
        job.progress = { phase: "keying", done: 0, total: 0, detail: `layer ${i + 1}` };
        const keyed = await ensureKeyedVideo(projectId, l.path, l.key, {
          signal: job.controller.signal,
          onProgress: (p) => (job.progress = { phase: "keying", done: p.done, total: p.total, detail: `layer ${i + 1}` }),
        });
        l.keyedPath = keyed.path;
      }
    }
    // "spectrum" draws real band envelopes — without engine features there is
    // nothing to show, so fail fast instead of rendering flat bars. Every
    // waveform layer counts: a row with its own `visuals` may be set to
    // spectrum even when the global mode isn't.
    const needsSpectrum =
      cfg.globalVisuals.video.layers.some((l) => l.kind === "visuals" && (l.visuals?.mode ?? cfg.globalVisuals.mode) === "spectrum");
    if (needsSpectrum && !stems.some((s) => s.signal.features)) {
      throw new VisualizerError(
        422,
        "ENGINE_REQUIRED",
        'Mode "spectrum" needs Python engine features (band envelopes). Run POST /api/engine/setup to provision the managed venv, then retry.',
      );
    }
    return renderVisualizer(cfg, stems, {
      audiblePaths,
      outPath,
      videoLayers,
      signal: job.controller.signal,
      onProgress: (p) => (job.progress = p),
    });
  })()
    .then((r) => {
      job.status = "done";
      job.outputUrl = fileUrl(outPath);
      job.durationSeconds = r.durationSeconds;
      job.frameCount = r.frames;
    })
    .catch((e: Error & { code?: string }) => {
      job.status = job.controller.signal.aborted || (e as Error).name === "AbortError" ? "cancelled" : "failed";
      job.error = { code: e.code ?? "RENDER_FAILED", message: e.message };
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return publicJob(job);
}

export function getRenderJob(id: string): VizRenderJob {
  const j = jobs.get(id);
  if (!j) throw new VisualizerError(404, "RENDER_NOT_FOUND", `Render job not found: ${id}`);
  return publicJob(j);
}

export function cancelRenderJob(id: string): VizRenderJob {
  const j = jobs.get(id);
  if (!j) throw new VisualizerError(404, "RENDER_NOT_FOUND", `Render job not found: ${id}`);
  // abort() synchronously emits 'error' on every child spawned with this
  // signal — if any lacks an 'error' listener the emit throws back up through
  // this route, so guard it. Render teardown still runs via the aborted flag.
  if (j.status === "running") {
    try {
      j.controller.abort();
    } catch {
      /* swallowed — job is marked cancelled by the render loop */
    }
  }
  return publicJob(j);
}

export interface VizRenderedFile {
  name: string;
  url: string;
  configUrl: string | null;
  /** Absolute filesystem path (for "show in folder"). */
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export function listRenders(projectId: string): VizRenderedFile[] {
  const dir = visualizerDir(projectId, "renders");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      const cfg = join(dir, f.replace(/\.mp4$/, ".viz.json"));
      return { name: f, url: fileUrl(p), configUrl: existsSync(cfg) ? fileUrl(cfg) : null, path: p, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
