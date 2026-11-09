// =============================================================================
// Thumbnails — one representative thumbnail per asset (PRD §21)
//
// Extract frames at 0/25/50/75/100%, pick the sharpest (highest luma std-dev
// via sharp), save to thumbnails/{asset_id}.jpg.
// =============================================================================

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { THUMBNAILS_DIR } from "../config.js";
import { ffmpegService } from "./ffmpeg.js";
import { probe } from "./ffprobe.js";

mkdirSync(THUMBNAILS_DIR, { recursive: true });

// Serve/display size — cards are ~300px wide, so 640 covers 2× displays.
// Full-resolution frames made 0.5–3 MB "thumbnails"; these land ~30–60 KB.
export const THUMB_MAX_DIM = 640;
const THUMB_JPEG = { quality: 78, mozjpeg: true } as const;

async function extractFramePng(file: string, frameIndex: number): Promise<Buffer> {
  const bin = ffmpegService.ffmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ["-i", file, "-vf", `select='eq(n\\,${frameIndex})'`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`frame extract exit ${code}`))));
  });
}

/** Luma standard deviation — a cheap sharpness proxy. */
async function sharpnessScore(png: Buffer): Promise<number> {
  const { data } = await sharp(png).greyscale().resize(160, 90).raw().toBuffer({ resolveWithObject: true });
  if (!data.length) return 0;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  let variance = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i]! - mean;
    variance += d * d;
  }
  return Math.sqrt(variance / data.length);
}

/**
 * Generate the representative thumbnail for an image file — sharp decodes
 * directly (no ffmpeg spawn), flattens alpha onto black (matches the dark
 * video-thumb look) and bounds the result to THUMB_MAX_DIM so giant source
 * images don't produce giant thumbs. Same output location/naming as
 * generateThumbnail. @returns absolute path to the JPEG, or null on failure.
 */
export async function generateImageThumbnail(file: string, assetId: string): Promise<string | null> {
  try {
    const thumbDir = THUMBNAILS_DIR;
    mkdirSync(thumbDir, { recursive: true });
    const dest = join(thumbDir, `${assetId}.jpg`);
    await sharp(file)
      .flatten({ background: "#000000" })
      .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg(THUMB_JPEG)
      .toFile(dest);
    return dest;
  } catch (err) {
    console.warn(`[thumbnails] image thumb failed for ${assetId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generate the representative thumbnail for an audio file — a waveform
 * overview via ffmpeg's showwavespic filter (no video stream needed),
 * flattened to the same bounded JPEG the video/image thumbs use. Audio has
 * no "best frame", so the whole-file waveform IS the representative image.
 * @returns absolute path to the JPEG, or null on failure.
 */
export async function generateAudioThumbnail(file: string, assetId: string): Promise<string | null> {
  try {
    const thumbDir = THUMBNAILS_DIR;
    mkdirSync(thumbDir, { recursive: true });
    const bin = ffmpegService.ffmpegPath();
    const png = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        bin,
        ["-i", file, "-filter_complex", "showwavespic=s=640x240:split_channels=0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
        { windowsHide: true },
      );
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`waveform thumb exit ${code}`))));
    });
    if (!png.length) return null;
    const dest = join(thumbDir, `${assetId}.jpg`);
    await sharp(png)
      .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg(THUMB_JPEG)
      .toFile(dest);
    return dest;
  } catch (err) {
    console.warn(`[thumbnails] audio thumb failed for ${assetId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generate the representative thumbnail for a video file.
 * Thumbnails are stored in the global THUMBNAILS_DIR (shared across projects).
 * @returns absolute path to the generated JPEG, or null on failure.
 */
export async function generateThumbnail(file: string, assetId: string): Promise<string | null> {
  try {
    const thumbDir = THUMBNAILS_DIR;
    mkdirSync(thumbDir, { recursive: true });
    const p = await probe(file);
    const totalFrames = p.fps ? Math.round(p.fps * (p.durationSeconds ?? 0)) : 100;
    const percents = [0, 25, 50, 75, 100];
    let best: { png: Buffer; score: number } | null = null;
    for (const pct of percents) {
      const frame = Math.round((pct / 100) * Math.max(totalFrames - 1, 0));
      try {
        const png = await extractFramePng(file, frame);
        if (!png.length) continue;
        const score = await sharpnessScore(png);
        if (!best || score > best.score) best = { png, score };
      } catch {
        // skip a failed frame
      }
    }
    if (!best) return null;
    const dest = join(thumbDir, `${assetId}.jpg`);
    await sharp(best.png)
      .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg(THUMB_JPEG)
      .toFile(dest);
    return dest;
  } catch (err) {
    console.warn(`[thumbnails] failed for ${assetId}: ${(err as Error).message}`);
    return null;
  }
}
