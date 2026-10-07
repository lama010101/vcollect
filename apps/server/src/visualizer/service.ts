// =============================================================================
// Visualizer service — per-project stem files, render jobs and rendered MP4s.
// Mirrors musicEdit/service.ts: stems are plain files under
// OUTPUT_ROOT/<slug>/visualizer/stems/, jobs are in-memory + AbortController.
// =============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { buildPeakSeries, buildStemSignal, isStemAudible, resolveStem, visualizerRenderSchema, type FrameStem, type VisualizerRenderInput } from "@twio/shared";
import { projectPaths } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { getAsset } from "../db/repository.js";
import { AUDIO_EXTENSIONS, MAX_SONG_BYTES, fileUrl } from "../musicEdit/service.js";
import { assetAbsolutePath } from "../routes/folders.js";
import { probe, probeAudio } from "../video/ffprobe.js";
import { decodeStem } from "./decode.js";
import { VisualizerError } from "./errors.js";
import { stemFeaturesOrNull } from "./features.js";
import { renderVisualizer, type VizRenderProgress } from "./render.js";
import { stemSignalPayload } from "./signals.js";

export { MAX_SONG_BYTES };

export function visualizerDir(projectId: string, sub: "stems" | "renders"): string {
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

  // Optional video layer — resolve + validate the project asset now so a bad
  // pick fails the request (4xx) instead of the job.
  const vcfg = cfg.globalVisuals.video;
  let video: { path: string; layer: typeof vcfg.layer; opacity: number; chromaKey: typeof vcfg.chromaKey } | null = null;
  if (vcfg.assetId) {
    const a = getAsset(vcfg.assetId);
    if (!a || a.project_id !== projectId) {
      throw new VisualizerError(404, "VIDEO_ASSET_NOT_FOUND", `Video asset not found in this project: ${vcfg.assetId}`);
    }
    if (!a.local_path) {
      throw new VisualizerError(422, "VIDEO_NOT_DOWNLOADED", `Asset "${a.title ?? a.id}" has no downloaded file — download it first.`);
    }
    const abs = assetAbsolutePath(a.local_path, "");
    if (!existsSync(abs)) {
      throw new VisualizerError(404, "VIDEO_FILE_MISSING", `The asset's file is missing on disk: ${a.local_path}`);
    }
    video = { path: abs, layer: vcfg.layer, opacity: vcfg.opacity, chromaKey: vcfg.chromaKey };
  }

  const dir = visualizerDir(projectId, "renders");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(dir, `viz-${cfg.renderSettings.width}x${cfg.renderSettings.height}-${cfg.renderSettings.fps}fps-${stamp}.mp4`);
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
    if (video) {
      try {
        await probe(video.path); // throws when there is no decodable video stream
      } catch (e) {
        throw new VisualizerError(422, "VIDEO_NOT_PLAYABLE", `The selected video is not playable: ${(e as Error).message}`);
      }
    }
    // "spectrum" draws real band envelopes — without engine features there is
    // nothing to show, so fail fast instead of rendering flat bars.
    if (cfg.globalVisuals.mode === "spectrum" && !stems.some((s) => s.signal.features)) {
      throw new VisualizerError(
        422,
        "ENGINE_REQUIRED",
        'Mode "spectrum" needs Python engine features (band envelopes). Run POST /api/engine/setup to provision the managed venv, then retry.',
      );
    }
    return renderVisualizer(cfg, stems, {
      audiblePaths,
      outPath,
      video,
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
  if (j.status === "running") j.controller.abort();
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
