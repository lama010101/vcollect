// =============================================================================
// ffprobe wrapper — JSON probe of a media file (PRD §11, §34)
// =============================================================================

import { ffmpegService } from "./ffmpeg.js";

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string; // e.g. "30000/1001"
  avg_frame_rate?: string;
  duration?: string;
}

export interface ProbeFormat {
  duration?: string;
  size?: string;
  format_name?: string;
  bit_rate?: string;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: ProbeFormat;
  /** Best video stream (first codec_type=video). */
  video: ProbeStream | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  fps: number | null;
  codec: string | null;
  container: string | null; // format_name
  sizeBytes: number | null;
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const m = /^(\d+)\/(\d+)$/.exec(rate);
  if (!m) {
    const n = Number(rate);
    return Number.isFinite(n) ? n : null;
  }
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den) return null;
  return num / den;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Throws if ffprobe fails or returns no video stream (corrupt / not a video). */
export async function probe(file: string): Promise<ProbeResult> {
  const r = await ffmpegService.ffprobeExec(
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    "probe",
  );
  if (r.exitCode !== 0) {
    throw new Error(`ffprobe failed (exit ${r.exitCode}) for ${file}: ${r.stderr.slice(0, 500)}`);
  }
  let parsed: { streams?: ProbeStream[]; format?: ProbeFormat };
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    throw new Error(`ffprobe returned non-JSON for ${file}`);
  }
  const streams = parsed.streams ?? [];
  const format = parsed.format ?? {};
  const video = streams.find((s) => s.codec_type === "video") ?? null;
  if (!video) {
    throw new Error(`No video stream found in ${file} (corrupt or unsupported)`);
  }
  const duration =
    num(video.duration) ?? num(format.duration);
  return {
    streams,
    format,
    video,
    width: video.width ?? null,
    height: video.height ?? null,
    durationSeconds: duration,
    fps: parseFps(video.r_frame_rate) ?? parseFps(video.avg_frame_rate),
    codec: video.codec_name ?? null,
    container: format.format_name ?? null,
    sizeBytes: num(format.size),
  };
}

/** Lightweight "is this a valid, decodable video container?" check (PRD §34). */
export async function isPlayableVideo(file: string): Promise<boolean> {
  try {
    const p = await probe(file);
    return p.video !== null && (p.width ?? 0) > 0 && (p.height ?? 0) > 0;
  } catch {
    return false;
  }
}
