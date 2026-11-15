// =============================================================================
// Cut-grid resolution — turns a CutGridSpec into concrete cut marks.
// Beat-derived grids need only the song's beat analysis; "stem_onsets"
// decodes the chosen stem and "sections" decodes the song — both through
// ffmpegService (the single spawn path) to mono f32le PCM, with results
// cached on disk by content hash like cache/beats.
// =============================================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CutGridSpec } from "@twio/shared";
import { OUTPUT_ROOT } from "../config.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { stemPath } from "../visualizer/service.js";
import type { AnalyzedSong } from "./beatAnalysis.js";
import { bandOnsetEnvelope, type OnsetBand } from "./beatAnalyzer.js";
import {
  buildCutGrid,
  pickOnsetPeaks,
  segmentByEnergy,
  type BuiltCutGrid,
  type CutGridContext,
  type EnergySection,
  type OnsetPeak,
} from "./cutGrid.js";
import { MusicEditError } from "./errors.js";

/** Same decode rate/hop as the beat analysis so envelopes line up. */
const GRID_SAMPLE_RATE = 22050;
const GRID_HOP = 256;
const GRID_CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "cutgrid");
const ONSET_CACHE_VERSION = 1;
const SECTION_CACHE_VERSION = 1;

export interface ResolvedCutGrid extends BuiltCutGrid {
  source: CutGridSpec["source"];
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

/** Decode any audio file to mono f32le PCM at the analysis rate — identical
 *  ffmpeg args to beatAnalysis.analyzeSong's decode step. */
async function decodeMonoPcm(path: string): Promise<Float32Array> {
  const tmp = await mkdtemp(join(tmpdir(), "twio-cutgrid-"));
  try {
    const pcm = join(tmp, "audio.f32");
    const dec = await ffmpegService.ffmpegExec(
      ["-v", "error", "-y", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", String(GRID_SAMPLE_RATE), "-c:a", "pcm_f32le", "-f", "f32le", pcm],
      "cutgrid-decode",
    );
    if (dec.exitCode !== 0) {
      throw new MusicEditError(422, "CORRUPT_AUDIO", `FFmpeg could not decode the audio: ${dec.stderr.trim().slice(-400)}`);
    }
    const buf = readFileSync(pcm);
    const bytes = Math.floor(buf.length / 4) * 4;
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface OnsetEnvelopeCache {
  v: number;
  sr: number;
  hop: number;
  band: string;
  env: number[];
}

/** Band-limited onset envelope for a stem file, cached by content hash +
 *  band (the expensive part — decode + STFT). Peak-picking params are
 *  applied afterwards so threshold/gap tweaks don't re-decode. */
async function stemOnsetEnvelope(stemFile: string, band: OnsetBand): Promise<{ env: Float32Array; sr: number; hop: number }> {
  const sha = await sha256File(stemFile);
  const cachePath = join(GRID_CACHE_DIR, `onsets-${sha}-${band}-sr${GRID_SAMPLE_RATE}-h${GRID_HOP}-v${ONSET_CACHE_VERSION}.json`);
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as OnsetEnvelopeCache;
      if (c.v === ONSET_CACHE_VERSION && Array.isArray(c.env) && c.env.length > 0) {
        return { env: Float32Array.from(c.env), sr: c.sr || GRID_SAMPLE_RATE, hop: c.hop || GRID_HOP };
      }
    } catch {
      // Unreadable cache entry — recompute below.
    }
  }
  const pcm = await decodeMonoPcm(stemFile);
  const env = bandOnsetEnvelope(pcm, GRID_SAMPLE_RATE, GRID_HOP, band);
  mkdirSync(GRID_CACHE_DIR, { recursive: true });
  const rounded = Array.from(env, (v) => Math.round(v * 1e5) / 1e5);
  writeFileSync(cachePath, JSON.stringify({ v: ONSET_CACHE_VERSION, sr: GRID_SAMPLE_RATE, hop: GRID_HOP, band, env: rounded } satisfies OnsetEnvelopeCache));
  return { env, sr: GRID_SAMPLE_RATE, hop: GRID_HOP };
}

async function stemOnsetPeaks(stemFile: string, band: OnsetBand, minGapSec: number, threshold: number): Promise<OnsetPeak[]> {
  const { env, sr, hop } = await stemOnsetEnvelope(stemFile, band);
  return pickOnsetPeaks(env, sr, hop, { minGapSec, threshold });
}

interface SectionCacheFile {
  v: number;
  sr: number;
  sections: EnergySection[];
}

/** RMS-energy sections of the song, cached by song content hash. */
async function songSections(songFile: string, sha256: string): Promise<EnergySection[]> {
  const cachePath = join(GRID_CACHE_DIR, `sections-${sha256}-v${SECTION_CACHE_VERSION}.json`);
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as SectionCacheFile;
      if (c.v === SECTION_CACHE_VERSION && Array.isArray(c.sections)) return c.sections;
    } catch {
      // Unreadable cache entry — recompute below.
    }
  }
  const pcm = await decodeMonoPcm(songFile);
  const sections = segmentByEnergy(pcm, GRID_SAMPLE_RATE);
  mkdirSync(GRID_CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ v: SECTION_CACHE_VERSION, sr: GRID_SAMPLE_RATE, sections } satisfies SectionCacheFile));
  return sections;
}

/** Resolve a grid spec into cut marks. `songFile` is the analysed song's
 *  path (needed to decode PCM for the sections grid); `song` carries the
 *  beat analysis every other source builds on. */
export async function resolveCutGrid(projectId: string, songFile: string, song: AnalyzedSong, spec: CutGridSpec): Promise<ResolvedCutGrid> {
  const ctx: CutGridContext = {
    beats: song.analysis.beats,
    audioDuration: song.audio.durationSeconds,
  };
  if (spec.source === "stem_onsets") {
    // stemPath throws 404 STEM_NOT_FOUND when the name isn't in the pool.
    const path = stemPath(projectId, spec.stem);
    ctx.onsetPeaks = await stemOnsetPeaks(path, spec.band, spec.minGap, spec.threshold);
  } else if (spec.source === "sections") {
    ctx.sections = await songSections(songFile, song.sha256);
  }
  return { ...buildCutGrid(spec, ctx), source: spec.source };
}
