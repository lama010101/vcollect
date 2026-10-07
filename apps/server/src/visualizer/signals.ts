// =============================================================================
// Stem signal payloads — the binary [meta][peaks][env][stereo][features] blob
// the browser preview consumes. Building it means an ffmpeg decode + full-PCM
// peak/env scans (+ optional engine features), so the finished blob is cached
// on disk keyed by the stem file's sha256 — same convention as cache/engine
// and cache/beats. Re-uploads get a new hash automatically; app restarts and
// page reloads just re-send the cached bytes.
// =============================================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPeakSeries, buildStemSignal, ENV_RATE, PEAK_RATE, type StemSignalMeta } from "@twio/shared";
import { OUTPUT_ROOT } from "../config.js";
import { engineStatus } from "../python/pythonService.js";
import { decodeStem } from "./decode.js";
import { stemFeaturesOrNull } from "./features.js";

const SIGNAL_CACHE_VERSION = 1; // bump when the payload layout changes
const CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "viz-signal");

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolvePromise(h.digest("hex")));
  });
}

function cachePath(sha: string, withFeatures: boolean): string {
  return join(CACHE_DIR, `${sha}-v${SIGNAL_CACHE_VERSION}-${withFeatures ? "f" : "nf"}.bin`);
}

function serveCached(path: string): Buffer | null {
  try {
    if (existsSync(path) && statSync(path).size > 4) return readFileSync(path);
  } catch {
    /* fall through to rebuild */
  }
  return null;
}

export interface StemSignalResult {
  payload: Buffer;
  cached: boolean;
}

const inflight = new Map<string, Promise<StemSignalResult>>();
const phases = new Map<string, string>();

/** Coarse build phase for the stem currently being analyzed ("decoding
 *  audio" → "analyzing features" → "assembling"), or null when nothing is
 *  in flight for this file — used by the progress endpoint. */
export function stemSignalPhase(stemFilePath: string): string | null {
  return phases.get(resolve(stemFilePath)) ?? null;
}

async function buildPayload(stemFilePath: string): Promise<StemSignalResult> {
  const sha = await sha256File(stemFilePath);
  // A feature-inclusive blob is strictly better — serve it even when the
  // engine is currently down. The -nf variant is only served when the engine
  // cannot produce features right now.
  const engineUp = (await engineStatus()).ok;
  const best = serveCached(cachePath(sha, true)) ?? (!engineUp ? serveCached(cachePath(sha, false)) : null);
  if (best) return { payload: best, cached: true };

  try {
    phases.set(stemFilePath, "decoding audio");
    const d = await decodeStem(stemFilePath);
    const signal = buildStemSignal(d.pcm, d.sr);
    if (d.stereo) {
      signal.peaksL = buildPeakSeries(d.stereo.pcmL, d.sr);
      signal.peaksR = buildPeakSeries(d.stereo.pcmR, d.sr);
    }
    phases.set(stemFilePath, "analyzing features");
    const feats = await stemFeaturesOrNull(stemFilePath);
    phases.set(stemFilePath, "assembling");

    // Layout: [u32 LE metaLen][meta JSON][peaks][env][peaksL][peaksR][bands][featEnv][onsetEnv].
    const meta: StemSignalMeta = {
      version: 1,
      durationSec: signal.durationSec,
      peaksRate: PEAK_RATE,
      envRate: ENV_RATE,
      counts: {
        peaks: signal.peaks.length,
        env: signal.env.length,
        peaksL: signal.peaksL?.length ?? 0,
        peaksR: signal.peaksR?.length ?? 0,
        bands: feats ? feats.bands.length : 0,
        featEnv: feats ? feats.env.length : 0,
        onsetEnv: feats ? feats.onsetEnv.length : 0,
      },
      features: feats
        ? {
            tempo: feats.tempo,
            featureRate: feats.featureRate,
            frames: feats.frames,
            bandNames: feats.bandNames,
            onsets: feats.onsets,
            beats: feats.beats,
            durationSec: feats.durationSec,
            version: feats.version,
          }
        : null,
    };
    const metaBuf = Buffer.from(JSON.stringify(meta), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(metaBuf.length, 0);
    const f32 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const parts = [head, metaBuf, f32(signal.peaks), f32(signal.env)];
    if (signal.peaksL && signal.peaksR) parts.push(f32(signal.peaksL), f32(signal.peaksR));
    if (feats) parts.push(f32(feats.bands), f32(feats.env), f32(feats.onsetEnv));
    const payload = Buffer.concat(parts);

    mkdirSync(CACHE_DIR, { recursive: true });
    const dest = cachePath(sha, feats != null);
    try {
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, payload);
      renameSync(tmp, dest);
    } catch {
      /* cache write failure must not break the response */
    }
    return { payload, cached: false };
  } finally {
    phases.delete(stemFilePath);
  }
}

/** Binary signal payload for a stem file — sha256-keyed disk cache, plus an
 *  in-flight dedupe so an upload-warm build and the first fetch share work.
 *  Layout: [u32 LE metaLen][meta JSON][f32 arrays] (see StemSignalMeta). */
export function stemSignalPayload(stemFilePath: string): Promise<StemSignalResult> {
  const key = resolve(stemFilePath);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = buildPayload(key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
