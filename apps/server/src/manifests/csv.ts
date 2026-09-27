// =============================================================================
// CSV manifest generators (PRD §25)
//   footage_manifest.csv — full asset inventory
//   license_manifest.csv — commercial-rights provenance (PRD §25 columns)
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, type ProjectPaths } from "../config.js";
import { DEFAULT_PROJECT_ID } from "@twio/shared";
import { listAllAssetsWithShots } from "../db/repository.js";

function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

export function generateFootageManifest(
  projectId = "__ALL__",
  paths: ProjectPaths = projectPaths(DEFAULT_PROJECT_ID),
): string {
  const assets = listAllAssetsWithShots(projectId);
  const header = [
    "asset_id", "shot_id", "provider", "provider_asset_id", "provider_url",
    "creator", "creator_url", "title", "width", "height", "duration_seconds",
    "fps", "orientation", "local_path", "sha256", "perceptual_hash",
    "duplicate_flag", "commercial_status", "rights_review_status",
    "technical_score", "final_score", "downloaded_at", "source_license", "license_url",
  ];
  const rows: string[][] = [header];
  for (const a of assets) {
    rows.push([
      a.id, a.primary_shot_id ?? "", a.provider_id, a.provider_asset_id ?? "", a.provider_url,
      a.creator_name ?? "", a.creator_url ?? "", a.title ?? "",
      String(a.width ?? ""), String(a.height ?? ""), String(a.duration_seconds ?? ""),
      String(a.fps ?? ""), a.orientation ?? "", a.local_path ?? "", a.sha256 ?? "",
      a.perceptual_hash ?? "", a.duplicate_flag ?? "", a.commercial_status ?? "",
      a.rights_review_status ?? "", String(a.technical_score ?? ""), String(a.final_score ?? ""),
      a.downloaded_at ?? "", a.source_license ?? "", a.license_url ?? "",
    ]);
  }
  const csv = toCsv(rows);
  mkdirSync(paths.manifests, { recursive: true });
  const dest = join(paths.manifests, "footage_manifest.csv");
  writeFileSync(dest, csv, "utf8");
  console.log(`[manifests] footage_manifest.csv -> ${dest} (${assets.length} assets)`);
  return dest;
}

export function generateLicenseManifest(
  projectId = "__ALL__",
  paths: ProjectPaths = projectPaths(DEFAULT_PROJECT_ID),
): string {
  const assets = listAllAssetsWithShots(projectId);
  const header = [
    "asset_id", "shot_id", "provider", "provider_asset_id", "provider_url",
    "creator", "creator_url", "source_license", "license_url",
    "commercial_use_status", "rights_review_status", "download_date",
    "filename", "sha256", "notes",
  ];
  const rows: string[][] = [header];
  for (const a of assets) {
    rows.push([
      a.id, a.primary_shot_id ?? "", a.provider_id, a.provider_asset_id ?? "", a.provider_url,
      a.creator_name ?? "", a.creator_url ?? "", a.source_license ?? "", a.license_url ?? "",
      a.commercial_status ?? "", a.rights_review_status ?? "", a.downloaded_at ?? "",
      a.local_path ?? "", a.sha256 ?? "", a.notes ?? "",
    ]);
  }
  const csv = toCsv(rows);
  mkdirSync(paths.manifests, { recursive: true });
  const dest = join(paths.manifests, "license_manifest.csv");
  writeFileSync(dest, csv, "utf8");
  console.log(`[manifests] license_manifest.csv -> ${dest}`);
  return dest;
}
