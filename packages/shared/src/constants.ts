// =============================================================================
// @twio/shared — project constants & configuration knobs
// =============================================================================

import type { LicenseStatus, ProviderName } from "./types.js";

// --- Project -----------------------------------------------------------------
export const PROJECT_NAME = "THE_WORLD_IS_OURS";
export const PROJECT_DESCRIPTION = "Commercial YouTube Music Video";

// Default project id (the seeded "The World Is Ours" project). Existing rows
// are backfilled to this id during migration so the single-project DB keeps
// working unchanged.
export const DEFAULT_PROJECT_ID = "THE_WORLD_IS_OURS";
export const DEFAULT_PROJECT_NAME = "The World Is Ours";
export const DEFAULT_PROJECT_DESCRIPTION = "Commercial YouTube Music Video";

// Virtual project id that aggregates every project's shots/assets/timelines.
// Never stored as a `projects` row; never deletable. Repository queries treat
// this id as "no project_id filter".
export const PROJECT_ID_ALL = "__ALL__";

// --- Section -> footage folder map (PRD §6 was illustrative; derived from the
// actual §27 dataset sections). 13 sections, zero-padded for sort order. ------
export const SECTION_FOLDERS: ReadonlyArray<{ section: string; folder: string }> = [
  { section: "INTRO", folder: "001_intro" },
  { section: "VERSE_1", folder: "002_verse_1" },
  { section: "PRE_CHORUS_1", folder: "003_pre_chorus_1" },
  { section: "CHORUS_1", folder: "004_chorus_1" },
  { section: "POST_CHORUS", folder: "005_post_chorus" },
  { section: "VERSE_2", folder: "006_verse_2" },
  { section: "PRE_CHORUS_2", folder: "007_pre_chorus_2" },
  { section: "CHORUS_2", folder: "008_chorus_2" },
  { section: "DANCE_BREAK", folder: "009_dance_break" },
  { section: "BRIDGE", folder: "010_bridge" },
  { section: "ACOUSTIC", folder: "011_acoustic" },
  { section: "BUILD", folder: "012_build" },
  { section: "FINAL_CHORUS", folder: "013_final_chorus" },
] as const;

export function sectionFolder(section: string): string {
  const found = SECTION_FOLDERS.find((s) => s.section === section);
  if (!found) {
    // Defensive fallback: slugify an unknown section so we never crash.
    return section.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }
  return found.folder;
}

// --- Approved providers seed (PRD §3) ----------------------------------------
export interface ProviderSeed {
  id: ProviderName;
  name: string;
  apiEnabled: 1 | 0;
  commercialLicensePolicy: string;
  licenseUrl: string;
  attributionUrl: string; // shown in UI (PRD §3.1/§3.2)
  active: 1 | 0;
}

export const PROVIDER_SEEDS: readonly ProviderSeed[] = [
  {
    id: "pexels",
    name: "Pexels",
    apiEnabled: 1,
    commercialLicensePolicy: "LICENSE_SOURCE_CONFIRMED",
    licenseUrl: "https://www.pexels.com/license/",
    attributionUrl: "https://www.pexels.com",
    active: 1,
  },
  {
    id: "pixabay",
    name: "Pixabay",
    apiEnabled: 1,
    commercialLicensePolicy: "LICENSE_SOURCE_CONFIRMED",
    licenseUrl: "https://pixabay.com/service/terms/",
    attributionUrl: "https://pixabay.com",
    active: 1,
  },
  {
    // P3: manual import only (PRD §3.3). Seeded inactive so the schema/seed is
    // ready for a future manual-import flow without code changes.
    id: "mixkit",
    name: "Mixkit",
    apiEnabled: 0,
    commercialLicensePolicy: "RIGHTS_REVIEW_REQUIRED",
    licenseUrl: "https://mixkit.co/license/",
    attributionUrl: "https://mixkit.co",
    active: 0,
  },
] as const;

// Map a provider's seed policy to a LicenseStatus.
export function providerLicenseStatus(providerId: ProviderName): LicenseStatus {
  const seed = PROVIDER_SEEDS.find((p) => p.id === providerId);
  if (!seed) return "UNKNOWN";
  return seed.commercialLicensePolicy as LicenseStatus;
}

// --- Technical filter thresholds (PRD §11) -----------------------------------
export const MIN_WIDTH = 1920;
export const MIN_HEIGHT = 1080;
export const MIN_DURATION_SECONDS = 2;
export const PREFERRED_RESOLUTIONS: ReadonlyArray<[number, number]> = [
  [3840, 2160],
  [1920, 1080],
];

// --- Scoring weights (PRD §12 technical score) -------------------------------
export const TECHNICAL_SCORE_WEIGHTS = {
  resolution: 0.4,
  duration: 0.2,
  fps: 0.1,
  aspect: 0.2,
  sourceQuality: 0.1,
} as const;

// --- Scoring weights (PRD §19 final score) -----------------------------------
export const FINAL_SCORE_WEIGHTS = {
  semanticRelevance: 0.35,
  visualQuality: 0.15,
  technicalQuality: 0.15,
  diversity: 0.15,
  actionMatch: 0.1,
  licensingConfidence: 0.1,
} as const;

// --- Diversity (PRD §17) -----------------------------------------------------
export const DIVERSITY_PENALTY = -0.25;
export const DIVERSITY_MAX_REUSE_BEFORE_REJECT = 2;

// --- Acquisition knobs (PRD §10, §20) ----------------------------------------
export const CANDIDATES_PER_PROVIDER_DEFAULT = 30;
export const TOP_N_PER_SHOT_DEFAULT = 5;
export const MAX_POOL_PER_SHOT = 60; // 30 Pexels + 30 Pixabay (deduped)

// --- Per-shot acquisition priority order -------------------------------------
// The system works in this priority order per shot:
//   1. Fetch a minimum of X candidates (search + query expansion until >= X)
//   2. Acquire up to Y candidates whose finalScore (0..1) is >= Z
// These are the defaults used when a shot's own columns are NULL. Each shot
// can override them via the shots.min_candidates / acquire_count /
// min_acquire_rating columns (editable from the dashboard).
export const MIN_CANDIDATES_PER_SHOT_DEFAULT = 20; // X
export const ACQUIRE_COUNT_DEFAULT = 5; // Y
export const MIN_ACQUIRE_RATING_DEFAULT = 0.5; // Z (finalScore threshold, 0..1)

// --- Near-duplicate detection (PRD §16 Level 3) ------------------------------
export const PHASH_HAMMING_THRESHOLD_DEFAULT = 8;

// --- Search cache (PRD §30) --------------------------------------------------
export const SEARCH_CACHE_TTL_MIN_DEFAULT = 60;

// --- Download safety (PRD §34) -----------------------------------------------
export const MAX_DOWNLOAD_MB_DEFAULT = 600;

// --- Rate limiting (PRD §31) -------------------------------------------------
// Per-provider request budgets.
export const RATE_LIMITS = {
  pexels: { maxRequests: 200, perMs: 60_000 },
  pixabay: { maxRequests: 100, perMs: 60_000 },
} as const;

// --- Query expansion (PRD §9, §29) -------------------------------------------
// Meaning-preserving synonym swaps. Applied to generate 3-5 variants without
// changing the intended visual meaning.
export const QUERY_SYNONYMS: ReadonlyArray<readonly [string, string[]]> = [
  ["children", ["kids", "child"]],
  ["kids", ["children", "child"]],
  ["outdoors", ["outside", "outdoor"]],
  ["outdoor", ["outdoors", "outside"]],
  ["running", ["running", "playing running"]],
  ["playing", ["playing", "having fun"]],
  ["happy", ["happy", "joyful", "cheerful"]],
  ["family", ["family", "families"]],
  ["friends", ["friends", "friendship"]],
  ["smiling", ["smiling", "happy", "laughing"]],
  ["laughing", ["laughing", "smiling", "happy"]],
  ["celebration", ["celebration", "celebrating", "party"]],
  ["celebrating", ["celebrating", "celebration"]],
  ["community", ["community", "people together"]],
  ["dancing", ["dancing", "dance"]],
  ["sunlight", ["sunlight", "sunny", "sun"]],
  ["sunny", ["sunny", "sunlight", "sun"]],
  ["elderly", ["elderly", "old person", "senior"]],
  ["stranger", ["stranger", "person"]],
  ["strangers", ["strangers", "people"]],
  ["helping", ["helping", "assisting"]],
  ["aerial", ["aerial", "drone", "overhead"]],
  ["crowd", ["crowd", "group of people"]],
  ["festival", ["festival", "festivity", "celebration"]],
] as const;

// Forbidden expansions (PRD §29) — these change the intended visual meaning and
// must never appear in a generated variant.
export const QUERY_FORBIDDEN_TOKENS = [
  "sports",
  "school",
  "classroom",
  "office",
  "studio",
  "interview",
  "studio portrait",
] as const;

// Final-chorus reserve pool queries (PRD §28). Not separate shot IDs — a
// reserve pool for editing the climax.
export const FINAL_CHORUS_RESERVE_QUERIES: readonly string[] = [
  "children jumping celebration",
  "festival crowd dancing",
  "large group celebration",
  "aerial people celebration",
  "diverse community dancing",
  "children running sunlight",
  "people dancing outdoors",
  "friends celebrating outdoors",
] as const;
export const FINAL_CHORUS_RESERVE_TARGET = 15; // 10-20 (PRD §28)

// --- Default shot spec (PRD §7) ----------------------------------------------
export const DEFAULT_ORIENTATION = "landscape";
export const DEFAULT_MIN_WIDTH = MIN_WIDTH;
export const DEFAULT_MIN_HEIGHT = MIN_HEIGHT;
export const DEFAULT_PRIORITY = 5;
