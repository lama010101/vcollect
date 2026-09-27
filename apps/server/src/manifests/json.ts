// =============================================================================
// JSON manifest (PRD §26)
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_NAME, DEFAULT_PROJECT_ID } from "@twio/shared";
import { projectPaths, type ProjectPaths } from "../config.js";
import { listAllAssetsWithShots } from "../db/repository.js";

export function generateJsonManifest(
  projectId = "__ALL__",
  paths: ProjectPaths = projectPaths(DEFAULT_PROJECT_ID),
  projectName = PROJECT_NAME,
): string {
  const assets = listAllAssetsWithShots(projectId);
  const items = assets.map((a) => ({
    asset_id: a.id,
    shot_id: a.primary_shot_id ?? "",
    provider: a.provider_id,
    source_url: a.provider_url,
    creator: a.creator_name,
    creator_url: a.creator_url,
    license: a.source_license,
    license_url: a.license_url,
    license_status: a.commercial_status,
    rights_review: a.rights_review_status,
    sha256: a.sha256,
    local_path: a.local_path,
    width: a.width,
    height: a.height,
    duration_seconds: a.duration_seconds,
    final_score: a.final_score,
  }));
  const manifest = {
    project: projectName,
    commercial_use: true,
    platform: "YouTube",
    generated_at: new Date().toISOString(),
    assets: items,
  };
  mkdirSync(paths.manifests, { recursive: true });
  const dest = join(paths.manifests, "footage_manifest.json");
  writeFileSync(dest, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[manifests] footage_manifest.json -> ${dest} (${items.length} assets)`);
  return dest;
}
