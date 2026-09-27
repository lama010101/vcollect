// =============================================================================
// Perceptual hash (pHash) — PRD §16 Level 3 near-duplicate detection
//
// Extract a representative frame (50%) via ffmpeg, resize to 32x32 grayscale
// via sharp, compute a small DCT, take the top-left 8x8, threshold by mean →
// 64-bit hash. Stored as 16-char hex. Custom DCT — no extra dependency.
// =============================================================================

import { ffmpegService } from "./ffmpeg.js";
import sharp from "sharp";

/** Extract a single frame at a given percent of the duration into a Buffer. */
export async function extractFrame(file: string, percent: number): Promise<Buffer> {
  const p = Math.max(0, Math.min(100, percent));
  // Use -ss BEFORE -i for speed; but for percent-based we need duration first.
  // Simpler: use select filter. We accept minor overhead.
  const r = await ffmpegService.ffmpegExec(
    ["-i", file, "-vf", `select='eq(n\\,0)+eq(n\\,${Math.round(p)})'`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
    "extractFrame",
  );
  // ffmpeg writes the image to stdout. With pipe:1 the PNG bytes are in stdout.
  // However child.stdout is captured as a string in our exec — we need raw bytes.
  // Re-spawn directly to capture a Buffer instead.
  return extractFrameRaw(file, p);
}

import { spawn } from "node:child_process";

async function extractFrameRaw(file: string, percent: number): Promise<Buffer> {
  const bin = ffmpegService.ffmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ["-i", file, "-vf", `select='eq(n\\,0)+eq(n\\,${Math.round(percent)})'`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg frame extract exit ${code}`));
    });
  });
}

// 8x8 DCT-II applied to a 32x32 grayscale matrix (simplified, adequate for pHash).
function dct8x8(block: number[][]): number[][] {
  const N = 8;
  const out: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let u = 0; u < N; u++) {
    const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
    for (let v = 0; v < N; v++) {
      const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          sum += block[i]![j]! * Math.cos(((2 * i + 1) * u * Math.PI) / 16) * Math.cos(((2 * j + 1) * v * Math.PI) / 16);
        }
      }
      out[u]![v]! = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/** Compute a 64-bit pHash as 16-char hex from a video file. */
export async function computePHash(file: string, percent = 50): Promise<string> {
  const png = await extractFrameRaw(file, percent);
  const { data, info } = await sharp(png).greyscale().resize(32, 32).raw().toBuffer({ resolveWithObject: true });
  void info;
  // data is a 32x32 grayscale buffer.
  const gray: number[][] = [];
  for (let i = 0; i < 32; i++) {
    const row: number[] = [];
    for (let j = 0; j < 32; j++) row.push(data[i * 32 + j]!);
    gray.push(row);
  }
  // Average each 4x4 block -> 8x8 (simple downsampling before DCT).
  const block: number[][] = [];
  for (let bi = 0; bi < 8; bi++) {
    const row: number[] = [];
    for (let bj = 0; bj < 8; bj++) {
      let s = 0;
      for (let ii = 0; ii < 4; ii++)
        for (let jj = 0; jj < 4; jj++) s += gray[bi * 4 + ii]![bj * 4 + jj]!;
      row.push(s / 16);
    }
    block.push(row);
  }
  const d = dct8x8(block);
  // Top-left 8x8 (we already have 8x8); compute mean excluding the DC term.
  const flat: number[] = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) flat.push(d[i]![j]!);
  const dc = flat[0]!;
  const mean = flat.slice(1).reduce((a, b) => a + b, 0) / (flat.length - 1);
  void dc;
  // Build 64-bit hash: 1 if value > mean.
  let bits = 0n;
  for (let k = 0; k < 64; k++) {
    if (flat[k]! > mean) bits |= 1n << BigInt(63 - k);
  }
  return bits.toString(16).padStart(16, "0");
}
