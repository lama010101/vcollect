// =============================================================================
// Seeder — providers + the 100-shot dataset (PRD §27) + edit_metadata stubs
// Idempotent: re-running upserts providers and shots by id (INSERT ... ON CONFLICT).
// =============================================================================

import {
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MIN_WIDTH,
  DEFAULT_ORIENTATION,
  DEFAULT_PROJECT_DESCRIPTION,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  PROVIDER_SEEDS,
  SHOT_DATASET,
} from "@twio/shared";
import { db } from "./client.js";

function shotId(num: number): string {
  return `SHOT_${String(num).padStart(3, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function seed(): void {
  db.transaction(() => {
    // --- default project (upsert) ---
    const now = nowIso();
    db.prepare(
      `INSERT INTO projects (id, name, slug, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, slug=excluded.slug, description=excluded.description,
         updated_at=excluded.updated_at`,
    ).run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_DESCRIPTION, now, now);

    // --- providers (upsert) ---
    const provStmt = db.prepare(
      `INSERT INTO providers (id, name, api_enabled, commercial_license_policy, license_url, attribution_url, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, api_enabled=excluded.api_enabled,
         commercial_license_policy=excluded.commercial_license_policy,
         license_url=excluded.license_url, attribution_url=excluded.attribution_url,
         active=excluded.active`,
    );
    for (const p of PROVIDER_SEEDS) {
      provStmt.run(
        p.id,
        p.name,
        p.apiEnabled,
        p.commercialLicensePolicy,
        p.licenseUrl,
        p.attributionUrl,
        p.active,
      );
    }

    // --- shots (100) — all scoped to the default project ---
    const shotStmt = db.prepare(
      `INSERT INTO shots (id, project_id, shot_number, section, lyrics, visual_description, search_query,
          preferred_orientation, min_width, min_height, target_duration_seconds, priority, status)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'SEARCH_PENDING')
       ON CONFLICT(id) DO UPDATE SET
         section=excluded.section, visual_description=excluded.visual_description,
         search_query=excluded.search_query, target_duration_seconds=excluded.target_duration_seconds,
         priority=excluded.priority, project_id=excluded.project_id`,
    );
    const editStmt = db.prepare(
      `INSERT OR IGNORE INTO edit_metadata (id, project_id, shot_id, story_purpose) VALUES (?, ?, ?, ?)`,
    );
    for (const row of SHOT_DATASET) {
      const id = shotId(row.shotNumber);
      shotStmt.run(
        id,
        DEFAULT_PROJECT_ID,
        row.shotNumber,
        row.section,
        row.visualDescription,
        row.searchQuery,
        DEFAULT_ORIENTATION,
        DEFAULT_MIN_WIDTH,
        DEFAULT_MIN_HEIGHT,
        row.targetSeconds,
        row.priority,
      );
      // edit_metadata stub (PRD §36): P1 populates only story purpose.
      editStmt.run(`EDIT_${id}`, DEFAULT_PROJECT_ID, id, row.visualDescription);
    }
  });

  const shotCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM shots")!;
  const provCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM providers")!;
  const projCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM projects")!;
  console.log(`[seed] projects=${projCount.c} providers=${provCount.c} shots=${shotCount.c} (expected 100)`);
}
