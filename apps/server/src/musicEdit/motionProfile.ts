// =============================================================================
// Motion profile — per-clip motion-energy curve used by the "align motion to
// cuts" EDL option. Decodes the clip at tiny resolution (64x36 gray, ~12 fps)
// through ffmpegService (the only spawn path), streams rawvideo frames and
// computes mean absolute frame difference per frame — a cheap motion-energy
// proxy. Results are cached on disk by content hash, same convention as
// cache/beats and cache/cutgrid.
// =============================================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OUTPUT_ROOT } from "../config.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { MusicEditError } from "./errors.js";
import { pickOnsetPeaks, type OnsetPeak } from "./cutGrid.js";

const MOTION_W = 64;
const MOTION_H = 36;
const FRAME_BYTES = MOTION_W * MOTION_H;
const MOTION_FPS = 12;
const MOTION_CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "motion");
const CACHE_VERSION = 1;
// Peak-picking for the motion curve: peaks closer than ~0.3 s merge, and the
// relative threshold keeps constant-motion clips (flat curve) peak-free.
const PEAK_MIN_GAP_SEC = 0.3;
const PEAK_THRESHOLD = 0.15;

export interface MotionProfile {
  /** Motion energy per decoded frame (index i ↔ i/MOTION_FPS seconds). */
  energies: number[];
  /** Detected motion peaks, sorted by time. */
  peaks: OnsetPeak[];
  fps: number;
}

interface MotionCacheFile {
  v: number;
  w: number;
  h: number;
  fps: number;
  energies: number[];
  peaks: OnsetPeak[];
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", rej)
      .on("end", () => res(h.digest("hex")));
  });
}

/** Decode → energy curve. Streams rawvideo on stdout; never buffers the
 *  whole file — one frame (2304 B) at a time plus a carry buffer. */
async function decodeMotionCurve(path: string): Promise<Float32Array> {
  const child = await ffmpegService.ffmpegSpawn(
    [
      "-v", "error",
      "-i", path,
      "-vf", `scale=${MOTION_W}:${MOTION_H},format=gray`,
      "-r", String(MOTION_FPS),
      "-f", "rawvideo",
      "pipe:1",
    ],
    {},
  );
  const energies: number[] = [];
  const prev = new Uint8Array(FRAME_BYTES);
  let cur = new Uint8Array(FRAME_BYTES);
  let filled = 0;
  let havePrev = false;

  await new Promise<void>((resolvePromise, reject) => {
    const onErr = (e: Error) => reject(new MusicEditError(422, "MOTION_DECODE_FAILED", `Motion decode failed for ${path}: ${e.message}`));
    child.on("error", onErr);
    child.stderr?.on("data", () => {}); // drain
    child.stdout?.on("data", (chunk: Buffer) => {
      let off = 0;
      while (off < chunk.length) {
        const need = FRAME_BYTES - filled;
        const take = Math.min(need, chunk.length - off);
        cur.set(chunk.subarray(off, off + take), filled);
        filled += take;
        off += take;
        if (filled === FRAME_BYTES) {
          if (havePrev) {
            let sum = 0;
            for (let i = 0; i < FRAME_BYTES; i++) sum += Math.abs(cur[i]! - prev[i]!);
            energies.push(sum / FRAME_BYTES);
          } else {
            energies.push(0);
            havePrev = true;
          }
          prev.set(cur);
          filled = 0;
        }
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new MusicEditError(422, "MOTION_DECODE_FAILED", `Motion decode exited ${code} for ${path}`));
    });
  });
  return Float32Array.from(energies);
}

/** Light 3-tap smoothing [0.25, 0.5, 0.25] — kills single-frame noise without
 *  smearing real motion onsets. */
function smooth3(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    const l = env[Math.max(0, i - 1)]!;
    const c = env[i]!;
    const r = env[Math.min(env.length - 1, i + 1)]!;
    out[i] = 0.25 * l + 0.5 * c + 0.25 * r;
  }
  return out;
}

/** Motion profile for a video file, cached by content hash. `cacheDir`
 *  override exists for tests. */
export async function analyzeMotionFile(path: string, opts: { cacheDir?: string } = {}): Promise<MotionProfile> {
  const cacheDir = opts.cacheDir ?? MOTION_CACHE_DIR;
  const sha = await sha256File(path);
  const cachePath = join(cacheDir, `${sha}-sr${MOTION_FPS}-${MOTION_W}x${MOTION_H}-v${CACHE_VERSION}.json`);
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as MotionCacheFile;
      if (c.v === CACHE_VERSION && Array.isArray(c.energies) && c.energies.length > 0) {
        return { energies: c.energies, peaks: c.peaks ?? [], fps: c.fps || MOTION_FPS };
      }
    } catch {
      // recompute below
    }
  }
  const raw = await decodeMotionCurve(path);
  const sm = smooth3(raw);
  // pickOnsetPeaks(env, sampleRate, hopLength): frame time = i*hop/sr → i/12.
  const peaks = pickOnsetPeaks(sm, MOTION_FPS, 1, { minGapSec: PEAK_MIN_GAP_SEC, threshold: PEAK_THRESHOLD });
  const energies = Array.from(sm, (v) => Math.round(v * 1e4) / 1e4);
  const profile: MotionProfile = { energies, peaks, fps: MOTION_FPS };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ v: CACHE_VERSION, w: MOTION_W, h: MOTION_H, fps: MOTION_FPS, energies, peaks } satisfies MotionCacheFile));
  return profile;
}
