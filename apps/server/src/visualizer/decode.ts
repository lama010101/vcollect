// =============================================================================
// Stem decode — any uploaded audio file → mono f32le PCM at a fixed rate via
// the shared FFmpeg service (same pattern as musicEdit/beatAnalysis.ts). A
// fixed render rate keeps frame-window indexing identical for every render.
// =============================================================================

import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ffmpegService } from "../video/ffmpeg.js";
import { probeAudio, type AudioProbeResult } from "../video/ffprobe.js";
import { VisualizerError } from "./errors.js";

export const VIZ_DECODE_RATE = 48000;

export interface DecodedStem {
  pcm: Float32Array;
  sr: number;
  durationSec: number;
  probe: AudioProbeResult;
  /** De-interleaved channel PCM when the source has ≥2 channels (stereo mode);
   *  `pcm` is the L+R mid mix in that case. Null on mono sources. */
  stereo: { pcmL: Float32Array; pcmR: Float32Array } | null;
}

export async function decodeStem(path: string): Promise<DecodedStem> {
  if (!existsSync(path)) {
    throw new VisualizerError(404, "STEM_NOT_FOUND", `Stem file not found: ${path}`);
  }
  let probe: AudioProbeResult;
  try {
    probe = await probeAudio(path);
  } catch (e) {
    throw new VisualizerError(422, "CORRUPT_AUDIO", `Cannot read stem audio: ${(e as Error).message}`);
  }
  const stereo = (probe.channels ?? 0) >= 2;
  const tmp = await mkdtemp(join(tmpdir(), "twio-viz-"));
  try {
    const pcmPath = join(tmp, "stem.f32");
    const dec = await ffmpegService.ffmpegExec(
      [
        "-v", "error", "-y",
        "-i", path,
        "-map", "0:a:0",
        "-ac", stereo ? "2" : "1",
        "-ar", String(VIZ_DECODE_RATE),
        "-c:a", "pcm_f32le",
        "-f", "f32le",
        pcmPath,
      ],
      "viz-decode",
    );
    if (dec.exitCode !== 0) {
      throw new VisualizerError(422, "CORRUPT_AUDIO", `FFmpeg could not decode the stem: ${dec.stderr.trim().slice(-500)}`);
    }
    const buf = readFileSync(pcmPath);
    const bytes = Math.floor(buf.length / 4) * 4;
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes));
    if (!stereo) {
      return { pcm: f32, sr: VIZ_DECODE_RATE, durationSec: probe.durationSeconds, probe, stereo: null };
    }
    // De-interleave stereo → L/R channels + mono mid mix for downstream math.
    const frames = f32.length >> 1;
    const pcmL = new Float32Array(frames);
    const pcmR = new Float32Array(frames);
    const pcm = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const l = f32[i * 2]!;
      const r = f32[i * 2 + 1]!;
      pcmL[i] = l;
      pcmR[i] = r;
      pcm[i] = (l + r) * 0.5;
    }
    return { pcm, sr: VIZ_DECODE_RATE, durationSec: probe.durationSeconds, probe, stereo: { pcmL, pcmR } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
