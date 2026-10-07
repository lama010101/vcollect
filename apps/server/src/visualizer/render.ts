// =============================================================================
// Visualizer renderer — deterministic frame loop piped into FFmpeg.
//
// Frame k renders t_k = k/fps via the shared computeFrame() → SVG → sharp →
// raw rgb24 → ffmpeg stdin (rawvideo → libx264). The audible stems are then
// mixed with amix (unity sum + limiter, no resampling games) and muxed with
// -c:v copy so the encoded frames — and therefore the sync — are untouched.
// =============================================================================

import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { computeDancer, computeFrame, frameCenter, type FrameStem, type VisualizerRenderInput, type VizChromaKeyConfig, type VizVideoLayer } from "@twio/shared";
import { ffmpegService } from "../video/ffmpeg.js";
import { probe, probeAudio } from "../video/ffprobe.js";
import { VisualizerError } from "./errors.js";
import { frameSvg } from "./svg.js";

export interface VizRenderProgress {
  phase: "decode" | "frames" | "mux" | "verify";
  done: number;
  total: number;
}

export interface VizRenderOptions {
  /** Absolute paths of the audible stems, in the same order as stems[]. */
  audiblePaths: string[];
  outPath: string;
  /** Optional video layer — resolved local file + draw placement/opacity/key. */
  video?: { path: string; layer: VizVideoLayer; opacity: number; chromaKey: VizChromaKeyConfig } | null;
  signal?: AbortSignal;
  onProgress?: (p: VizRenderProgress) => void;
}

export interface VizRenderResult {
  outPath: string;
  durationSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
  frames: number;
}

const fmt = (n: number): string => n.toFixed(6);

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function writeFrame(stdin: NodeJS.WritableStream, buf: Buffer): Promise<void> {
  if (!stdin.write(buf)) await once(stdin, "drain");
}

/** Buffered reader that yields exactly `size` bytes per call — one decoded
 *  rawvideo frame — from an ffmpeg stdout pipe. Returns null once the stream
 *  ends with a partial/no frame left. Chunks queue without copying and the
 *  stream is paused once a few frames are buffered, so the looping decoder
 *  applies real backpressure instead of flooding memory. */
class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private waiter: (() => void) | null = null;

  constructor(private readonly stream: Readable, private readonly size: number) {
    stream.on("data", (c: Buffer) => {
      this.chunks.push(c);
      this.buffered += c.length;
      this.wake();
      if (this.buffered > this.size * 4) stream.pause();
    });
    const end = () => {
      this.ended = true;
      this.wake();
    };
    stream.on("end", end);
    stream.on("close", end);
    stream.on("error", end);
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async next(): Promise<Buffer | null> {
    while (this.buffered < this.size && !this.ended) {
      await new Promise<void>((res) => (this.waiter = res));
    }
    if (this.buffered < this.size) return null;
    const out = Buffer.allocUnsafe(this.size);
    let off = 0;
    while (off < this.size) {
      const head = this.chunks[0]!;
      const take = Math.min(head.length, this.size - off);
      head.copy(out, off, 0, take);
      off += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= this.size;
    if (this.stream.isPaused() && this.buffered <= this.size * 4) this.stream.resume();
    return out;
  }
}

/** Decoder child argv for the video layer: emits exactly one cover-cropped
 *  raw frame per output frame (fps filter + stream_loop → short clips loop
 *  instead of truncating). When chroma-key is on the pipe carries rgba —
 *  the ffmpeg `colorkey` filter writes the alpha channel — otherwise rgb24. */
export function videoDecoderArgs(
  srcPath: string,
  width: number,
  height: number,
  fps: number,
  chromaKey: VizChromaKeyConfig,
): { args: string[]; channels: 3 | 4 } {
  let vf = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  if (chromaKey.enabled) vf += `,format=rgba,colorkey=0x${chromaKey.color.slice(1)}:${chromaKey.similarity}:${chromaKey.blend}`;
  const channels = chromaKey.enabled ? 4 : 3;
  return {
    args: [
      "-v", "error", "-nostdin",
      "-stream_loop", "-1",
      "-i", resolve(srcPath),
      "-vf", vf,
      "-an", "-sn", "-dn",
      "-f", "rawvideo", "-pix_fmt", channels === 4 ? "rgba" : "rgb24", "pipe:1",
    ],
    channels,
  };
}

/** Mix + mux: rendered video (no audio) + audible stem files → final MP4. */
export function muxArgs(videoPath: string, audiblePaths: string[], duration: number, outPath: string): string[] {
  const args = ["-v", "error", "-y", "-i", videoPath];
  for (const p of audiblePaths) args.push("-i", resolve(p));
  if (audiblePaths.length === 0) {
    // No audible stems — still emit an AAC track of digital silence so the
    // output container is uniform.
    args.push(
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map", "0:v:0", "-map", `${audiblePaths.length + 1}:a:0`,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
    );
  } else if (audiblePaths.length === 1) {
    args.push(
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
    );
  } else {
    const inputs = audiblePaths.map((_, i) => `[${i + 1}:a:0]`).join("");
    args.push(
      "-filter_complex", `${inputs}amix=inputs=${audiblePaths.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95[a]`,
      "-map", "0:v:0", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
    );
  }
  args.push("-t", fmt(duration), "-movflags", "+faststart", outPath);
  return args;
}

export async function renderVisualizer(
  input: VisualizerRenderInput,
  stems: FrameStem[],
  opts: VizRenderOptions,
): Promise<VizRenderResult> {
  const { width, height, fps } = input.renderSettings;
  const globals = input.globalVisuals;
  const duration = Math.max(...stems.map((s) => s.signal.durationSec));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VisualizerError(422, "CORRUPT_AUDIO", "Stems have no usable duration.");
  }
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const outPath = resolve(opts.outPath);
  const workDir = `${outPath}.parts`;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const videoPath = join(workDir, "video.mp4");

  opts.onProgress?.({ phase: "frames", done: 0, total: totalFrames });
  const child = await ffmpegService.ffmpegSpawn(
    [
      "-v", "error", "-y",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-s", `${width}x${height}`,
      "-r", String(fps),
      "-i", "pipe:0",
      "-an", "-sn", "-dn",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p",
      videoPath,
    ],
    { signal: opts.signal },
  );
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  const closed = once(child, "close").then(([code]) => code as number | null);

  // Optional video layer: a second ffmpeg child decodes the source into
  // exactly one cover-cropped frame per output frame (fps filter +
  // stream_loop, so a short clip loops instead of truncating the render).
  // The raw frame is image-embedded into the SVG (JPEG, or PNG when the
  // chroma-key alpha channel is on) so the same rasterize pass composites
  // it — the ordering comes from state.video, identical to the Canvas
  // preview's drawImage placement.
  let decoder: ChildProcess | null = null;
  let videoFrames: FrameReader | null = null;
  let videoChannels: 3 | 4 = 3;
  let decErr = "";
  const videoCfg = opts.video && globals.video.assetId ? opts.video : null;
  if (videoCfg) {
    const plan = videoDecoderArgs(videoCfg.path, width, height, fps, videoCfg.chromaKey);
    videoChannels = plan.channels;
    decoder = await ffmpegService.ffmpegSpawn(plan.args, { signal: opts.signal });
    decoder.stderr?.on("data", (d) => {
      decErr += d.toString();
      if (decErr.length > 4000) decErr = decErr.slice(-4000);
    });
    videoFrames = new FrameReader(decoder.stdout!, width * height * videoChannels);
  }

  try {
    for (let k = 0; k < totalFrames; k++) {
      if (aborted(opts.signal)) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
      const t = k / fps;
      const state = computeFrame(stems, globals, width, height, t);
      if (globals.dancer.enabled) {
        state.dancer = computeDancer(stems, globals.dancer, width, height, t, frameCenter(stems, globals, width, height, t));
      }
      let videoImageHref: string | null = null;
      if (videoFrames) {
        const raw = await videoFrames.next();
        if (!raw) {
          throw new VisualizerError(
            500,
            "VIDEO_DECODE_FAILED",
            `The selected video stopped yielding frames at t=${t.toFixed(2)}s${decErr.trim() ? `: ${decErr.trim().slice(-400)}` : "."}`,
          );
        }
        // Keyed frames carry alpha → must embed as PNG; otherwise JPEG.
        const enc =
          videoChannels === 4
            ? { buf: await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), mime: "image/png" }
            : { buf: await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer(), mime: "image/jpeg" };
        videoImageHref = `data:${enc.mime};base64,${enc.buf.toString("base64")}`;
      }
      const svg = frameSvg(state, width, height, globals.backgroundColor, videoImageHref);
      const { data } = await sharp(Buffer.from(svg), { density: 72 })
        .flatten({ background: globals.backgroundColor })
        .raw()
        .toBuffer({ resolveWithObject: true });
      await writeFrame(child.stdin!, data);
      if ((k & 7) === 0) opts.onProgress?.({ phase: "frames", done: k, total: totalFrames });
    }
    opts.onProgress?.({ phase: "frames", done: totalFrames, total: totalFrames });
    child.stdin!.end();
    const code = await closed;
    if (aborted(opts.signal)) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
    if (code !== 0) {
      throw new VisualizerError(500, "FFMPEG_FAILED", `FFmpeg video encode failed (exit ${code}): ${stderr.trim().slice(-600)}`);
    }

    opts.onProgress?.({ phase: "mux", done: totalFrames, total: totalFrames });
    const mux = await ffmpegService.ffmpegExec(muxArgs(videoPath, opts.audiblePaths, duration, outPath), "viz-mux", {
      signal: opts.signal,
    });
    if (aborted(opts.signal)) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
    if (mux.exitCode !== 0) {
      throw new VisualizerError(500, "FFMPEG_FAILED", `FFmpeg failed while muxing the visualizer video: ${mux.stderr.trim().slice(-600)}`);
    }

    opts.onProgress?.({ phase: "verify", done: totalFrames, total: totalFrames });
    const v = await probe(outPath);
    const a = await probeAudio(outPath);
    const videoDur = Number(v.video?.duration ?? v.durationSeconds ?? 0);
    const tolerance = 2 / fps + 0.05;
    if (Math.abs(a.durationSeconds - duration) > tolerance || Math.abs(videoDur - duration) > tolerance) {
      throw new VisualizerError(
        500,
        "OUTPUT_DURATION_MISMATCH",
        `Rendered durations (video ${videoDur.toFixed(3)}s, audio ${a.durationSeconds.toFixed(3)}s) do not match the stems (${duration.toFixed(3)}s).`,
      );
    }
    return {
      outPath,
      durationSeconds: v.durationSeconds ?? videoDur,
      videoDurationSeconds: videoDur,
      audioDurationSeconds: a.durationSeconds,
      frames: totalFrames,
    };
  } catch (e) {
    rmSync(outPath, { force: true });
    if (aborted(opts.signal)) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
    if ((e as Error).name === "AbortError") throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
    throw e;
  } finally {
    try {
      child.stdin?.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      decoder?.stdout?.destroy();
      if (decoder && decoder.exitCode === null) decoder.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}
