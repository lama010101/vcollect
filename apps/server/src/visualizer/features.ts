// =============================================================================
// Stem feature extraction — librosa via the Python engine worker.
//
// Flow: stem file → sha256 → cache lookup (output/cache/engine/<sha>-v<N>/) →
// on miss, ffmpeg decodes to mono 22.05 kHz f32le and the worker writes
// manifest.json + bands.f32 + env.f32 + onset_env.f32 into the cache dir.
//
// Callers decide how to degrade: this module throws ENGINE_UNAVAILABLE when
// the engine cannot run — feature consumers must treat it as "no features",
// never fabricate.
// =============================================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StemFeatures } from "@twio/shared";
import { OUTPUT_ROOT } from "../config.js";
import { engineClient } from "../python/engineClient.js";
import { engineStatus } from "../python/pythonService.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { VisualizerError } from "./errors.js";

export const FEATURE_ANALYSIS_SR = 22050;
export const FEATURES_VERSION = 2; // bump when the manifest/binary shape changes
export const ENGINE_CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "engine");

interface StemManifest {
  version: number;
  duration: number;
  sampleRate: number;
  hopLength: number;
  featureRate: number;
  frames: number;
  tempo: number;
  bands: string[];
  bandRanges: number[][];
  onsets: Array<{ time: number; strength: number }>;
  beats: Array<{ time: number; strength: number }>;
  files: { bands: string; env: string; onsetEnv: string };
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolvePromise(h.digest("hex")));
  });
}

function readF32(path: string): Float32Array {
  const buf = readFileSync(path);
  const bytes = Math.floor(buf.length / 4) * 4;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes));
}

function loadFeatures(cacheDir: string): StemFeatures {
  const manifest = JSON.parse(readFileSync(join(cacheDir, "manifest.json"), "utf8")) as StemManifest;
  const nBands = manifest.bands.length;
  const frames = manifest.frames;
  const bands = readF32(join(cacheDir, manifest.files.bands));
  const env = readF32(join(cacheDir, manifest.files.env));
  const onsetEnv = readF32(join(cacheDir, manifest.files.onsetEnv));
  if (bands.length !== nBands * frames || env.length !== frames || onsetEnv.length !== frames) {
    throw new VisualizerError(500, "FEATURE_CACHE_CORRUPT", "Cached feature arrays do not match the manifest.");
  }
  return {
    version: manifest.version,
    durationSec: manifest.duration,
    tempo: manifest.tempo,
    featureRate: manifest.featureRate,
    frames,
    bandNames: manifest.bands,
    bands,
    env,
    onsetEnv,
    onsets: manifest.onsets,
    beats: manifest.beats,
  };
}

export interface StemFeatureResult {
  features: StemFeatures;
  cached: boolean;
}

/** Extract (or load cached) librosa features for a stem file.
 *  Throws VisualizerError ENGINE_UNAVAILABLE when the engine can't run. */
export async function stemFeatures(stemFilePath: string, opts: { signal?: AbortSignal } = {}): Promise<StemFeatureResult> {
  const sha256 = await sha256File(stemFilePath);
  const cacheDir = join(ENGINE_CACHE_DIR, `${sha256}-v${FEATURES_VERSION}`);
  const manifestPath = join(cacheDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      return { features: loadFeatures(cacheDir), cached: true };
    } catch {
      rmSync(cacheDir, { recursive: true, force: true }); // corrupt cache → recompute
    }
  }

  const tmp = await mkdtemp(join(tmpdir(), "twio-feat-"));
  try {
    const pcmPath = join(tmp, "stem.f32");
    const dec = await ffmpegService.ffmpegExec(
      ["-v", "error", "-y", "-i", stemFilePath, "-map", "0:a:0", "-ac", "1", "-ar", String(FEATURE_ANALYSIS_SR), "-c:a", "pcm_f32le", "-f", "f32le", pcmPath],
      "feat-decode",
      { signal: opts.signal },
    );
    if (dec.exitCode !== 0) {
      throw new VisualizerError(422, "CORRUPT_AUDIO", `FFmpeg could not decode the stem: ${dec.stderr.trim().slice(-500)}`);
    }
    mkdirSync(cacheDir, { recursive: true });
    try {
      await engineClient.call("analyze_stem", { pcm_path: pcmPath, sr: FEATURE_ANALYSIS_SR, out_dir: cacheDir }, { signal: opts.signal });
    } catch (e) {
      rmSync(cacheDir, { recursive: true, force: true });
      const err = e as Error & { code?: string };
      if (err.code === "MISSING_DEP") {
        throw new VisualizerError(503, "ENGINE_UNAVAILABLE", `Python engine is missing dependencies: ${err.message}. Run POST /api/engine/setup.`);
      }
      if (err.code === "ENGINE_DISABLED" || err.code === "ENGINE_NO_PYTHON" || err.code === "ENGINE_VENV_FAILED" || err.code === "ENGINE_DEPS_FAILED" || err.code === "WORKER_SPAWN_FAILED" || err.code === "WORKER_DIED") {
        throw new VisualizerError(503, "ENGINE_UNAVAILABLE", err.message);
      }
      throw new VisualizerError(500, err.code ?? "ENGINE_ERROR", err.message);
    }
    return { features: loadFeatures(cacheDir), cached: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Features when available, null when the engine can't provide them — the
 *  caller's render continues on envelopes alone. Never triggers provisioning:
 *  an un-provisioned engine is a hard skip (setup is opt-in via
 *  POST /api/engine/setup), so signal fetches and renders never block on a
 *  multi-minute pip install. */
export async function stemFeaturesOrNull(stemFilePath: string, opts: { signal?: AbortSignal } = {}): Promise<StemFeatures | null> {
  try {
    const status = await engineStatus();
    if (!status.ok) return null;
    return (await stemFeatures(stemFilePath, opts)).features;
  } catch (e) {
    if (e instanceof VisualizerError && e.code === "ENGINE_UNAVAILABLE") return null;
    throw e;
  }
}
