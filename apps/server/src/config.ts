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
  port: num(process.env.PORT, 3001),
  host: process.env.HOST ?? "127.0.0.1",
  ffmpegBinPath: process.env.FFMPEG_BIN_PATH ?? "",
  ffprobeBinPath: process.env.FFPROBE_BIN_PATH ?? "",
  pythonBinPath: process.env.PYTHON_BIN_PATH ?? "",
  outputDir: process.env.OUTPUT_DIR ?? "output",
  maxDownloadMb: num(process.env.MAX_DOWNLOAD_MB, 600),
  candidatesPerProvider: num(process.env.CANDIDATES_PER_PROVIDER, 30),
  topNPerShot: num(process.env.TOP_N_PER_SHOT, 5),
  phashHammingThreshold: num(process.env.PHASH_HAMMING_THRESHOLD, 8),
  searchCacheTtlMin: num(process.env.SEARCH_CACHE_TTL_MIN, 60),
});

export const config: AppConfig = raw;

// Absolute path to the generated output root (PRD §6).
// Resolve relative to the monorepo root (not process.cwd()) so the CLI,
// the dev server, and tests all share one DB + output directory.
//
// Real asset files are stored directly under OUTPUT_ROOT in subfolders named
// after the search query that discovered them (e.g. OUTPUT_ROOT/<query>/).
// Thumbnails are global under OUTPUT_ROOT/thumbnails/. The shared SQLite DB
// stays at OUTPUT_ROOT/database/footage.db.
export const OUTPUT_ROOT = resolve(PROJECT_ROOT, config.outputDir);

// Global thumbnails directory (shared across all projects).
export const THUMBNAILS_DIR = resolve(OUTPUT_ROOT, "thumbnails");

/** Per-project output paths. Each project gets its own subfolder under
 *  OUTPUT_ROOT keyed by its slug for manifests, contact sheets, and source
 *  pages. Real asset files are stored directly under OUTPUT_ROOT in
 *  subfolders named after the search query. */
export interface ProjectPaths {
  slug: string;
  output: string; // OUTPUT_ROOT/<slug>
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
    contactSheets: resolve(output, "contact_sheets"),
    manifests: resolve(output, "manifests"),
    sourcePages: resolve(output, "source_pages"),
  };
  // Create global dirs + per-project dirs.
  for (const p of [THUMBNAILS_DIR, output, paths.contactSheets, paths.manifests, paths.sourcePages]) {
    mkdirSync(p, { recursive: true });
  }
  _projectPathsCache.set(slug, paths);
  return paths;
}

/** Resolve the on-disk directory for a search query. Files are stored under
 *  OUTPUT_ROOT/<sanitized_query>/. The query is sanitized to be filesystem-safe. */
export function queryDir(searchQuery: string): string {
  const sanitized = searchQuery
    .trim()
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 100);
  const dir = resolve(OUTPUT_ROOT, sanitized);
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
