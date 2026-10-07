// =============================================================================
// Beat analysis — decodes the song through the shared FFmpeg service to mono
// f32le PCM, then runs the built-in beat tracker (beatAnalyzer.ts: spectral-
// flux onset envelope + dynamic-programming beat sequence). No Python, no
// external runtime — ffmpeg is the only dependency. Results are cached by
// song content hash so each song is analysed once.
// =============================================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BeatAnalysis, BeatPoint } from "@twio/shared";
import { OUTPUT_ROOT } from "../config.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { probeAudio, type AudioProbeResult } from "../video/ffprobe.js";
import { analyzePcm, ANALYZER_NAME, ANALYZER_VERSION } from "./beatAnalyzer.js";
import { assertValidBeatTimes } from "./edl.js";
import { MusicEditError } from "./errors.js";

const ANALYSIS_SAMPLE_RATE = 22050;
const HOP_LENGTH = 256;
const CACHE_VERSION = 2;
const CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "beats");

export interface AnalyzerStatus {
  ok: boolean;
  engine: string;
  detail: string;
}

/** The analyzer is built in; the only external need is ffmpeg for decoding. */
export async function analyzerStatus(): Promise<AnalyzerStatus> {
  try {
    const version = await ffmpegService.version();
    const ffmpegVersion = version.match(/ffmpeg\s+version\s+(\S+)/i)?.[1]?.split(/[-\s]/)[0] ?? "unknown";
    return {
      ok: true,
      engine: `${ANALYZER_NAME}@${ANALYZER_VERSION}`,
      detail: `built-in tracker · ffmpeg ${ffmpegVersion}`,
    };
  } catch (e) {
    return { ok: false, engine: `${ANALYZER_NAME}@${ANALYZER_VERSION}`, detail: (e as Error).message };
  }
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

function intervalStats(times: number[]): BeatAnalysis["interval"] {
  if (times.length < 2) return { min: 0, max: 0, mean: 0, stdDev: 0 };
  const ibi = times.slice(1).map((t, i) => t - times[i]!);
  const mean = ibi.reduce((s, v) => s + v, 0) / ibi.length;
  const variance = ibi.reduce((s, v) => s + (v - mean) ** 2, 0) / ibi.length;
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return { min: r(Math.min(...ibi)), max: r(Math.max(...ibi)), mean: r(mean), stdDev: r(Math.sqrt(variance)) };
}

/** Validate an analyzer result (untrusted/cached data). */
export function parseAnalyzerOutput(raw: unknown): BeatAnalysis {
  const o = raw as Partial<Record<string, unknown>> | null;
  if (!o || typeof o !== "object") throw new MusicEditError(500, "BEAT_ANALYSIS_FAILED", "Beat analyzer returned no result.");
  const bpm = Number(o.bpm);
  const duration = Number(o.duration);
  if (!Array.isArray(o.beats)) throw new MusicEditError(500, "BEAT_ANALYSIS_FAILED", "Beat analyzer returned no beat list.");
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MusicEditError(422, "CORRUPT_AUDIO", "Decoded audio has no duration.");
  }
  const beats: BeatPoint[] = (o.beats as Array<{ time?: unknown; strength?: unknown }>).map((b) => ({
    time: Number(b?.time),
    strength: typeof b?.strength === "number" && Number.isFinite(b.strength) ? b.strength : null,
  }));
  if (beats.length < 2 || !Number.isFinite(bpm) || bpm <= 0) {
    throw new MusicEditError(422, "NO_BEATS_DETECTED", `No usable beat was detected in the audio (${beats.length} beats).`);
  }
  const times = beats.map((b) => b.time);
  assertValidBeatTimes(times, duration);
  const analyzer = (o.analyzer ?? {}) as Partial<BeatAnalysis["analyzer"]>;
  return {
    bpm,
    duration,
    beats,
    downbeats: Array.isArray(o.downbeats) ? (o.downbeats as number[]) : null,
    analyzer: {
      name: String(analyzer.name ?? "unknown"),
      version: String(analyzer.version ?? "unknown"),
      sampleRate: Number(analyzer.sampleRate ?? ANALYSIS_SAMPLE_RATE),
      hopLength: Number(analyzer.hopLength ?? HOP_LENGTH),
    },
    interval: intervalStats(times),
  };
}

export interface AnalyzedSong {
  analysis: BeatAnalysis;
  audio: AudioProbeResult;
  sha256: string;
  cached: boolean;
}

export async function analyzeSong(songPath: string, opts: { useCache?: boolean } = {}): Promise<AnalyzedSong> {
  if (!existsSync(songPath)) throw new MusicEditError(404, "AUDIO_NOT_FOUND", `Song file not found: ${songPath}`);
  let audio: AudioProbeResult;
  try {
    audio = await probeAudio(songPath);
  } catch (e) {
    throw new MusicEditError(422, "CORRUPT_AUDIO", `Cannot read audio: ${(e as Error).message}`);
  }
  const sha256 = await sha256File(songPath);
  const cachePath = join(CACHE_DIR, `${sha256}-sr${ANALYSIS_SAMPLE_RATE}-h${HOP_LENGTH}-v${CACHE_VERSION}.json`);
  if (opts.useCache !== false && existsSync(cachePath)) {
    try {
      return { analysis: parseAnalyzerOutput(JSON.parse(readFileSync(cachePath, "utf8"))), audio, sha256, cached: true };
    } catch {
      // Unreadable cache entry — re-analyse below.
    }
  }

  const tmp = await mkdtemp(join(tmpdir(), "twio-beats-"));
  try {
    const pcm = join(tmp, "audio.f32");
    const dec = await ffmpegService.ffmpegExec(
      ["-v", "error", "-y", "-i", songPath, "-map", "0:a:0", "-ac", "1", "-ar", String(ANALYSIS_SAMPLE_RATE), "-c:a", "pcm_f32le", "-f", "f32le", pcm],
      "beat-decode",
    );
    if (dec.exitCode !== 0) {
      throw new MusicEditError(422, "CORRUPT_AUDIO", `FFmpeg could not decode the song: ${dec.stderr.trim().slice(-500)}`);
    }
    const buf = readFileSync(pcm);
    const bytes = Math.floor(buf.length / 4) * 4;
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes));
    const raw = analyzePcm(samples, ANALYSIS_SAMPLE_RATE, HOP_LENGTH);
    const analysis = parseAnalyzerOutput(raw);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(raw));
    return { analysis, audio, sha256, cached: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
