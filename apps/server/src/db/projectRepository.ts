// =============================================================================
// Project repository — CRUD for the `projects` table.
//
// The virtual project id PROJECT_ID_ALL ("__ALL__") aggregates every project's
// data; it is never stored as a row and never deletable. `listProjects()`
// prepends it so the UI can show an "All Projects" entry.
//
// `createProject` auto-creates a default "Main" timeline so a new project is
// immediately usable in the Timeline UI. `deleteProject` cascades all scoped
// rows (timelines, shots, assets, shot_assets, edit_metadata, rights_reviews)
// and removes the project's output subfolder on disk — destructive, confirm
// in the UI.
// =============================================================================

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_PROJECT_DESCRIPTION,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  PROJECT_ID_ALL,
  type Project,
  type CreateProjectInput,
} from "@twio/shared";
import { db } from "./client.js";
import { IMAGE_FILE_EXTENSIONS, OUTPUT_ROOT, projectPaths, VIDEO_FILE_EXTENSIONS } from "../config.js";
import { createTimeline } from "./repository.js";
import type { ProjectRow } from "./schema.js";

type Stmt = ReturnType<typeof db.prepare>;
function lazy(sql: string): () => Stmt {
  let s: Stmt | null = null;
  return () => (s ??= db.prepare(sql));
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "project";
}

function toProject(row: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  acquire_count: number | null;
  enforce_acquire_count: number;
  min_candidates: number | null;
  enforce_min_candidates: number;
  min_acquire_rating: number | null;
  enforce_min_acquire_rating: number;
  candidates_per_provider: number | null;
}): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acquireCount: row.acquire_count,
    enforceAcquireCount: row.enforce_acquire_count !== 0,
    minCandidates: row.min_candidates,
    enforceMinCandidates: row.enforce_min_candidates !== 0,
    minAcquireRating: row.min_acquire_rating,
    enforceMinAcquireRating: row.enforce_min_acquire_rating !== 0,
    candidatesPerProvider: row.candidates_per_provider,
  };
}

const allProjectsStmt = lazy(`SELECT * FROM projects ORDER BY name ASC`);
export function listProjects(): Project[] {
  const rows = allProjectsStmt().all() as unknown as ProjectRow[];
  const projects = rows.map(toProject);
  // Prepend the virtual "All Projects" aggregate.
  const all: Project = {
    id: PROJECT_ID_ALL,
    name: "All Projects",
    slug: PROJECT_ID_ALL,
    description: null,
    createdAt: "",
    updatedAt: "",
    isVirtual: true,
  };
  return [all, ...projects];
}

const getProjectStmt = lazy(`SELECT * FROM projects WHERE id = ?`);
export function getProject(id: string): Project | undefined {
  if (id === PROJECT_ID_ALL) {
    return {
      id: PROJECT_ID_ALL,
      name: "All Projects",
      slug: PROJECT_ID_ALL,
      description: null,
      createdAt: "",
      updatedAt: "",
      isVirtual: true,
    };
  }
  const row = getProjectStmt().get(id) as unknown as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

/** Return the raw ProjectRow (with snake_case columns) for pipeline use. */
const getProjectRowStmt = lazy(`SELECT * FROM projects WHERE id = ?`);
export function getProjectRow(id: string): ProjectRow | undefined {
  if (id === PROJECT_ID_ALL) return undefined;
  return getProjectRowStmt().get(id) as unknown as ProjectRow | undefined;
}

const slugTakenStmt = lazy(`SELECT id FROM projects WHERE slug = ? OR id = ? LIMIT 1`);
/** Ensure a slug is unique across both the `slug` and `id` columns. Appends
 *  `_2`, `_3`, ... until free. */
function uniqueSlug(base: string): string {
  let slug = base;
  let n = 2;
  while (slugTakenStmt().get(slug, slug)) {
    slug = `${base}_${n++}`;
  }
  return slug;
}

/** Create a new project with a unique slug-based id and a default "Main"
 *  timeline. Throws if the name is empty. */
export function createProject(inp: CreateProjectInput): Project {
  const name = inp.name.trim();
  if (!name) throw new Error("project name required");
  const slug = uniqueSlug(slugify(name));
  const id = slug; // id == slug for simplicity (filesystem-safe)
  const now = nowIso();
  db.prepare(
    `INSERT INTO projects (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, slug, inp.description ?? null, now, now);
  // Auto-create a default "Main" timeline scoped to the new project.
  createTimeline(`TL_${id}_MAIN`, "Main", id);
  // Ensure the project's output subfolders exist.
  projectPaths(slug);
  return getProject(id)!;
}

const renameProjectStmt = lazy(
  `UPDATE projects SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ?`,
);
/** Rename a project. The slug is regenerated from the new name (uniquified).
 *  The on-disk subfolder is NOT renamed (the slug stays stable for path
 *  consistency); only the display name changes. Pass description to update it. */
export function renameProject(
  id: string,
  name: string,
  description?: string | null,
): Project {
  if (id === PROJECT_ID_ALL) throw new Error("cannot rename the virtual All Projects project");
  const existing = getProject(id);
  if (!existing) throw new Error(`project not found: ${id}`);
  const newName = name.trim();
  if (!newName) throw new Error("project name required");
  // Keep the existing slug stable so on-disk paths don't break; only update
  // the display name + description.
  renameProjectStmt().run(newName, existing.slug, description ?? existing.description ?? null, nowIso(), id);
  return getProject(id)!;
}

// --- Per-project acquisition settings ----------------------------------------

const updateProjectSettingsStmt = lazy(
  `UPDATE projects SET
     acquire_count = ?,
     enforce_acquire_count = ?,
     min_candidates = ?,
     enforce_min_candidates = ?,
     min_acquire_rating = ?,
     enforce_min_acquire_rating = ?,
     candidates_per_provider = ?,
     updated_at = ?
   WHERE id = ?`,
);

export interface ProjectSettingsInput {
  acquireCount?: number | null;
  enforceAcquireCount?: boolean;
  minCandidates?: number | null;
  enforceMinCandidates?: boolean;
  minAcquireRating?: number | null;
  enforceMinAcquireRating?: boolean;
  candidatesPerProvider?: number | null;
}

/** Update per-project acquisition settings. Each field is optional; only the
 *  provided fields are written. `null` clears a value (revert to shared
 *  constant default). Enforce flags are booleans stored as 0/1. */
export function updateProjectSettings(id: string, inp: ProjectSettingsInput): Project {
  if (id === PROJECT_ID_ALL) throw new Error("cannot configure the virtual All Projects project");
  const existing = getProjectRow(id);
  if (!existing) throw new Error(`project not found: ${id}`);
  // Merge: use the new value if provided, otherwise keep the existing value.
  const acquireCount = inp.acquireCount !== undefined ? inp.acquireCount : existing.acquire_count;
  const enforceAcquireCount = inp.enforceAcquireCount !== undefined ? (inp.enforceAcquireCount ? 1 : 0) : existing.enforce_acquire_count;
  const minCandidates = inp.minCandidates !== undefined ? inp.minCandidates : existing.min_candidates;
  const enforceMinCandidates = inp.enforceMinCandidates !== undefined ? (inp.enforceMinCandidates ? 1 : 0) : existing.enforce_min_candidates;
  const minAcquireRating = inp.minAcquireRating !== undefined ? inp.minAcquireRating : existing.min_acquire_rating;
  const enforceMinAcquireRating = inp.enforceMinAcquireRating !== undefined ? (inp.enforceMinAcquireRating ? 1 : 0) : existing.enforce_min_acquire_rating;
  const candidatesPerProvider = inp.candidatesPerProvider !== undefined ? inp.candidatesPerProvider : existing.candidates_per_provider;
  updateProjectSettingsStmt().run(
    acquireCount,
    enforceAcquireCount,
    minCandidates,
    enforceMinCandidates,
    minAcquireRating,
    enforceMinAcquireRating,
    candidatesPerProvider,
    nowIso(),
    id,
  );
  return getProject(id)!;
}

const deleteProjectStmt = lazy(`DELETE FROM projects WHERE id = ?`);
// shot_assets has no project_id and (on pre-CASCADE DBs) no ON DELETE action
// on either FK, so the cascade that removes the project's shots/assets would
// orphan link rows and fail with FOREIGN KEY constraint failed. edit_metadata
// and rights_reviews have project_id CASCADE but NO ACTION on their asset_id /
// shot_id FKs — if the assets cascade runs first, those deletes would fail.
// Remove all dependents explicitly before deleting the project row.
const deleteProjectShotLinksStmt = lazy(
  `DELETE FROM shot_assets
    WHERE shot_id IN (SELECT id FROM shots WHERE project_id = ?)
       OR asset_id IN (SELECT id FROM assets WHERE project_id = ?)`,
);
const deleteProjectMetadataStmt = lazy(`DELETE FROM edit_metadata WHERE project_id = ?`);
const deleteProjectReviewsStmt = lazy(`DELETE FROM rights_reviews WHERE project_id = ?`);
/** Delete a project and everything scoped to it. Cascades via FK ON DELETE
 *  CASCADE (timelines, shots, assets, rights_reviews, edit_metadata) and
 *  removes the project's output subfolder on disk. Refuses the virtual
 *  __ALL__ project and the default THE_WORLD_IS_OURS project (the default is
 *  protected so the seeded dataset is never lost accidentally). */
export function deleteProject(id: string): void {
  if (id === PROJECT_ID_ALL) throw new Error("cannot delete the virtual All Projects project");
  if (id === DEFAULT_PROJECT_ID) throw new Error("cannot delete the default project");
  const existing = getProject(id);
  if (!existing) throw new Error(`project not found: ${id}`);
  db.transaction(() => {
    deleteProjectShotLinksStmt().run(id, id);
    deleteProjectMetadataStmt().run(id);
    deleteProjectReviewsStmt().run(id);
    // The project cascade then removes shots, assets and timelines.
    deleteProjectStmt().run(id);
  });
  // Remove the project's output subfolder.
  try {
    rmSync(resolve(OUTPUT_ROOT, existing.slug), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[deleteProject] could not remove output folder for ${existing.slug}:`, (err as Error).message);
  }
}

// Ensure the default project exists (used by migrate/seed). Exported for tests.
export function ensureDefaultProject(): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO projects (id, name, slug, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_DESCRIPTION, now, now);
}

// Per-project counts for the Projects management page.
// `videoCount`/`imageCount` split downloaded assets by file extension (the same
// VIDEO_/IMAGE_FILE_EXTENSIONS the upload + folder-sync paths accept), and
// `coverAssetId` picks a representative downloaded asset for the tiles view —
// an image when the project has one, else the latest download (its thumbnail
// is a poster frame). All extension lists are compile-time constants.
const imageExtLike = [...IMAGE_FILE_EXTENSIONS].map((e) => `lower(local_path) LIKE '%${e}'`).join(" OR ");
const videoExtLike = [...VIDEO_FILE_EXTENSIONS].map((e) => `lower(local_path) LIKE '%${e}'`).join(" OR ");
const projectCountsSelects = `
     (SELECT COUNT(*) FROM shots WHERE shots.project_id = p.id) AS shotCount,
     (SELECT COUNT(*) FROM assets WHERE assets.project_id = p.id) AS assetCount,
     (SELECT COUNT(*) FROM assets WHERE assets.project_id = p.id AND assets.local_path IS NOT NULL) AS downloadedCount,
     (SELECT COUNT(*) FROM assets WHERE assets.project_id = p.id AND assets.local_path IS NOT NULL AND (${videoExtLike})) AS videoCount,
     (SELECT COUNT(*) FROM assets WHERE assets.project_id = p.id AND assets.local_path IS NOT NULL AND (${imageExtLike})) AS imageCount,
     (SELECT id FROM assets WHERE assets.project_id = p.id AND assets.local_path IS NOT NULL
        ORDER BY CASE WHEN (${imageExtLike}) THEN 0 ELSE 1 END, downloaded_at DESC, id
        LIMIT 1) AS coverAssetId`;
export interface ProjectCountsRow {
  shotCount: number;
  assetCount: number;
  downloadedCount: number;
  videoCount: number;
  imageCount: number;
  coverAssetId: string | null;
}
const projectCountsStmt = lazy(`SELECT ${projectCountsSelects} FROM projects p WHERE p.id = ?`);
export function projectCounts(id: string): ProjectCountsRow {
  if (id === PROJECT_ID_ALL) {
    const all = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM shots) AS shotCount,
         (SELECT COUNT(*) FROM assets) AS assetCount,
         (SELECT COUNT(*) FROM assets WHERE local_path IS NOT NULL) AS downloadedCount,
         (SELECT COUNT(*) FROM assets WHERE local_path IS NOT NULL AND (${videoExtLike})) AS videoCount,
         (SELECT COUNT(*) FROM assets WHERE local_path IS NOT NULL AND (${imageExtLike})) AS imageCount,
         (SELECT id FROM assets WHERE local_path IS NOT NULL
            ORDER BY CASE WHEN (${imageExtLike}) THEN 0 ELSE 1 END, downloaded_at DESC, id
            LIMIT 1) AS coverAssetId`,
    ).get() as unknown as ProjectCountsRow;
    return all;
  }
  const r = projectCountsStmt().get(id) as ProjectCountsRow | undefined;
  return r ?? { shotCount: 0, assetCount: 0, downloadedCount: 0, videoCount: 0, imageCount: 0, coverAssetId: null };
}
