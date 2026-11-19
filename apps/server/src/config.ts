// =============================================================================
// Server config — load & validate environment (PRD §33)
// API keys are server-side only; never exposed to the frontend.
// =============================================================================

import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appConfigSchema, type AppConfig } from "@twio/shared";
import { DEFAULT_PROJECT_ID } from "@twio/shared";

// Monorepo root, computed from this file's location
// (apps/server/src/config.ts → ../../.. = repo root). This ensures the output
// directory and .env files resolve to the same place regardless of which
// workspace's `process.cwd()` is active (CLI vs `tsx watch` vs tests).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");

// Load .env.local first (higher precedence — user secrets live here), then
// fall back to .env. dotenv does not override already-set vars, so .env.local
// wins. Both are gitignored (PRD §33). Always load from the repo root.
dotenv.config({ path: resolve(PROJECT_ROOT, ".env.local") });
dotenv.config({ path: resolve(PROJECT_ROOT, ".env") });

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const raw: AppConfig = appConfigSchema.parse({
  pexelsApiKey: process.env.PEXELS_API_KEY ?? "",
  pixabayApiKey: process.env.PIXABAY_API_KEY ?? "",
  visionApiKey: process.env.VISION_API_KEY ?? "",
  visionApiProvider: process.env.VISION_API_PROVIDER ?? "openai",
  llmProvider: process.env.LLM_PROVIDER ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmBaseUrl: process.env.LLM_BASE_URL ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
  inspatioEndpoint: process.env.INSPATIO_ENDPOINT ?? "",
  inspatioToken: process.env.INSPATIO_TOKEN ?? "",
  port: num(process.env.PORT, 3001),
  host: process.env.HOST ?? "127.0.0.1",
  ffmpegBinPath: process.env.FFMPEG_BIN_PATH ?? "",
  ffprobeBinPath: process.env.FFPROBE_BIN_PATH ?? "",
  pythonBinPath: process.env.PYTHON_BIN_PATH ?? "",
  engineDisabled: ["1", "true", "yes"].includes((process.env.TWIO_ENGINE_DISABLED ?? "").toLowerCase()),
  outputDir: process.env.OUTPUT_DIR ?? "output",
  maxDownloadMb: num(process.env.MAX_DOWNLOAD_MB, 600),
  candidatesPerProvider: num(process.env.CANDIDATES_PER_PROVIDER, 30),
  topNPerShot: num(process.env.TOP_N_PER_SHOT, 5),
  phashHammingThreshold: num(process.env.PHASH_HAMMING_THRESHOLD, 8),
  searchCacheTtlMin: num(process.env.SEARCH_CACHE_TTL_MIN, 60),
});

export const config: AppConfig = raw;

/** Video file extensions accepted for uploads and folder sync. */
export const VIDEO_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg",
]);

/** Image file extensions accepted for uploads and folder sync. Limited to
 *  formats sharp can decode — upload validation reads real pixel metadata,
 *  so anything sharp can't parse is rejected at upload/sync time anyway. */
export const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".tif", ".tiff", ".svg",
]);

/** Audio file extensions accepted for uploads and folder sync — the same set
 *  the Music Edit song pool and Visualizer stem pool accept (single source of
 *  truth; musicEdit/service.ts re-exports it as AUDIO_EXTENSIONS). */
export const AUDIO_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus",
]);

/** File extensions that can execute script when opened as a top-level
 *  document (SVG, HTML, XML+XSLT, MHTML). Served files with these types get a
 *  Content-Security-Policy: sandbox header so a planted file can't run JS on
 *  the API origin. */
const ACTIVE_CONTENT_RE = /\.(?:svg|x?html?|xht|xml|mhtml?)$/i;
export function isActiveContentFile(path: string): boolean {
  return ACTIVE_CONTENT_RE.test(path);
}

/** Content-Type for a stored asset file, derived from its extension. Falls
 *  back to octet-stream so unknown types still download instead of 500ing. */
export function mediaMimeForFile(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".mp4": case ".m4v": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    case ".mpg": case ".mpeg": return "video/mpeg";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".avif": return "image/avif";
    case ".tif": case ".tiff": return "image/tiff";
    case ".svg": return "image/svg+xml";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".flac": return "audio/flac";
    case ".ogg": case ".oga": case ".opus": return "audio/ogg";
    default: return "application/octet-stream";
  }
}

// Absolute path to the generated output root (PRD §6).
// Resolve relative to the monorepo root (not process.cwd()) so the CLI,
// the dev server, and tests all share one DB + output directory.
//
// Real asset files live inside each project's dedicated folder:
// OUTPUT_ROOT/<slug>/assets/<query>/ for provider downloads and
// OUTPUT_ROOT/<slug>/assets/uploads/ for drag-and-drop uploads. Thumbnails
// are global under OUTPUT_ROOT/thumbnails/. The shared SQLite DB stays at
// OUTPUT_ROOT/database/footage.db.
export const OUTPUT_ROOT = resolve(PROJECT_ROOT, config.outputDir);

// Global thumbnails directory (shared across all projects).
export const THUMBNAILS_DIR = resolve(OUTPUT_ROOT, "thumbnails");

/** Per-project output paths. Each project gets its own subfolder under
 *  OUTPUT_ROOT keyed by its slug. `assets` is the project's dedicated asset
 *  folder — downloaded clips and manual uploads live there, never in another
 *  project's folder. */
export interface ProjectPaths {
  slug: string;
  output: string; // OUTPUT_ROOT/<slug>
  assets: string; // .../assets — all real asset files for this project
  contactSheets: string; // .../contact_sheets
  manifests: string; // .../manifests
  sourcePages: string; // .../source_pages
}

const _projectPathsCache = new Map<string, ProjectPaths>();

/** Resolve (and lazily create) the on-disk output paths for a project slug.
 *  Safe to call repeatedly; dirs are created once and cached. */
export function projectPaths(slug: string): ProjectPaths {
  const cached = _projectPathsCache.get(slug);
  if (cached) return cached;
  const output = resolve(OUTPUT_ROOT, slug);
  const paths: ProjectPaths = {
    slug,
    output,
    assets: resolve(output, "assets"),
    contactSheets: resolve(output, "contact_sheets"),
    manifests: resolve(output, "manifests"),
    sourcePages: resolve(output, "source_pages"),
  };
  // Create global dirs + per-project dirs.
  for (const p of [THUMBNAILS_DIR, output, paths.assets, paths.contactSheets, paths.manifests, paths.sourcePages]) {
    mkdirSync(p, { recursive: true });
  }
  _projectPathsCache.set(slug, paths);
  return paths;
}

/** Sanitize a folder name to be filesystem-safe (same rules as queryDir). */
function sanitizeDirName(name: string): string {
  const s = name
    .trim()
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 100);
  return s || "misc";
}

/** Resolve (and create) a subdirectory inside a project's dedicated assets
 *  folder: OUTPUT_ROOT/<slug>/assets/<subdir>. Used for query-grouped
 *  downloads and the "uploads" drop folder. */
export function projectAssetDir(slug: string, subdir: string): string {
  const dir = resolve(projectPaths(slug).assets, sanitizeDirName(subdir));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the on-disk directory for a search query. Legacy global layout:
 *  OUTPUT_ROOT/<sanitized_query>/ — still used by the file migrations that
 *  relocate older files into the per-project assets folders. */
export function queryDir(searchQuery: string): string {
  const dir = resolve(OUTPUT_ROOT, sanitizeDirName(searchQuery));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Convenience derived paths. Thumbnails are global; per-project manifests
// live under projectPaths(slug). `PATHS` here is kept as the default project's
// paths for backwards compatibility with code that hasn't been threaded with
// a project context yet.
export const PATHS = {
  output: OUTPUT_ROOT, // static root serves /files/ for all projects
  thumbnails: THUMBNAILS_DIR, // global thumbnail storage
  contactSheets: projectPaths(DEFAULT_PROJECT_ID).contactSheets,
  manifests: projectPaths(DEFAULT_PROJECT_ID).manifests,
  sourcePages: projectPaths(DEFAULT_PROJECT_ID).sourcePages,
  database: resolve(OUTPUT_ROOT, "database", "footage.db"),
} as const;
