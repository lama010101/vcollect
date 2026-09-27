// =============================================================================
// Migrator — idempotent schema bootstrap (PRD §7)
// Uses explicit CREATE TABLE IF NOT EXISTS for reliability on a fresh box
// (no drizzle-kit journal required). Safe to re-run.
// =============================================================================

import { db } from "./client.js";
import { DEFAULT_PROJECT_DESCRIPTION, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from "@twio/shared";
import { OUTPUT_ROOT, THUMBNAILS_DIR, PROJECT_ROOT, projectPaths, queryDir } from "../config.js";
import { readdirSync, existsSync, renameSync, rmSync, copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename, resolve } from "node:path";

// NOTE: column definitions mirror drizzle schema in db/schema.ts exactly.
const DDL = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    acquire_count INTEGER,
    enforce_acquire_count INTEGER NOT NULL DEFAULT 0,
    min_candidates INTEGER,
    enforce_min_candidates INTEGER NOT NULL DEFAULT 0,
    min_acquire_rating REAL,
    enforce_min_acquire_rating INTEGER NOT NULL DEFAULT 0,
    candidates_per_provider INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS timelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    script_text TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS shots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    shot_number INTEGER NOT NULL,
    section TEXT NOT NULL,
    lyrics TEXT,
    visual_description TEXT NOT NULL,
    search_query TEXT NOT NULL,
    alternative_queries TEXT,
    preferred_subject TEXT,
    preferred_orientation TEXT DEFAULT 'landscape',
    min_width INTEGER DEFAULT 1920,
    min_height INTEGER DEFAULT 1080,
    target_duration_seconds REAL,
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'SEARCH_PENDING',
    min_candidates INTEGER,
    acquire_count INTEGER,
    min_acquire_rating REAL,
    timeline_id TEXT,
    time_start_seconds REAL,
    time_end_seconds REAL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(timeline_id) REFERENCES timelines(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_enabled INTEGER DEFAULT 0,
    commercial_license_policy TEXT,
    license_url TEXT,
    attribution_url TEXT,
    active INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_asset_id TEXT,
    provider_url TEXT NOT NULL,
    download_url TEXT,
    title TEXT,
    creator_name TEXT,
    creator_url TEXT,
    width INTEGER,
    height INTEGER,
    duration_seconds REAL,
    fps REAL,
    orientation TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    sha256 TEXT,
    perceptual_hash TEXT,
    duplicate_flag TEXT DEFAULT 'NONE',
    aspect_flag TEXT DEFAULT 'STANDARD',
    discovered_at TEXT,
    downloaded_at TEXT,
    source_license TEXT,
    license_url TEXT,
    commercial_status TEXT DEFAULT 'DISCOVERED',
    rights_review_status TEXT DEFAULT 'OK',
    tags TEXT,
    logo_risk TEXT,
    person_risk TEXT,
    trademark_risk TEXT,
    semantic_score REAL,
    subject_match_score REAL,
    action_match_score REAL,
    environment_match_score REAL,
    emotion_match_score REAL,
    diversity_score REAL,
    vision_status TEXT DEFAULT 'NOT_RUN',
    ai_relevance_score REAL,
    technical_score REAL,
    duplicate_score REAL,
    final_score REAL,
    diversity_penalty_applied INTEGER DEFAULT 0,
    notes TEXT,
    ready INTEGER DEFAULT 1,
    rating INTEGER,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(provider_id) REFERENCES providers(id)
  )`,
  `CREATE TABLE IF NOT EXISTS shot_assets (
    shot_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    rank INTEGER,
    selected INTEGER DEFAULT 0,
    rejected INTEGER DEFAULT 0,
    rejection_reason TEXT,
    is_reserve INTEGER DEFAULT 0,
    on_rail INTEGER DEFAULT 0,
    PRIMARY KEY(shot_id, asset_id),
    FOREIGN KEY(shot_id) REFERENCES shots(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS rights_reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    reviewer TEXT,
    reviewed_at TEXT,
    license_verified INTEGER DEFAULT 0,
    commercial_use_confirmed INTEGER DEFAULT 0,
    people_reviewed INTEGER DEFAULT 0,
    trademark_reviewed INTEGER DEFAULT 0,
    logo_reviewed INTEGER DEFAULT 0,
    approved INTEGER DEFAULT 0,
    notes TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS search_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    query TEXT NOT NULL,
    parameters TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 1,
    response_hash TEXT NOT NULL,
    response_body TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS edit_metadata (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    asset_id TEXT,
    intended_lyric TEXT,
    story_purpose TEXT,
    planned_start_time REAL,
    planned_duration REAL,
    speed_modification REAL,
    crop TEXT,
    color_treatment TEXT,
    transition TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(shot_id) REFERENCES shots(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE SET NULL
  )`,
  // Helpful indexes for the review queue / manifests.
  `CREATE INDEX IF NOT EXISTS idx_assets_provider ON assets(provider_id, provider_asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_commercial_status ON assets(commercial_status)`,
  `CREATE INDEX IF NOT EXISTS idx_shot_assets_shot ON shot_assets(shot_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shot_assets_asset ON shot_assets(asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_search_cache_lookup ON search_cache(provider, query, page)`,
  `CREATE INDEX IF NOT EXISTS idx_shots_timeline ON shots(timeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_timelines_project ON timelines(project_id)`,
  // Composite index for listAssetsForShot (filters by shot_id, orders by rank).
  `CREATE INDEX IF NOT EXISTS idx_shot_assets_shot_rank ON shot_assets(shot_id, rank)`,
  // Indexes for duplicate detection (sha256 exact, pHash near-duplicate).
  `CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets(sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_phash ON assets(perceptual_hash)`,
  // Indexes for FK lookups (rights_reviews by asset, edit_metadata by shot).
  `CREATE INDEX IF NOT EXISTS idx_rights_reviews_asset ON rights_reviews(asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edit_metadata_shot ON edit_metadata(shot_id)`,
] as const;

export function migrate(): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.transaction(() => {
    for (const stmt of DDL) db.exec(stmt);
    // Idempotent column additions for existing DBs (SQLite has no
    // ADD COLUMN IF NOT EXISTS). Check pragma table_info before altering.
    addColumnIfMissing("assets", "ready", "INTEGER DEFAULT 1");
    addColumnIfMissing("assets", "rating", "INTEGER");
    addColumnIfMissing("assets", "tags", "TEXT");
    // Per-shot acquisition priority overrides (PRD §20 priority order).
    addColumnIfMissing("shots", "min_candidates", "INTEGER");
    addColumnIfMissing("shots", "acquire_count", "INTEGER");
    addColumnIfMissing("shots", "min_acquire_rating", "REAL");
    // Timeline membership + absolute timeline position.
    addColumnIfMissing("shots", "timeline_id", "TEXT");
    addColumnIfMissing("shots", "time_start_seconds", "REAL");
    addColumnIfMissing("shots", "time_end_seconds", "REAL");
    // Reference image URL (directorial reference, not a stored asset).
    addColumnIfMissing("shots", "reference_image_url", "TEXT");
    // Per-candidate "on the timeline rail" flag — set from the Shot Review
    // "ADD TO TIMELINE" button; the rail always includes on_rail candidates
    // even beyond its display cap.
    addColumnIfMissing("shot_assets", "on_rail", "INTEGER NOT NULL DEFAULT 0");
    // Original script text for timelines created by a script import.
    addColumnIfMissing("timelines", "script_text", "TEXT");
    // Multi-project: project_id columns. Added after the projects table is
    // created so the FK is satisfiable. Existing rows are backfilled to the
    // default project below.
    addColumnIfMissing("timelines", "project_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
    addColumnIfMissing("shots", "project_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
    addColumnIfMissing("assets", "project_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
    addColumnIfMissing("rights_reviews", "project_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
    addColumnIfMissing("edit_metadata", "project_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
    // Per-project acquisition settings (multi-project extension).
    addColumnIfMissing("projects", "acquire_count", "INTEGER");
    addColumnIfMissing("projects", "enforce_acquire_count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing("projects", "min_candidates", "INTEGER");
    addColumnIfMissing("projects", "enforce_min_candidates", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing("projects", "min_acquire_rating", "REAL");
    addColumnIfMissing("projects", "enforce_min_acquire_rating", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing("projects", "candidates_per_provider", "INTEGER");
    // Ensure the default project row exists, then backfill any NULL/legacy
    // project_id values to it (the ALTER above sets a DEFAULT but existing
    // rows may still carry NULL on some SQLite versions — guard both).
    bootstrapDefaultProject();
    // Bootstrap a default "Main" timeline (scoped to the default project) and
    // assign all existing shots in the default project to it so the seeded
    // 100-shot dataset is reachable from the Timeline UI. Runs once; on
    // subsequent migrations the timeline already exists and the UPDATE only
    // touches shots still missing a timeline_id.
    bootstrapDefaultTimeline();
  });
  // Migrate the output directory from the old "THE_WORLD_IS_OURS" location to
  // the new "output" location. Must run before other file migrations since
  // they depend on OUTPUT_ROOT being correct.
  migrateOutputDir();
  // Migrate on-disk files from the old footage/<section>/ layout to query-based
  // subfolders under OUTPUT_ROOT. Runs outside the DB transaction because it does
  // file I/O. Idempotent — skips if no old footage dir exists.
  migrateFootageToQuerySubfolders();
  // Migrate files from per-project Collector/ and global Assets/ to query-based
  // subfolders under OUTPUT_ROOT. Also moves per-project thumbnails/ to the
  // global thumbnails/ dir. Idempotent.
  migrateToQuerySubfolders();
  console.log(`[migrate] schema ready at ${new Date().toISOString()}`);
}

/**
 * Migrate the output directory from the old "THE_WORLD_IS_OURS" location to
 * the new "output" location. The old layout had OUTPUT_ROOT set to
 * PROJECT_ROOT/THE_WORLD_IS_OURS which created a duplicate nested folder
 * (since the project slug is also THE_WORLD_IS_OURS). The new layout uses
 * PROJECT_ROOT/output as OUTPUT_ROOT.
 *
 * Idempotent: if the old dir doesn't exist or the new dir already exists
 * with content, this is a no-op or merge.
 */
function migrateOutputDir(): void {
  const oldOutputRoot = resolve(PROJECT_ROOT, "THE_WORLD_IS_OURS");
  // OUTPUT_ROOT is already computed from the new config ("output").
  // If old dir doesn't exist, nothing to do.
  if (!existsSync(oldOutputRoot)) return;
  // If old and new are the same (user still has OUTPUT_DIR=THE_WORLD_IS_OURS),
  // nothing to do.
  if (oldOutputRoot === OUTPUT_ROOT) return;

  console.log(`[migrate] migrating output dir: ${oldOutputRoot} → ${OUTPUT_ROOT}`);
  mkdirSync(OUTPUT_ROOT, { recursive: true });

  // Move each top-level item from the old output root to the new one.
  const entries = readdirSync(oldOutputRoot, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(oldOutputRoot, entry.name);
    const dst = join(OUTPUT_ROOT, entry.name);
    if (existsSync(dst)) {
      // If the destination already exists, merge contents recursively.
      // This handles the case where the new dir was partially created by
      // projectPaths() before migration ran.
      if (entry.isDirectory()) {
        const subEntries = readdirSync(src, { withFileTypes: true });
        for (const sub of subEntries) {
          const subSrc = join(src, sub.name);
          const subDst = join(dst, sub.name);
          if (!existsSync(subDst)) {
            try { renameSync(subSrc, subDst); } catch { /* ignore */ }
          }
        }
        // Try to remove the now-empty source subdirectory.
        try { rmSync(src, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        // File exists at both locations — keep the new one, remove old.
        try { rmSync(src, { force: true }); } catch { /* ignore */ }
      }
    } else {
      try { renameSync(src, dst); } catch { /* ignore */ }
    }
  }

  // Remove the now-empty old output directory.
  try { rmSync(oldOutputRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`[migrate] output dir migration complete`);
}

/**
 * Migrate on-disk asset files from the old layout (footage/<section_folder>/
 * SHOT_###_<PROVIDER>_<id>.mp4) to query-based subfolders under OUTPUT_ROOT
 * (OUTPUT_ROOT/<search_query>/SHOT_###_<PROVIDER>_<id>.mp4). Updates DB
 * local_path values.
 *
 * Idempotent: if no old footage dir exists, this is a no-op. Safe to re-run.
 */
function migrateFootageToQuerySubfolders(): void {
  const projects = db.all(`SELECT id, slug FROM projects`) as Array<{ id: string; slug: string }>;
  for (const proj of projects) {
    const paths = projectPaths(proj.slug);
    const oldFootageDir = join(paths.output, "footage");
    if (!existsSync(oldFootageDir)) continue;

    const mp4Files = scanMp4Recursive(oldFootageDir);
    if (mp4Files.length === 0) {
      rmSync(oldFootageDir, { recursive: true, force: true });
      continue;
    }

    console.log(`[migrate] migrating ${mp4Files.length} file(s) from footage/ to query subfolders for project ${proj.id}`);

    for (const absPath of mp4Files) {
      const filename = basename(absPath);
      // Look up the search_query for this asset from the DB.
      const searchQuery = lookupSearchQuery(filename, proj.id);
      const dir = queryDir(searchQuery);
      const newAbsPath = join(dir, filename);
      const newRelPath = relativeToOutputRoot(newAbsPath);

      if (existsSync(newAbsPath)) {
        if (absPath !== newAbsPath) {
          try { rmSync(absPath, { force: true }); } catch { /* ignore */ }
        }
      } else {
        try {
          renameSync(absPath, newAbsPath);
        } catch {
          try {
            copyFileSync(absPath, newAbsPath);
            rmSync(absPath, { force: true });
          } catch {
            continue;
          }
        }
      }

      db.prepare(`UPDATE assets SET local_path = ? WHERE local_path LIKE ? AND project_id = ?`)
        .run(newRelPath, `%${filename}`, proj.id);
    }

    try { rmSync(oldFootageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`[migrate] migration complete for project ${proj.id}`);
  }

  // Also handle the legacy root-level footage dir (pre-multi-project).
  const legacyFootageDir = join(OUTPUT_ROOT, "footage");
  if (existsSync(legacyFootageDir)) {
    const mp4Files = scanMp4Recursive(legacyFootageDir);
    if (mp4Files.length > 0) {
      console.log(`[migrate] migrating ${mp4Files.length} file(s) from legacy root footage/ to query subfolders`);
      for (const absPath of mp4Files) {
        const filename = basename(absPath);
        const searchQuery = lookupSearchQuery(filename, undefined);
        const dir = queryDir(searchQuery);
        const newAbsPath = join(dir, filename);
        const newRelPath = relativeToOutputRoot(newAbsPath);
        if (!existsSync(newAbsPath)) {
          try {
            renameSync(absPath, newAbsPath);
          } catch {
            try {
              copyFileSync(absPath, newAbsPath);
              rmSync(absPath, { force: true });
            } catch {
              continue;
            }
          }
        }
        db.prepare(`UPDATE assets SET local_path = ? WHERE local_path LIKE ?`)
          .run(newRelPath, `%${filename}`);
      }
    }
    try { rmSync(legacyFootageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Migrate real asset files from per-project Collector/ dirs and the global
 * Assets/ dir to query-based subfolders under OUTPUT_ROOT. Also moves
 * per-project thumbnails/ to the global thumbnails/ dir. Updates DB
 * local_path values.
 *
 * Idempotent: if no per-project Collector or global Assets files exist, this
 * is a no-op.
 */
function migrateToQuerySubfolders(): void {
  mkdirSync(THUMBNAILS_DIR, { recursive: true });

  const projects = db.all(`SELECT id, slug FROM projects`) as Array<{ id: string; slug: string }>;
  for (const proj of projects) {
    const paths = projectPaths(proj.slug);

    // 1. Move real .mp4 files from <slug>/Collector/ to query subfolders.
    const collectorDir = join(paths.output, "Collector");
    if (existsSync(collectorDir)) {
      const mp4Files = scanMp4Recursive(collectorDir);
      for (const absPath of mp4Files) {
        const filename = basename(absPath);
        const searchQuery = lookupSearchQuery(filename, proj.id);
        const dir = queryDir(searchQuery);
        const newPath = join(dir, filename);
        const newRelPath = relativeToOutputRoot(newPath);
        if (existsSync(newPath)) {
          if (absPath !== newPath) {
            try { rmSync(absPath, { force: true }); } catch { /* ignore */ }
          }
        } else {
          try {
            renameSync(absPath, newPath);
          } catch {
            try {
              copyFileSync(absPath, newPath);
              rmSync(absPath, { force: true });
            } catch {
              continue;
            }
          }
        }
        db.prepare(`UPDATE assets SET local_path = ? WHERE local_path LIKE ? AND project_id = ?`)
          .run(newRelPath, `%${filename}`, proj.id);
      }
      // Clean up empty Collector dir.
      try { rmSync(collectorDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // 2. Move thumbnails from <slug>/thumbnails/ to global thumbnails/.
    const oldThumbDir = join(paths.output, "thumbnails");
    if (existsSync(oldThumbDir)) {
      const thumbFiles = readdirSync(oldThumbDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".jpg"));
      for (const f of thumbFiles) {
        const src = join(oldThumbDir, f.name);
        const dst = join(THUMBNAILS_DIR, f.name);
        if (existsSync(dst)) {
          try { rmSync(src, { force: true }); } catch { /* ignore */ }
        } else {
          try {
            renameSync(src, dst);
          } catch {
            try {
              copyFileSync(src, dst);
              rmSync(src, { force: true });
            } catch { /* ignore */ }
          }
        }
      }
      try { rmSync(oldThumbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // 3. Move files from global Assets/ to query subfolders.
  const legacyAssetsDir = join(OUTPUT_ROOT, "Assets");
  if (existsSync(legacyAssetsDir)) {
    const mp4Files = scanMp4Recursive(legacyAssetsDir);
    for (const absPath of mp4Files) {
      const filename = basename(absPath);
      const searchQuery = lookupSearchQuery(filename, undefined);
      const dir = queryDir(searchQuery);
      const newPath = join(dir, filename);
      const newRelPath = relativeToOutputRoot(newPath);
      if (existsSync(newPath)) {
        // Target already exists — just remove the old link/copy.
        if (absPath !== newPath) {
          try { unlinkSync(absPath); } catch { try { rmSync(absPath, { force: true }); } catch { /* file locked */ } }
        }
      } else {
        try {
          renameSync(absPath, newPath);
        } catch {
          try {
            copyFileSync(absPath, newPath);
            rmSync(absPath, { force: true });
          } catch { continue; }
        }
      }
      db.prepare(`UPDATE assets SET local_path = ? WHERE local_path LIKE ?`)
        .run(newRelPath, `%${filename}`);
    }
    // Clean up empty Assets dir.
    try { rmSync(legacyAssetsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 4. Handle legacy root-level Collector dir.
  const legacyCollectorDir = join(OUTPUT_ROOT, "Collector");
  if (existsSync(legacyCollectorDir)) {
    const mp4Files = scanMp4Recursive(legacyCollectorDir);
    for (const absPath of mp4Files) {
      const filename = basename(absPath);
      const searchQuery = lookupSearchQuery(filename, undefined);
      const dir = queryDir(searchQuery);
      const newPath = join(dir, filename);
      const newRelPath = relativeToOutputRoot(newPath);
      if (!existsSync(newPath)) {
        try {
          renameSync(absPath, newPath);
        } catch {
          try {
            copyFileSync(absPath, newPath);
            rmSync(absPath, { force: true });
          } catch { continue; }
        }
      }
      db.prepare(`UPDATE assets SET local_path = ? WHERE local_path LIKE ?`)
        .run(newRelPath, `%${filename}`);
    }
    try { rmSync(legacyCollectorDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Recursively scan a directory for .mp4 files, skipping symlinks. */
function scanMp4Recursive(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanMp4Recursive(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      results.push(full);
    }
  }
  return results;
}

/** Look up the search_query for an asset by filename. Parses the filename
 *  (SHOT_###_<PROVIDER>_<id>.mp4) to get the asset id, then queries the DB
 *  for the search_query from the linked shot. Falls back to "unknown". */
function lookupSearchQuery(filename: string, projectId?: string): string {
  // Parse asset id from filename: SHOT_001_PEXELS_19975560.mp4 → PEXELS_19975560
  const m = /^SHOT_\d{3}_([A-Z]+)_(.+)\.mp4$/.exec(filename);
  if (!m) return "unknown";
  const assetId = `${m[1]!}_${m[2]!}`;
  const sql = projectId
    ? `SELECT s.search_query FROM shots s
       JOIN shot_assets sa ON sa.shot_id = s.id
       WHERE sa.asset_id = ? AND s.project_id = ?
       ORDER BY sa.rank ASC LIMIT 1`
    : `SELECT s.search_query FROM shots s
       JOIN shot_assets sa ON sa.shot_id = s.id
       WHERE sa.asset_id = ?
       ORDER BY sa.rank ASC LIMIT 1`;
  const row = projectId
    ? db.prepare(sql).get(assetId, projectId) as { search_query: string } | undefined
    : db.prepare(sql).get(assetId) as { search_query: string } | undefined;
  return row?.search_query ?? "unknown";
}

/** Compute a path relative to OUTPUT_ROOT, with forward slashes. */
function relativeToOutputRoot(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const root = OUTPUT_ROOT.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.replace(root + "/", "");
}

/** Create the default "THE_WORLD_IS_OURS" project row and backfill any rows
 * with NULL project_id to it. Idempotent. */
function bootstrapDefaultProject(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, slug, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_DESCRIPTION, now, now);
  // Backfill NULL project_id on every scoped table. (The ALTER DEFAULT
  // handles new rows; this catches pre-existing rows that stayed NULL.)
  for (const table of ["timelines", "shots", "assets", "rights_reviews", "edit_metadata"]) {
    const res = db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id IS NULL`).run(DEFAULT_PROJECT_ID);
    if (res.changes > 0) {
      console.log(`[migrate] backfilled ${res.changes} ${table} row(s) to default project`);
    }
  }
}

/** Create a default "Main" timeline (scoped to the default project) and assign
 * any shots in the default project with NULL timeline_id to it. Idempotent. */
function bootstrapDefaultTimeline(): void {
  const DEFAULT_TIMELINE_ID = `TL_${DEFAULT_PROJECT_ID}_MAIN`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO timelines (id, name, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, project_id = excluded.project_id`,
  ).run(DEFAULT_TIMELINE_ID, "Main", DEFAULT_PROJECT_ID, now, now);
  // Also migrate any shots still referencing the legacy "TL_MAIN" id.
  db.prepare(`UPDATE shots SET timeline_id = ? WHERE timeline_id = 'TL_MAIN'`).run(DEFAULT_TIMELINE_ID);
  // Remove the legacy "TL_MAIN" timeline row now that all shots have been
  // migrated to the project-scoped id.
  db.prepare(`DELETE FROM timelines WHERE id = 'TL_MAIN'`).run();
  const res = db
    .prepare(`UPDATE shots SET timeline_id = ? WHERE timeline_id IS NULL AND project_id = ?`)
    .run(DEFAULT_TIMELINE_ID, DEFAULT_PROJECT_ID);
  if (res.changes > 0) {
    console.log(`[migrate] assigned ${res.changes} shot(s) to default timeline "${DEFAULT_TIMELINE_ID}"`);
  }
}

function addColumnIfMissing(table: string, column: string, def: string): void {
  const cols = db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    console.log(`[migrate] added column ${table}.${column}`);
  }
}
