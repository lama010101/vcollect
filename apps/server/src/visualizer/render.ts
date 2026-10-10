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
import type { Readable, Writable } from "node:stream";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { computeDancer, computeFrame, frameCenter, keyVideoFrame, VIZ_JS_KEY_METHODS, zoomPanRect, type FrameStem, type VisualizerRenderInput, type VizVideoKeyConfig, type VizZoomPanConfig } from "@twio/shared";
import { ffmpegService } from "../video/ffmpeg.js";
import { probe, probeAudio } from "../video/ffprobe.js";
import { VisualizerError } from "./errors.js";
import { frameSvg } from "./svg.js";

export interface VizRenderProgress {
  phase: "decode" | "keying" | "frames" | "mux" | "verify";
  done: number;
  total: number;
  /** Optional human-readable detail for the UI log (stem name, layer N, fps…). */
  detail?: string;
}

/** A resolved stack row — aligned by index with `globalVisuals.video.layers`
 *  and `state.videoLayers`. Media rows carry the local file + keying; visuals
 *  rows are placeholders — their pixels come from modeVisualsSvg, not a file.
 *  Ordering/opacity/scale ride through `state.videoLayers`, so placement
 *  logic stays in the shared frame state. */
export type VizRenderLayer =
  | { kind: "visuals" }
  | {
      kind: "media";
      path: string;
      /** Static image layer — decoded once instead of streamed per frame. */
      isImage: boolean;
      key: VizVideoKeyConfig;
      /** Source-crop zoom/pan (which part of the media fills the tile). */
      zoomPan?: VizZoomPanConfig;
      /** Source media dims — probed in service.ts (videos) so the decoder can
       *  build the zoom/pan crop filter; images use sharp metadata instead. */
      mediaW?: number;
      mediaH?: number;
      /** Engine-baked VP9-alpha WebM used for `key.method = "cutout"` (videos
       *  only); when set the decoder reads it instead of `path` and the alpha
       *  arrives baked into the rgba frames (no in-process key pass). */
      keyedPath?: string;
    };

export interface VizRenderOptions {
  /** Absolute paths of the audible stems, in the same order as stems[]. */
  audiblePaths: string[];
  outPath: string;
  /** Ordered stack rows — index matches `globalVisuals.video.layers` and
   *  `state.videoLayers`; media rows emit their <image> at that row position
   *  (row N-1 under row N), visuals rows are no-op placeholders. */
  videoLayers?: VizRenderLayer[];
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

async function writeFrame(stdin: Writable, buf: Buffer): Promise<void> {
  // A dead encoder leaves stdin destroyed — writes to it either throw or
  // silently drop, and a pending 'drain' then never settles ('error'/'close'
  // may already have fired by the time we attach). Bail fast instead.
  if (stdin.destroyed || stdin.closed || !stdin.writable) {
    throw new Error("Encoder stdin is closed.");
  }
  if (!stdin.write(buf)) {
    // 'close'/'error' can beat 'drain' when the encoder dies mid-pipe — listen
    // for all three so a dead encoder can't hang the frame loop, and detach on
    // settle (events.once would leak the losing waiter's listeners).
    await new Promise<void>((resolve, reject) => {
      const done = (e?: Error) => {
        stdin.off("drain", onDrain).off("close", onEnd).off("error", onErr);
        e ? reject(e) : resolve();
      };
      const onDrain = () => done();
      const onEnd = () => done(new Error("Encoder stdin closed mid-write."));
      const onErr = (e: Error) => done(e);
      stdin.once("drain", onDrain);
      stdin.once("close", onEnd);
      stdin.once("error", onErr);
    });
  }
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
 *  instead of truncating). The pipe carries rgba whenever a key is active —
 *  color methods get a bare `format=rgba` and the shared `keyVideoFrame` does
 *  the keying in-process (pixel-identical to the preview's Canvas pass), while
 *  `cutout` reads the engine-baked VP9-alpha WebM (`keyedPath`, decoded with
 *  the libvpx decoder — the native vp9 decoder drops the alpha stream).
 *  Zoom/pan: when source dims are known the vf crops the `zoomPanRect` window
 *  in NATIVE space, then scales it to WxH — at defaults that window IS the
 *  cover-fit rect (identical pixels to the legacy scale+crop chain). */
export function videoDecoderArgs(
  srcPath: string,
  width: number,
  height: number,
  fps: number,
  key: VizVideoKeyConfig | null,
  keyedPath?: string,
  zoomPan?: VizZoomPanConfig,
  mediaW?: number,
  mediaH?: number,
): { args: string[]; channels: 3 | 4; keyed: boolean } {
  const keyed = !!keyedPath || (!!key && key.method !== "none");
  let vf = `fps=${fps}`;
  if (mediaW && mediaH) {
    const r = zoomPanRect(mediaW, mediaH, width, height, zoomPan ?? { zoom: 1, panX: 0.5, panY: 0.5 });
    const cw = Math.max(1, Math.round(r.sw));
    const ch = Math.max(1, Math.round(r.sh));
    const cx = Math.min(Math.max(0, Math.round(r.sx)), mediaW - cw);
    const cy = Math.min(Math.max(0, Math.round(r.sy)), mediaH - ch);
    vf += `,crop=${cw}:${ch}:${cx}:${cy},scale=${width}:${height}`;
  } else {
    vf += `,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  if (keyed) vf += ",format=rgba";
  const channels = keyed ? 4 : 3;
  const input: string[] = keyedPath
    ? ["-c:v", "libvpx-vp9", "-stream_loop", "-1", "-i", resolve(keyedPath)]
    : ["-stream_loop", "-1", "-i", resolve(srcPath)];
  return {
    args: [
      "-v", "error", "-nostdin",
      ...input,
      "-vf", vf,
      "-an", "-sn", "-dn",
      "-f", "rawvideo", "-pix_fmt", channels === 4 ? "rgba" : "rgb24", "pipe:1",
    ],
    channels,
    keyed,
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

/** Encoder args for the rawvideo→mp4 child — `draft` swaps in the ultrafast
 *  preset + high CRF (rougher but several times faster). */
export function encodeArgs(width: number, height: number, fps: number, draft: boolean, videoPath: string): string[] {
  return [
    "-v", "error", "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-s", `${width}x${height}`,
    "-r", String(fps),
    "-i", "pipe:0",
    "-an", "-sn", "-dn",
    "-c:v", "libx264", "-preset", draft ? "ultrafast" : "fast", "-crf", draft ? "30" : "18",
    "-pix_fmt", "yuv420p",
    videoPath,
  ];
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
  rmSync(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  mkdirSync(workDir, { recursive: true });
  const videoPath = join(workDir, "video.mp4");

  // Draft pass — ultrafast preset + high CRF for a fast, low-quality first
  // look (the UI also sends a shrunken w/h + fps on top of this).
  const draft = input.renderSettings.draft === true;
  opts.onProgress?.({ phase: "frames", done: 0, total: totalFrames });
  const child = await ffmpegService.ffmpegSpawn(encodeArgs(width, height, fps, draft, videoPath), { signal: opts.signal });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  // Swallow async error events — killing the encoder on cancel emits EPIPE on
  // stdin (and possibly 'error' on the child); an unhandled 'error' event
  // would crash the whole server. Failures still surface via the exit code.
  child.on("error", () => {});
  child.stdin?.on("error", () => {});
  // once("close") rejects on 'error' — which abort() emits synchronously —
  // and until `await closed` runs the rejection is unhandled and crashes the
  // process. Catch eagerly; failures still surface as exit code null below.
  const closed = once(child, "close")
    .then(([code]) => code as number | null)
    .catch((e: Error) => {
      stderr += ` ${e.message}`;
      return null;
    });

  // Media layers: each video layer gets an ffmpeg decoder child emitting
  // exactly one cover-cropped frame per output frame (fps filter +
  // stream_loop, so a short clip loops instead of truncating the render);
  // each image layer is decoded once by sharp up front (identical cover-fit).
  // Frames are image-embedded into the SVG (JPEG, or PNG when an alpha
  // channel is on) so the same rasterize pass composites them — ordering
  // comes from state.videoLayers, identical to the Canvas preview's drawImage
  // placement.
  interface LayerPipe {
    /** Visuals stack row — no pixels of its own (modeVisualsSvg draws it). */
    isVisuals: boolean;
    reader: FrameReader | null;
    proc: ChildProcess | null;
    channels: 3 | 4;
    /** Shared-JS color key pass (never `cutout` — that alpha rides the WebM). */
    jsKey: VizVideoKeyConfig | null;
    /** Static image layers: the single already-encoded data URI. */
    href: string | null;
    err: string;
  }
  const layerPipes: LayerPipe[] = [];
  const renderLayers = opts.videoLayers ?? [];
  for (let i = 0; i < renderLayers.length; i++) {
    const l = renderLayers[i]!;
    if (l.kind === "visuals") {
      layerPipes.push({ isVisuals: true, reader: null, proc: null, channels: 3, jsKey: null, href: null, err: "" });
      continue;
    }
    const jsKey = !l.keyedPath && VIZ_JS_KEY_METHODS.has(l.key.method) ? l.key : null;
    if (l.isImage) {
      const meta = await sharp(l.path).metadata().catch(() => null);
      if (!meta?.width) {
        throw new VisualizerError(422, "LAYER_IMAGE_UNREADABLE", `Media layer ${i + 1} is not a readable image: ${l.path}`);
      }
      const wantAlpha = !!jsKey || !!meta.hasAlpha;
      // EXIF orientation 5–8 swaps w/h — the zoom/pan window is computed in
      // the ROTATED pixel space sharp will actually decode to.
      const rw = meta.orientation && meta.orientation >= 5 ? meta.height! : meta.width;
      const rh = meta.orientation && meta.orientation >= 5 ? meta.width : meta.height!;
      const zp = l.zoomPan ?? { zoom: 1, panX: 0.5, panY: 0.5 };
      const r = zoomPanRect(rw, rh, width, height, zp);
      const cw = Math.max(1, Math.round(r.sw));
      const ch = Math.max(1, Math.round(r.sh));
      const img = sharp(l.path)
        .rotate()
        .extract({
          left: Math.min(Math.max(0, Math.round(r.sx)), rw - cw),
          top: Math.min(Math.max(0, Math.round(r.sy)), rh - ch),
          width: cw,
          height: ch,
        })
        .resize(width, height, { fit: "fill" });
      const channels = wantAlpha ? 4 : 3;
      const raw = await (wantAlpha ? img.ensureAlpha() : img.removeAlpha()).raw().toBuffer();
      if (jsKey) keyVideoFrame(raw, width, height, jsKey);
      const enc =
        channels === 4
          ? { buf: await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), mime: "image/png" }
          : { buf: await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer(), mime: "image/jpeg" };
      layerPipes.push({ isVisuals: false, reader: null, proc: null, channels, jsKey, href: `data:${enc.mime};base64,${enc.buf.toString("base64")}`, err: "" });
      continue;
    }
    const plan = videoDecoderArgs(l.path, width, height, fps, l.key, l.keyedPath);
    const proc = await ffmpegService.ffmpegSpawn(plan.args, { signal: opts.signal });
    const pipe: LayerPipe = { isVisuals: false, reader: null, proc, channels: plan.channels, jsKey, href: null, err: "" };
    proc.stderr?.on("data", (d) => {
      pipe.err += d.toString();
      if (pipe.err.length > 4000) pipe.err = pipe.err.slice(-4000);
    });
    // Same unhandled-'error' crash guard as the encoder child above.
    proc.on("error", (e) => {
      pipe.err += ` ${e.message}`;
    });
    proc.stdin?.on("error", () => {});
    pipe.reader = new FrameReader(proc.stdout!, width * height * plan.channels);
    layerPipes.push(pipe);
  }

  const framesT0 = Date.now();
  try {
    for (let k = 0; k < totalFrames; k++) {
      if (aborted(opts.signal)) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
      const t = k / fps;
      const state = computeFrame(stems, globals, width, height, t);
      if (globals.dancer.enabled) {
        state.dancer = computeDancer(stems, globals.dancer, width, height, t, frameCenter(stems, globals, width, height, t));
      }
      const layerHrefs: (string | null)[] = [];
      for (let li = 0; li < layerPipes.length; li++) {
        const pipe = layerPipes[li]!;
        if (pipe.isVisuals) {
          layerHrefs.push(null);
          continue;
        }
        if (pipe.href) {
          layerHrefs.push(pipe.href);
          continue;
        }
        const raw = await pipe.reader!.next();
        if (!raw) {
          throw new VisualizerError(
            500,
            "VIDEO_DECODE_FAILED",
            `Media layer ${li + 1} stopped yielding frames at t=${t.toFixed(2)}s${pipe.err.trim() ? `: ${pipe.err.trim().slice(-400)}` : "."}`,
          );
        }
        // Color methods are keyed here via the shared JS implementation — the
        // exact same function the Canvas preview runs, so export pixels match.
        if (pipe.jsKey) keyVideoFrame(raw, width, height, pipe.jsKey);
        // Keyed frames carry alpha → must embed as PNG; otherwise JPEG.
        const enc =
          pipe.channels === 4
            ? { buf: await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), mime: "image/png" }
            : { buf: await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer(), mime: "image/jpeg" };
        layerHrefs.push(`data:${enc.mime};base64,${enc.buf.toString("base64")}`);
      }
      const svg = frameSvg(state, width, height, globals.backgroundColor, layerHrefs);
      const { data } = await sharp(Buffer.from(svg), { density: 72 })
        .flatten({ background: globals.backgroundColor })
        .raw()
        .toBuffer({ resolveWithObject: true });
      await writeFrame(child.stdin!, data);
      if ((k & 7) === 0) {
        const rate = ((k + 1) / Math.max(0.001, (Date.now() - framesT0) / 1000)).toFixed(1);
        opts.onProgress?.({ phase: "frames", done: k, total: totalFrames, detail: `${rate} fps` });
      }
    }
    opts.onProgress?.({ phase: "frames", done: totalFrames, total: totalFrames });
    child.stdin!.end();
    const code = await closed;
    if (aborted(opts.signal)) throw new VisualizerError(499, "RENDER_CANCELLED", "Render cancelled.");
    if (code !== 0) {
      throw new VisualizerError(500, "FFMPEG_FAILED", `FFmpeg video encode failed (exit ${code}): ${stderr.trim().slice(-600)}`);
    }

    opts.onProgress?.({ phase: "mux", done: totalFrames, total: totalFrames, detail: `${opts.audiblePaths.length} stem(s)` });
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
    try {
      rmSync(outPath, { force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* partial output can stay locked briefly — cosmetic, cleaned next run */
    }
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
    for (const pipe of layerPipes) {
      try {
        pipe.proc?.stdout?.destroy();
        if (pipe.proc && pipe.proc.exitCode === null) pipe.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Windows releases a killed child's file handles a beat late — retry the
    // scratch-dir removal, then swallow: a leftover .parts dir is cosmetic and
    // the next render's pre-clean removes it. Never mask the real outcome.
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch {
      /* stale .parts — cleaned by the next render's pre-clean */
    }
  }
}
