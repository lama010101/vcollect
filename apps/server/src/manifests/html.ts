// =============================================================================
// HTML rights report (PRD §37) + contact sheets (PRD §22)
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { projectPaths, THUMBNAILS_DIR, config, type ProjectPaths } from "../config.js";
import { PROJECT_NAME, PROJECT_DESCRIPTION, PROVIDER_SEEDS, DEFAULT_PROJECT_ID } from "@twio/shared";
import { listAllAssetsWithShots } from "../db/repository.js";
import sharp from "sharp";

interface ManifestCtx {
  projectId?: string;
  paths?: ProjectPaths;
  projectName?: string;
  projectDescription?: string;
}
function resolveCtx(ctx: ManifestCtx = {}): { projectId: string; paths: ProjectPaths; projectName: string; projectDescription: string } {
  return {
    projectId: ctx.projectId ?? "__ALL__",
    paths: ctx.paths ?? projectPaths(DEFAULT_PROJECT_ID),
    projectName: ctx.projectName ?? PROJECT_NAME,
    projectDescription: ctx.projectDescription ?? PROJECT_DESCRIPTION,
  };
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generateHtmlReport(ctx: ManifestCtx = {}): string {
  const { projectId, paths, projectName, projectDescription } = resolveCtx(ctx);
  const assets = listAllAssetsWithShots(projectId);
  const counts = {
    total: assets.length,
    confirmed: assets.filter((a) => a.commercial_status === "LICENSE_SOURCE_CONFIRMED").length,
    review: assets.filter((a) => a.commercial_status === "HUMAN_REVIEW_REQUIRED").length,
    rejected: assets.filter((a) => a.commercial_status === "REJECTED").length,
    approved: assets.filter((a) => a.commercial_status === "APPROVED_FOR_EDIT").length,
  };
  const bySource = new Map<string, number>();
  for (const a of assets) bySource.set(a.provider_id, (bySource.get(a.provider_id) ?? 0) + 1);

  const rows = assets
    .map((a) => {
      const shotLabel = a.primary_shot_number != null ? `#${a.primary_shot_number} (${esc(a.primary_shot_section)})` : "";
      return `<tr>
        <td>${esc(a.primary_shot_id ?? "")}</td>
        <td>${shotLabel}</td>
        <td>${esc(a.provider_id)}</td>
        <td>${esc(a.creator_name)}</td>
        <td><a href="${esc(a.provider_url)}" target="_blank">source</a></td>
        <td><a href="${esc(a.license_url)}" target="_blank">license</a></td>
        <td>${esc(a.commercial_status)}</td>
        <td>${esc(a.rights_review_status)}</td>
        <td>${esc(a.downloaded_at)}</td>
        <td><code>${esc(a.sha256?.slice(0, 12))}…</code></td>
        <td>${esc(a.notes)}</td>
      </tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(projectName)} — Commercial Rights Report</title>
<style>
  body{font-family:system-ui,sans-serif;margin:2em;color:#222}
  h1,h2{color:#1a1a1a}
  table{border-collapse:collapse;width:100%;font-size:0.85em;margin-top:1em}
  th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#f4f4f4}
  .summary{display:flex;gap:2em;flex-wrap:wrap;margin:1em 0}
  .card{background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:1em 1.5em}
  .num{font-size:2em;font-weight:700}
  .warn{background:#fff7e6;border-color:#ffd591}
  a{color:#1677ff}
  .note{color:#888;font-size:0.85em;margin-top:2em}
</style></head><body>
<h1>${esc(projectName)}</h1>
<p>${esc(projectDescription)} — Commercial Rights Report</p>
<p>Generated: ${esc(new Date().toISOString())} · Output: ${esc(config.outputDir)}</p>

<h2>Summary</h2>
<div class="summary">
  <div class="card"><div class="num">${counts.total}</div>Total assets</div>
  <div class="card"><div class="num">${counts.confirmed}</div>Source-license confirmed</div>
  <div class="card warn"><div class="num">${counts.review}</div>Rights review</div>
  <div class="card"><div class="num">${counts.rejected}</div>Rejected</div>
  <div class="card"><div class="num">${counts.approved}</div>Approved for edit</div>
</div>
<p><strong>Source license verified: ${counts.confirmed}/${counts.total}</strong></p>

<h2>Sources</h2>
<ul>${PROVIDER_SEEDS.map((p: { id: string; name: string }) => `<li>${esc(p.name)}: ${bySource.get(p.id) ?? 0}</li>`).join("")}</ul>

<h2>Per-asset provenance</h2>
<table>
  <thead><tr><th>Shot</th><th>Section</th><th>Provider</th><th>Creator</th><th>Source URL</th><th>License URL</th><th>License status</th><th>Rights review</th><th>Download date</th><th>SHA-256</th><th>Notes</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="note">This report is a rights-management aid, not a legal opinion. License status reflects source-provided information and configured project rules. Unknown licenses cannot become approved automatically.</p>
</body></html>`;

  mkdirSync(paths.manifests, { recursive: true });
  const dest = join(paths.manifests, "commercial_rights_report.html");
  writeFileSync(dest, html, "utf8");
  console.log(`[manifests] commercial_rights_report.html -> ${dest}`);
  return dest;
}

// --- Contact sheet (PRD §22) --------------------------------------------------
export function generateContactSheetHtml(ctx: ManifestCtx = {}): string {
  const { projectId, paths, projectName } = resolveCtx(ctx);
  const assets = listAllAssetsWithShots(projectId).filter((a) => a.local_path);
  const cells = assets
    .map((a) => {
      const thumb = a.id ? `../../thumbnails/${a.id}.jpg` : "";
      const score = a.final_score != null ? Math.round(a.final_score * 100) : "—";
      return `<div class="cell">
        <a href="../../${esc(a.local_path)}" target="_blank"><img src="${esc(thumb)}" alt="${esc(a.id)}"></a>
        <div class="meta">
          <div class="line"><strong>${esc(a.primary_shot_id ?? "—")}</strong></div>
          <div class="line">${esc(a.id)}</div>
          <div class="line">Score ${score}</div>
          <div class="line">License: ${esc(a.commercial_status)}</div>
          <div class="line">Risk: ${esc(a.rights_review_status)}</div>
          <div class="line"><a href="${esc(a.provider_url)}" target="_blank">source</a> · <a href="${esc(a.license_url)}" target="_blank">license</a></div>
        </div>
      </div>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(projectName)} — Contact Sheet</title>
<style>
  body{font-family:system-ui,sans-serif;margin:1em;background:#222;color:#eee}
  h1{color:#fff}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
  .cell{background:#333;padding:8px;border-radius:4px}
  .cell img{width:100%;height:140px;object-fit:cover;display:block;background:#000}
  .meta{font-size:0.75em;margin-top:6px}
  .line{margin:2px 0}
  a{color:#69b7ff}
</style></head><body>
<h1>${esc(projectName)} — Contact Sheet</h1>
<p>${assets.length} assets</p>
<div class="grid">${cells}</div>
</body></html>`;

  mkdirSync(paths.contactSheets, { recursive: true });
  const dest = join(paths.contactSheets, "contact_sheet.html");
  writeFileSync(dest, html, "utf8");
  console.log(`[contact] contact_sheet.html -> ${dest}`);
  return dest;
}

// JPEG contact sheet via sharp composite (PRD §22).
export async function generateContactSheetJpeg(ctx: ManifestCtx = {}): Promise<string> {
  const { projectId, paths } = resolveCtx(ctx);
  const assets = listAllAssetsWithShots(projectId).filter((a) => a.local_path).slice(0, 60);
  mkdirSync(paths.contactSheets, { recursive: true });
  const dest = join(paths.contactSheets, "contact_sheet.jpg");
  if (assets.length === 0) {
    // Write a blank placeholder.
    await sharp({ create: { width: 640, height: 480, channels: 3, background: "#222" } }).jpeg().toFile(dest);
    return dest;
  }
  const cols = 6;
  const rows = Math.ceil(assets.length / cols);
  const cellW = 240;
  const cellH = 135;
  const pad = 8;
  const composites: Array<{ input: Buffer; top: number; left: number }> = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i]!;
    const thumbPath = join(THUMBNAILS_DIR, `${a.id}.jpg`);
    try {
      const buf = await sharp(thumbPath).resize(cellW, cellH, { fit: "cover" }).toBuffer();
      const col = i % cols;
      const row = Math.floor(i / cols);
      composites.push({
        input: buf,
        top: pad + row * (cellH + pad),
        left: pad + col * (cellW + pad),
      });
    } catch {
      // skip missing thumbnail
    }
  }
  const totalW = pad + cols * (cellW + pad);
  const totalH = pad + rows * (cellH + pad);
  await sharp({ create: { width: totalW, height: totalH, channels: 3, background: "#222" } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toFile(dest);
  console.log(`[contact] contact_sheet.jpg -> ${dest}`);
  void basename;
  return dest;
}
