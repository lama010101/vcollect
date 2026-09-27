// =============================================================================
// DB schema — plain TS row types for the SQLite tables (PRD §7 + extensions)
//
// We use Node's built-in node:sqlite with raw SQL (see db/client.ts). This file
// defines the row shapes and the table/column names as constants so queries
// stay consistent. DDL lives in db/migrate.ts.
//
// P2-only columns (vision scores, risks) are kept nullable so P2 is
// additive-only (per locked decision: no P2 AI vision this phase).
// =============================================================================

// --- Table names ---
export const TABLES = {
  projects: "projects",
  timelines: "timelines",
  shots: "shots",
  providers: "providers",
  assets: "assets",
  shotAssets: "shot_assets",
  rightsReviews: "rights_reviews",
  searchCache: "search_cache",
  editMetadata: "edit_metadata",
} as const;

// --- projects (user-created; each scopes shots/timelines/assets + an output
//     subfolder under OUTPUT_ROOT/<slug>/) ---
export interface ProjectRow {
  id: string; // slug-style id (PRIMARY KEY)
  name: string;
  slug: string; // filesystem-safe, UNIQUE
  description: string | null;
  created_at: string;
  updated_at: string;
  // Per-project acquisition settings (NULL = not set; enforce_* = 1 means the
  // project value overrides any per-shot override for that setting).
  acquire_count: number | null; // Y — max candidates to download per shot
  enforce_acquire_count: number; // 0/1
  min_candidates: number | null; // X — minimum candidate pool size
  enforce_min_candidates: number; // 0/1
  min_acquire_rating: number | null; // Z — finalScore threshold (0..1)
  enforce_min_acquire_rating: number; // 0/1
  candidates_per_provider: number | null; // perPage per provider per query
}

// --- timelines (user-created; each holds a set of shots; scoped to a project) ---
export interface TimelineRow {
  id: string;
  name: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  // Original script text that generated this timeline (script import only;
  // NULL for manually created timelines).
  script_text: string | null;
}

// --- shots (PRD §7) ---
export interface ShotRow {
  id: string;
  project_id: string;
  shot_number: number;
  section: string;
  lyrics: string | null;
  visual_description: string;
  search_query: string;
  alternative_queries: string | null; // JSON string[]
  preferred_subject: string | null;
  preferred_orientation: string | null;
  min_width: number | null;
  min_height: number | null;
  target_duration_seconds: number | null;
  priority: number | null;
  status: string | null;
  // Per-shot acquisition priority overrides (NULL → use shared defaults).
  //   min_candidates      = X (minimum candidates to fetch)
  //   acquire_count       = Y (max candidates to acquire/download)
  //   min_acquire_rating  = Z (finalScore threshold 0..1 to be acquired)
  min_candidates: number | null;
  acquire_count: number | null;
  min_acquire_rating: number | null;
  // Timeline membership + absolute position on the timeline (seconds from 0).
  timeline_id: string | null;
  time_start_seconds: number | null;
  time_end_seconds: number | null;
  // Directorial reference image URL (optional, from script import).
  reference_image_url: string | null;
}

/** ShotRow augmented with the kept (selected) candidate — used by the
 *  timeline-shots endpoint so the UI can preview the kept video per shot. */
export interface ShotWithKeptRow extends ShotRow {
  kept_asset_id: string | null;
  kept_downloaded: number | null; // 1 when the kept asset has a local file
}

// --- providers (PRD §7) ---
export interface ProviderRow {
  id: string;
  name: string;
  api_enabled: number;
  commercial_license_policy: string | null;
  license_url: string | null;
  attribution_url: string | null;
  active: number;
}

// --- assets (PRD §7 + P2-nullable columns) ---
export interface AssetRow {
  id: string;
  project_id: string;
  provider_id: string;
  provider_asset_id: string | null;
  provider_url: string;
  download_url: string | null;
  title: string | null;
  creator_name: string | null;
  creator_url: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  fps: number | null;
  orientation: string | null;
  thumbnail_url: string | null;
  local_path: string | null;
  sha256: string | null;
  perceptual_hash: string | null;
  duplicate_flag: string | null;
  aspect_flag: string | null;
  discovered_at: string | null;
  downloaded_at: string | null;
  source_license: string | null;
  license_url: string | null;
  commercial_status: string | null;
  rights_review_status: string | null;
  // Provider-supplied tags (JSON-encoded string[]; null when the provider
  // returned none). Surfaced in the review UI as common tags.
  tags: string | null;
  // P2-only (nullable / unpopulated in P0+P1):
  logo_risk: string | null;
  person_risk: string | null;
  trademark_risk: string | null;
  semantic_score: number | null;
  subject_match_score: number | null;
  action_match_score: number | null;
  environment_match_score: number | null;
  emotion_match_score: number | null;
  diversity_score: number | null;
  vision_status: string | null;
  // Scoring (P1 heuristic values):
  ai_relevance_score: number | null;
  technical_score: number | null;
  duplicate_score: number | null;
  final_score: number | null;
  diversity_penalty_applied: number | null;
  notes: string | null;
  ready: number | null; // 1 = ready (default), 0 = not ready
  rating: number | null; // user rating 0-10 (null = unrated)
}

// --- shot_assets (PRD §7) ---
export interface ShotAssetRow {
  shot_id: string;
  asset_id: string;
  rank: number | null;
  selected: number;
  rejected: number;
  rejection_reason: string | null;
  is_reserve: number;
  // 1 = user pinned this candidate onto the shot's Timeline-page rail (the
  // rail otherwise shows only the top `max` candidates by rank).
  on_rail: number;
}

// --- rights_reviews (PRD §7) ---
export interface RightsReviewRow {
  id: string;
  project_id: string;
  asset_id: string;
  reviewer: string | null;
  reviewed_at: string | null;
  license_verified: number;
  commercial_use_confirmed: number;
  people_reviewed: number;
  trademark_reviewed: number;
  logo_reviewed: number;
  approved: number;
  notes: string | null;
}

// --- search_cache (PRD §30) ---
export interface SearchCacheRow {
  id: number;
  provider: string;
  query: string;
  parameters: string;
  page: number;
  response_hash: string;
  response_body: string;
  fetched_at: string;
  expires_at: string | null;
}

// --- edit_metadata (PRD §36, P3-ready) ---
export interface EditMetadataRow {
  id: string;
  project_id: string;
  shot_id: string;
  asset_id: string | null;
  intended_lyric: string | null;
  story_purpose: string | null;
  planned_start_time: number | null;
  planned_duration: number | null;
  speed_modification: number | null;
  crop: string | null;
  color_treatment: string | null;
  transition: string | null;
}
