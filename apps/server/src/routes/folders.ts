// =============================================================================
// Folder tree (PRD §6 output layout) — groups downloaded assets by their
// section so the UI can show the on-disk structure with asset details.
//
// Multi-project: real asset files live in each project's dedicated folder
// (OUTPUT_ROOT/<slug>/assets/). The grouping here is by section (derived from
// the shot_assets → shots.section join), NOT from the physical path.
//
// `getFolders(projectId)` filters assets by project; for the virtual "__ALL__"
// project it aggregates every project's assets and tags each with its project.
// =============================================================================

import { exec } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { OUTPUT_ROOT, projectPaths, type ProjectPaths } from "../config.js";
import { db } from "../db/client.js";
import { listAllAssets } from "../db/repository.js";
import { SECTION_FOLDERS, PROJECT_ID_ALL, sectionFolder } from "@twio/shared";
import type { AssetRow, ProjectRow } from "../db/schema.js";

export interface FolderAsset {
  assetId: string;
  filename: string;
  relativePath: string; // relative to OUTPUT_ROOT (e.g. "<query>/PEXELS_123.mp4")
  absolutePath: string; // absolute filesystem path
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  providerId: string;
  commercialStatus: string | null;
  shotIds: string[];
  finalScore: number | null;
  ready: boolean;
  rating: number | null; // 0-10, null = unrated
  projectId: string;
  projectName: string;
}

export interface FolderNode {
  folder: string; // e.g. "001_intro"
  section: string | null; // e.g. "INTRO"
  relativePath: string; // e.g. <slug>/assets
  absolutePath: string; // e.g. D:\...\OUTPUT_ROOT\<slug>\assets
  assetCount: number;
  assets: FolderAsset[];
  projectId: string;
  projectName: string;
}

export interface FoldersResponse {
  outputRoot: string;
  footageRoot: string; // OUTPUT_ROOT where all query subfolders live
  folders: FolderNode[];
  totalDownloaded: number;
  projectId: string;
}

// Lazy prepared statement (modules are imported before migrate() runs — see
// db/client.ts). Maps asset_id → shot_ids via the shot_assets join table.
type Stmt = ReturnType<typeof db.prepare>;
let _assetShotsStmt: Stmt | null = null;
function assetShotsStmt(): Stmt {
  return (_assetShotsStmt ??= db.prepare(
    `SELECT asset_id, shot_id FROM shot_assets ORDER BY shot_id ASC`,
  ));
}

// Maps asset_id → the primary shot's section (via shot_assets → shots join).
// Used to group assets by section in the folder tree, since files are now
// stored flat in Collector/ and the section is a DB-level attribute.
let _assetSectionStmt: Stmt | null = null;
function assetSectionStmt(): Stmt {
  return (_assetSectionStmt ??= db.prepare(
    `SELECT sa.asset_id, s.section AS section
     FROM shot_assets sa
     JOIN shots s ON s.id = sa.shot_id
     WHERE sa.is_reserve = 0
     ORDER BY sa.rank ASC`,
  ));
}

let _allProjectsStmt: Stmt | null = null;
function allProjectsStmt(): Stmt {
  return (_allProjectsStmt ??= db.prepare(`SELECT id, name, slug FROM projects ORDER BY name ASC`));
}

/** Look up a project row by id. Returns undefined for the virtual __ALL__. */
let _projectByIdStmt: Stmt | null = null;
function projectByIdStmt(): Stmt {
  return (_projectByIdStmt ??= db.prepare(`SELECT id, name, slug FROM projects WHERE id = ?`));
}
export function getProjectRow(id: string): ProjectRow | undefined {
  if (id === PROJECT_ID_ALL) return undefined;
  return projectByIdStmt().get(id) as ProjectRow | undefined;
}

/**
 * Build the folder tree from all downloaded assets in a project. Assets are
 * grouped by their section (derived from the shot_assets → shots.section join,
 * NOT from the physical folder path). Empty section folders (from
 * SECTION_FOLDERS with no downloaded assets) are included so the user sees
 * the full expected structure.
 *
 * For PROJECT_ID_ALL, every project's folders are included and each
 * FolderNode/FolderAsset is tagged with its project id/name.
 */
export function getFolders(projectId = PROJECT_ID_ALL): FoldersResponse {
  const assets = listAllAssets(projectId).filter((a) => a.local_path);

  // Build asset_id → shot_ids map in a single query.
  const assetToShots = new Map<string, string[]>();
  const rows = assetShotsStmt().all() as Array<{ asset_id: string; shot_id: string }>;
  for (const r of rows) {
    const arr = assetToShots.get(r.asset_id) ?? [];
    arr.push(r.shot_id);
    assetToShots.set(r.asset_id, arr);
  }

  // Build asset_id → section map (from the primary shot's section).
  const assetToSection = new Map<string, string>();
  const secRows = assetSectionStmt().all() as Array<{ asset_id: string; section: string }>;
  for (const r of secRows) {
    if (!assetToSection.has(r.asset_id)) assetToSection.set(r.asset_id, r.section);
  }

  // Project id → { name, paths } map. For __ALL__ we need every project; for
  // a concrete project we only need that one.
  const projectMap = new Map<string, { name: string; paths: ProjectPaths }>();
  if (projectId === PROJECT_ID_ALL) {
    const pros = allProjectsStmt().all() as Array<{ id: string; name: string; slug: string }>;
    for (const p of pros) projectMap.set(p.id, { name: p.name, paths: projectPaths(p.slug) });
  } else {
    const p = getProjectRow(projectId);
    if (p) projectMap.set(p.id, { name: p.name, paths: projectPaths(p.slug) });
  }

  // Group assets by (projectId, sectionFolderName). The section is derived
  // from the DB (shot_assets → shots.section), not from the physical path.
  const byProjectFolder = new Map<string, FolderAsset[]>();

  for (const a of assets as AssetRow[]) {
    const proj = projectMap.get(a.project_id);
    if (!proj) continue; // asset's project not found — skip
    const rel = a.local_path!.replace(/\\/g, "/");
    const abs = resolve(OUTPUT_ROOT, rel);
    const filename = basename(rel);
    // Derive the section folder from the DB. Assets not linked to any shot
    // (e.g. search-page acquires with no shot) go to a "SEARCH" fallback.
    // Local files (provider "local" — drag & drop or synced from disk) group
    // by their real physical subfolder under <slug>/assets/ so the view
    // mirrors the folder contents exactly ("uploads", a query name, …).
    let folderName: string;
    if (a.provider_id === "local") {
      const parts = rel.split("/");
      // rel = "<slug>/assets/<sub>/file.ext" (or "<slug>/assets/file.ext")
      folderName = parts.length >= 4 ? (parts[2] ?? "uploads") : "uploads";
    } else {
      const section = assetToSection.get(a.id) ?? "SEARCH";
      folderName = sectionFolder(section);
    }
    const key = `${a.project_id}\u0000${folderName}`;
    const fa: FolderAsset = {
      assetId: a.id,
      filename,
      relativePath: rel,
      absolutePath: abs,
      width: a.width,
      height: a.height,
      durationSeconds: a.duration_seconds,
      providerId: a.provider_id,
      commercialStatus: a.commercial_status,
      shotIds: assetToShots.get(a.id) ?? [],
      finalScore: a.final_score,
      ready: a.ready !== 0,
      rating: a.rating,
      projectId: a.project_id,
      projectName: proj.name,
    };
    const arr = byProjectFolder.get(key) ?? [];
    arr.push(fa);
    byProjectFolder.set(key, arr);
  }

  // Build the folder list. For each project (in name order), emit the
  // SECTION_FOLDERS order plus any extra folders that appear on disk.
  const folders: FolderNode[] = [];
  const orderedProjects = [...projectMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const proj of orderedProjects) {
    const projId = [...projectMap.entries()].find(([, v]) => v === proj)![0];
    const seen = new Set<string>();
    for (const sf of SECTION_FOLDERS) {
      seen.add(sf.folder);
      const key = `${projId}\u0000${sf.folder}`;
      const assetsInFolder = byProjectFolder.get(key) ?? [];
      folders.push({
        folder: sf.folder,
        section: sf.section,
        relativePath: `${proj.paths.slug}/assets`,
        absolutePath: proj.paths.assets,
        assetCount: assetsInFolder.length,
        assets: assetsInFolder.sort((x, y) => x.filename.localeCompare(y.filename)),
        projectId: projId,
        projectName: proj.name,
      });
    }
    // Any unexpected folders (e.g. reserve pool, SEARCH fallback, or slugified
    // fallback sections).
    for (const [key, fa] of byProjectFolder) {
      const parts = key.split("\u0000");
      const pid = parts[0] ?? "";
      const folderName = parts[1] ?? "";
      if (pid !== projId || seen.has(folderName)) continue;
      folders.push({
        folder: folderName,
        section: null,
        relativePath: `${proj.paths.slug}/assets`,
        absolutePath: proj.paths.assets,
        assetCount: fa.length,
        assets: fa.sort((x, y) => x.filename.localeCompare(y.filename)),
        projectId: projId,
        projectName: proj.name,
      });
    }
  }

  // footageRoot: for a concrete project this is its dedicated assets folder
  // (OUTPUT_ROOT/<slug>/assets); for __ALL__ it's OUTPUT_ROOT.
  const footageRoot =
    projectId === PROJECT_ID_ALL
      ? OUTPUT_ROOT
      : (projectMap.get(projectId)?.paths.assets ?? OUTPUT_ROOT);

  return {
    outputRoot: OUTPUT_ROOT,
    footageRoot,
    folders,
    totalDownloaded: assets.length,
    projectId,
  };
}

/**
 * Reveal a file in the OS file explorer, or open it directly when it's a
 * directory. On Windows: `explorer /select,"file"` selects the file while
 * `explorer "dir"` opens the folder itself. On macOS: `open -R` reveals a
 * file, plain `open` opens a dir. Linux: xdg-open on the dir (containing
 * dir for files).
 */
export function revealInExplorer(absolutePath: string): { ok: boolean; error?: string } {
  if (!existsSync(absolutePath)) {
    return { ok: false, error: `file does not exist: ${absolutePath}` };
  }
  const isDir = statSync(absolutePath).isDirectory();
  const platform = process.platform;
  if (platform === "win32") {
    // explorer.exe is not always on PATH when spawned from Node; resolve it
    // from %SystemRoot% (typically C:\Windows). Use backslashes for the path.
    const winPath = absolutePath.replace(/\//g, "\\");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const explorer = `${systemRoot}\\explorer.exe`;
    // explorer.exe returns exit code 1 even on success, so don't treat a
    // non-zero code as failure — only surface spawn errors.
    exec(isDir ? `"${explorer}" "${winPath}"` : `"${explorer}" /select,"${winPath}"`, (err) => {
      if (err) console.error(`[reveal] failed: ${err.message}`);
    });
    return { ok: true };
  } else if (platform === "darwin") {
    exec(isDir ? `open "${absolutePath}"` : `open -R "${absolutePath}"`, (err) => {
      if (err) console.error(`[reveal] failed: ${err.message}`);
    });
    return { ok: true };
  } else {
    // Linux: open the dir itself, or the containing dir for a file.
    exec(`xdg-open "${isDir ? absolutePath : dirname(absolutePath)}"`, (err) => {
      if (err) console.error(`[reveal] failed: ${err.message}`);
    });
    return { ok: true };
  }
}

/** Resolve a local_path (relative to OUTPUT_ROOT) to an absolute filesystem path.
 * local_path is relative to OUTPUT_ROOT (e.g. "<query>/PEXELS_123.mp4").
 */
export function assetAbsolutePath(localPath: string, _slug: string): string {
  return resolve(OUTPUT_ROOT, localPath);
}
