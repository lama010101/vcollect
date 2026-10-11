// =============================================================================
// Manifest routes (MODE E) — per-project manifest generation + serving
//   POST /api/manifests/generate?project=   regenerate all manifest artifacts
//   GET  /api/manifests/:file?project=      serve a generated manifest file
// =============================================================================

import type { FastifyInstance } from "fastify";
import { basename, resolve } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { projectPaths } from "../config.js";
import { getProject } from "../db/projectRepository.js";
import { generateFootageManifest, generateLicenseManifest } from "../manifests/csv.js";
import { generateJsonManifest } from "../manifests/json.js";
import { generateContactSheetHtml, generateContactSheetJpeg, generateHtmlReport } from "../manifests/html.js";
import { DEFAULT_PROJECT_ID, PROJECT_ID_ALL } from "@twio/shared";
import { projectOfQuery } from "./helpers.js";

export async function registerManifestRoutes(app: FastifyInstance): Promise<void> {
  // --- MODE E: manifest generation -------------------------------------------
  app.post("/api/manifests/generate", async (req) => {
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    // Manifests are per-project (they write into a project's manifests folder).
    // For __ALL__, fall back to the default project's folder.
    const proj = projectId === PROJECT_ID_ALL ? getProject(DEFAULT_PROJECT_ID) : getProject(projectId);
    const slug = proj?.slug ?? DEFAULT_PROJECT_ID;
    const paths = projectPaths(slug);
    const csv1 = generateFootageManifest(projectId, paths);
    const csv2 = generateLicenseManifest(projectId, paths);
    const json = generateJsonManifest(projectId, paths, proj?.name);
    const html = generateHtmlReport({ projectId, paths, projectName: proj?.name, projectDescription: proj?.description ?? undefined });
    const csh = generateContactSheetHtml({ projectId, paths, projectName: proj?.name });
    const csj = await generateContactSheetJpeg({ projectId, paths });
    return { footage_manifest_csv: csv1, license_manifest_csv: csv2, footage_manifest_json: json, rights_report_html: html, contact_sheet_html: csh, contact_sheet_jpg: csj };
  });

  app.get("/api/manifests/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    const proj = projectId === PROJECT_ID_ALL ? getProject(DEFAULT_PROJECT_ID) : getProject(projectId);
    const slug = proj?.slug ?? DEFAULT_PROJECT_ID;
    const paths = projectPaths(slug);
    const dest = resolve(paths.manifests, basename(file));
    if (!existsSync(dest)) return reply.code(404).send({ error: "not found" });
    reply.type(file.endsWith(".html") ? "text/html" : file.endsWith(".json") ? "application/json" : "text/csv");
    return reply.send(createReadStream(dest));
  });
}
