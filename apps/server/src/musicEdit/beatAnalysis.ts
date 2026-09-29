// =============================================================================
// Beat analysis — decodes the song through the shared FFmpeg service, then
// runs apps/server/python/beat_analysis.py (librosa) on the PCM. Results are
// cached by song content hash so each song is analysed once.
// =============================================================================

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BeatAnalysis, BeatPoint } from "@twio/shared";
import { config, OUTPUT_ROOT, PROJECT_ROOT } from "../config.js";
import { ffmpegService } from "../video/ffmpeg.js";
import { probeAudio, type AudioProbeResult } from "../video/ffprobe.js";
import { assertValidBeatTimes } from "./edl.js";
import { MusicEditError } from "./errors.js";

export const ANALYZER_SCRIPT = resolve(PROJECT_ROOT, "apps", "server", "python", "beat_analysis.py");
const ANALYSIS_SAMPLE_RATE = 22050;
const HOP_LENGTH = 256;
const CACHE_VERSION = 1;
const CACHE_DIR = resolve(OUTPUT_ROOT, "cache", "beats");

export function pythonBin(): string {
  return config.pythonBinPath || (process.platform === "win32" ? "python" : "python3");
}

interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runPython(args: string[]): Promise<ProcResult> {
  const bin = pythonBin();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      reject(
        new MusicEditError(
          500,
          "PYTHON_UNAVAILABLE",
          `Cannot start Python (${bin}): ${e.message}. Install Python 3 and set PYTHON_BIN_PATH if it is not on PATH.`,
        ),
      ),
    );
    child.on("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
  });
}

export interface AnalyzerStatus {
  ok: boolean;
  python: string;
  detail: string;
}

/** Checks the interpreter can import the analyzer's dependencies. */
export async function analyzerStatus(): Promise<AnalyzerStatus> {
  try {
    const r = await runPython(["-c", "import librosa, soundfile; print(librosa.__version__)"]);
    if (r.exitCode === 0) return { ok: true, python: pythonBin(), detail: `librosa ${r.stdout.trim()}` };
    return { ok: false, python: pythonBin(), detail: r.stderr.trim().split("\n").pop() ?? "import failed" };
  } catch (e) {
    return { ok: false, python: pythonBin(), detail: (e as Error).message };
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

/** Validate the analyzer's JSON (untrusted process output). */
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
    const wav = join(tmp, "audio.wav");
    const dec = await ffmpegService.ffmpegExec(
      ["-v", "error", "-y", "-i", songPath, "-map", "0:a:0", "-ac", "1", "-ar", String(ANALYSIS_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", wav],
      "beat-decode",
    );
    if (dec.exitCode !== 0) {
      throw new MusicEditError(422, "CORRUPT_AUDIO", `FFmpeg could not decode the song: ${dec.stderr.trim().slice(-500)}`);
    }
    const r = await runPython([ANALYZER_SCRIPT, wav, "--hop-length", String(HOP_LENGTH)]);
    if (r.exitCode === 3) {
      throw new MusicEditError(500, "BEAT_ANALYZER_DEPENDENCY_MISSING", r.stderr.trim().slice(-500));
    }
    if (r.exitCode !== 0) {
      throw new MusicEditError(422, "BEAT_ANALYSIS_FAILED", `Beat analyzer failed (exit ${r.exitCode}): ${r.stderr.trim().slice(-500)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new MusicEditError(500, "BEAT_ANALYSIS_FAILED", "Beat analyzer returned non-JSON output.");
    }
    const analysis = parseAnalyzerOutput(parsed);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(parsed));
    return { analysis, audio, sha256, cached: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
