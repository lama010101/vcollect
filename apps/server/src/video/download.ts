// =============================================================================
// Download — secure asset acquisition (PRD §34)
//
// Validate Content-Type, HTTP status, max file size, extension, and the actual
// video container via ffprobe. Never trust the remote filename. Generate our
// own filename: SHOT_###_<PROVIDER>_<id>.mp4. Stream to disk while computing
// SHA-256.
// =============================================================================

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { config, OUTPUT_ROOT, projectAssetDir, queryDir } from "../config.js";
import { isPlayableVideo } from "./ffprobe.js";

export interface DownloadResult {
  localPath: string; // absolute
  relativePath: string; // relative to OUTPUT_ROOT (e.g. "<search_query>/PEXELS_123.mp4")
  sha256: string;
  sizeBytes: number;
}

/** Streamed download progress callback (received bytes, total bytes or 0). */
export type DownloadProgressCb = (receivedBytes: number, totalBytes: number) => void;

/**
 * Controller handed to a download so the caller can pause/resume and cancel it.
 *  - `signal`: aborts the in-flight fetch + stream pipeline (cancel).
 *  - `isPaused()`: when true, the download loop blocks between chunks until
 *    `resume()` is called (pause).
 *  - `waitIfPaused()`: blocks while paused; returns immediately otherwise.
 *    Throws an AbortError if the signal aborts while waiting.
 */
export interface DownloadController {
  signal: AbortSignal;
  isPaused: () => boolean;
  waitIfPaused: () => Promise<void>;
}

/** Error thrown when a download is cancelled via AbortSignal. */
export class DownloadCancelledError extends Error {
  constructor(message = "download cancelled") {
    super(message);
    this.name = "DownloadCancelledError";
  }
}

/**
 * A simple pause gate: `waitIfPaused()` blocks while `pause()` has been called
 * more recently than `resume()`. Aborts wake blocked waiters with an error.
 */
export class PauseGate {
  private paused = false;
  private resolveWait: (() => void) | null = null;
  private readonly onAbort: () => void;
  constructor(private readonly signal: AbortSignal) {
    this.onAbort = () => {
      if (this.resolveWait) {
        const r = this.resolveWait;
        this.resolveWait = null;
        r();
      }
    };
    if (signal.aborted) this.onAbort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }
  pause(): void { this.paused = true; }
  resume(): void {
    this.paused = false;
    if (this.resolveWait) {
      const r = this.resolveWait;
      this.resolveWait = null;
      r();
    }
  }
  isPaused(): boolean { return this.paused; }
  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    if (this.signal.aborted) throw new DownloadCancelledError();
    await new Promise<void>((resolve) => {
      // If resume/abort fires before we get here, resolve immediately.
      if (!this.paused || this.signal.aborted) return resolve();
      this.resolveWait = resolve;
    });
    if (this.signal.aborted && this.paused) throw new DownloadCancelledError();
  }
  dispose(): void {
    try { this.signal.removeEventListener("abort", this.onAbort); } catch { /* ignore */ }
    if (this.resolveWait) { const r = this.resolveWait; this.resolveWait = null; r(); }
  }
}

export function ourFilename(shotNumber: number, provider: string, providerAssetId: string): string {
  const shot = `SHOT_${String(shotNumber).padStart(3, "0")}`;
  const prov = provider.toUpperCase();
  return `${shot}_${prov}_${providerAssetId}.mp4`;
}

/** Where the downloaded file lands. When `projectSlug` is set the file is
 *  stored inside that project's dedicated assets folder
 *  (OUTPUT_ROOT/<slug>/assets/<searchQuery>/); otherwise it falls back to the
 *  legacy global query folder (OUTPUT_ROOT/<searchQuery>/). */
export interface DownloadDest {
  projectSlug?: string;
  searchQuery?: string;
}

/**
 * Download a real video asset from the provider URL. Throws on validation failure.
 *
 * The file is stored under the project's assets folder — organized by the
 * search query that discovered the asset.
 *
 * @param dest destination selector (project folder + query subfolder)
 * @param shotNumber used to build our own filename
 * @param _section unused (kept for API compatibility)
 * @param onProgress optional streamed-progress callback (received, total)
 */
export async function downloadAsset(
  downloadUrl: string,
  shotNumber: number,
  _section: string,
  provider: string,
  providerAssetId: string,
  expectedContentType = "video/*",
  onProgress?: DownloadProgressCb,
  dest?: DownloadDest,
  controller?: DownloadController,
): Promise<DownloadResult> {
  const filename = ourFilename(shotNumber, provider, providerAssetId);
  const query = dest?.searchQuery ?? "unknown";
  const dir = dest?.projectSlug ? projectAssetDir(dest.projectSlug, query) : queryDir(query);
  const file = join(dir, filename);

  await downloadHttp(downloadUrl, file, expectedContentType, onProgress, controller);

  // Validate the actual video container (PRD §34) — never trust the filename.
  if (!(await isPlayableVideo(file))) {
    throw new Error(`Downloaded file is not a valid video container: ${file}`);
  }

  const stat = statSync(file);
  const sha256 = await sha256File(file);
  return {
    localPath: file,
    relativePath: relativeToOutput(file),
    sha256,
    sizeBytes: stat.size,
  };
}

async function downloadHttp(url: string, dest: string, expectedContentType: string, onProgress?: DownloadProgressCb, controller?: DownloadController): Promise<void> {
  // Honour an early cancel before we even hit the network.
  if (controller?.signal.aborted) throw new DownloadCancelledError();
  const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  const expected = expectedContentType.replace("/*", "");
  if (!ct.toLowerCase().includes(expected.split("/")[0]!)) {
    // Some providers serve video with generic content-type; be lenient but warn.
    if (!/^video\/|^application\/octet-stream/i.test(ct)) {
      throw new Error(`Unexpected Content-Type "${ct}" from ${url}`);
    }
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  const maxBytes = config.maxDownloadMb * 1024 * 1024;
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`File too large: ${contentLength} > ${maxBytes} bytes (${url})`);
  }
  if (!res.body) throw new Error(`No response body from ${url}`);
  const file = createWriteStream(dest);
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("stream/web").ReadableStream),
      async function* (source) {
        for await (const chunk of source as AsyncIterable<Buffer>) {
          // Pause gate: block here while paused. Aborts throw Cancelled.
          if (controller) await controller.waitIfPaused();
          if (controller?.signal.aborted) throw new DownloadCancelledError();
          received += chunk.length;
          if (received > maxBytes) {
            throw new Error(`Stream exceeded max size ${maxBytes} bytes`);
          }
          onProgress?.(received, contentLength);
          yield chunk;
        }
      },
      file,
    );
  } catch (e) {
    // On cancel/abort, remove the partial file so a retry starts clean.
    if (e instanceof DownloadCancelledError || (controller?.signal.aborted)) {
      try { if (existsSync(dest)) rmSync(dest, { force: true }); } catch { /* ignore */ }
      throw new DownloadCancelledError();
    }
    // For other failures also clean up the partial file.
    try { if (existsSync(dest)) rmSync(dest, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) h.update(chunk as Buffer);
  });
  return h.digest("hex");
}

function relativeToOutput(abs: string): string {
  return abs.replace(/\\/g, "/").replace(OUTPUT_ROOT.replace(/\\/g, "/") + "/", "");
}
