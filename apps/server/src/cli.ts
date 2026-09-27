// =============================================================================
// CLI — thin commander entrypoint for migrate/seed/acquire/manifests/dashboard
// =============================================================================

import { Command } from "commander";
import { ffmpegService } from "./video/ffmpeg.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { acquireAll, acquireShot } from "./acquisition/pipeline.js";
import { acquireReserve } from "./acquisition/runner.js";
import { generateFootageManifest, generateLicenseManifest } from "./manifests/csv.js";
import { generateJsonManifest } from "./manifests/json.js";
import { generateContactSheetHtml, generateContactSheetJpeg, generateHtmlReport } from "./manifests/html.js";
import { getDashboard } from "./routes/dashboard.js";
import { closeDb } from "./db/client.js";
import { DEFAULT_PROJECT_ID, PROJECT_ID_ALL } from "@twio/shared";
import { getProject } from "./db/projectRepository.js";
import { projectPaths } from "./config.js";
import { reconcile } from "./reconcile.js";

const program = new Command();

program.name("twio").description("The World Is Ours — stock-footage acquisition").version("0.1.0");

program
  .command("migrate")
  .description("Create/upgrade the SQLite schema")
  .action(() => {
    migrate();
    closeDb();
  });

program
  .command("seed")
  .description("Seed providers + the 100-shot dataset (PRD §27)")
  .action(() => {
    migrate();
    seed();
    closeDb();
  });

program
  .command("ffmpeg-check")
  .description("Resolve and report the ffmpeg/ffprobe binary source")
  .action(async () => {
    await ffmpegService.ensure();
    const v = await ffmpegService.version();
    console.log(v);
    closeDb();
  });

program
  .command("acquire [shotId]")
  .description("Run the acquisition pipeline for one shot or all shots in a project")
  .option("-p, --project <id>", "project id (default: THE_WORLD_IS_OURS; '__ALL__' for every project)", DEFAULT_PROJECT_ID)
  .action(async (shotId?: string, opts?: { project?: string }) => {
    await ffmpegService.ensure();
    migrate();
    const projectId = opts?.project ?? DEFAULT_PROJECT_ID;
    if (shotId) {
      const p = await acquireShot(shotId);
      console.log(`done: ${p.shotId} -> ${p.status}`);
    } else {
      const results = await acquireAll((p) => console.log(`  ${p.shotId}: ${p.status}`), projectId);
      const ok = results.filter((r) => r.status === "REVIEW" || r.status === "DONE").length;
      console.log(`acquire complete: ${ok}/${results.length} shots have candidates (project: ${projectId})`);
    }
    closeDb();
  });

program
  .command("acquire:reserve")
  .description("Search the final-chorus reserve pool (PRD §28)")
  .option("-p, --project <id>", "project id", DEFAULT_PROJECT_ID)
  .action(async (opts?: { project?: string }) => {
    await ffmpegService.ensure();
    migrate();
    const projectId = opts?.project ?? DEFAULT_PROJECT_ID;
    const r = await acquireReserve(projectId);
    console.log(`reserve complete: ${r.total} candidates (project: ${projectId})`);
    closeDb();
  });

program
  .command("manifests")
  .description("Generate CSV/JSON/HTML manifests + contact sheets")
  .option("-p, --project <id>", "project id ('__ALL__' aggregates every project)", PROJECT_ID_ALL)
  .action(async (opts?: { project?: string }) => {
    const projectId = opts?.project ?? PROJECT_ID_ALL;
    const proj = projectId === PROJECT_ID_ALL ? undefined : getProject(projectId);
    const paths = proj ? projectPaths(proj.slug) : undefined;
    const name = proj?.name;
    const desc = proj?.description ?? undefined;
    generateFootageManifest(projectId, paths);
    generateLicenseManifest(projectId, paths);
    generateJsonManifest(projectId, paths, name);
    generateHtmlReport({ projectId, paths, projectName: name, projectDescription: desc });
    generateContactSheetHtml({ projectId, paths, projectName: name });
    await generateContactSheetJpeg({ projectId, paths });
    closeDb();
  });

program
  .command("dashboard")
  .description("Print the commercial-rights dashboard (PRD §24)")
  .option("-p, --project <id>", "project id ('__ALL__' aggregates every project)", PROJECT_ID_ALL)
  .action((opts?: { project?: string }) => {
    const projectId = opts?.project ?? PROJECT_ID_ALL;
    const d = getDashboard(projectId);
    console.log(`PROJECT                       ${projectId}`);
    console.log(`TOTAL ASSETS                 ${d.total}`);
    console.log(`LICENSE SOURCE CONFIRMED     ${d.confirmed}`);
    console.log(`HUMAN RIGHTS REVIEW           ${d.review}`);
    console.log(`REJECTED                      ${d.rejected}`);
    console.log(`APPROVED FOR EDIT             ${d.approved}`);
    console.log(`Source license verified: ${d.confirmed}/${d.total}`);
    closeDb();
  });

program
  .command("reconcile")
  .description("Scan footage directories and re-link downloaded .mp4 files to the DB (rebuilds asset records after DB loss)")
  .option("-p, --project <id>", "project id (default: THE_WORLD_IS_OURS)", DEFAULT_PROJECT_ID)
  .option("--dry-run", "scan and report only, no DB changes")
  .option("--skip-thumbnails", "skip thumbnail regeneration")
  .option("--skip-phash", "skip perceptual hash computation (faster)")
  .action(async (opts?: { project?: string; dryRun?: boolean; skipThumbnails?: boolean; skipPHash?: boolean }) => {
    const projectId = opts?.project ?? DEFAULT_PROJECT_ID;
    migrate();
    const r = await reconcile(projectId, {
      dryRun: opts?.dryRun,
      skipThumbnails: opts?.skipThumbnails,
      skipPHash: opts?.skipPHash,
    });
    console.log(`\nSummary: ${r.scanned} scanned, ${r.updated} updated, ${r.inserted} inserted, ${r.linksCreated} links created, ${r.skipped} skipped`);
    if (r.errors.length > 0) console.log(`Errors: ${r.errors.length}`);
    closeDb();
  });

program.parseAsync();
