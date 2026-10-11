// =============================================================================
// Provider routes — attribution links (PRD §3) + live search/acquire
//   GET  /api/providers              provider rows (license/attribution URLs)
//   POST /api/providers/search       live provider search (Pexels/Pixabay)
//   POST /api/providers/acquire      persist candidate + start download task
// =============================================================================

import type { FastifyInstance } from "fastify";
import {
  assetCandidateSchema,
  PROJECT_ID_ALL,
  type AssetCandidate,
  type SearchOptions,
} from "@twio/shared";
import { db } from "../db/client.js";
import { getProject } from "../db/projectRepository.js";
import { getAsset, persistStandaloneCandidate } from "../db/repository.js";
import { resolveProviders } from "../providers/factory.js";
import { startAcquireAssetTask } from "../acquisition/tasks.js";
import { projectOfQuery } from "./helpers.js";

export async function registerProviderRoutes(app: FastifyInstance): Promise<void> {
  // --- Providers (attribution links — PRD §3) --------------------------------
  app.get("/api/providers", async () => {
    const rows = db.all(`SELECT id, name, api_enabled, license_url, attribution_url, active FROM providers`) as Array<{
      id: string; name: string; api_enabled: number; license_url: string | null; attribution_url: string | null; active: number;
    }>;
    return { providers: rows };
  });

  // --- Live provider search (discover new assets from Pexels/Pixabay) ---------
  // Searches the live provider APIs for new candidates (not yet persisted).
  // Body: { query, orientation?, minWidth?, minHeight?, provider? }
  // When provider is omitted, searches both pexels + pixabay and merges.
  app.post("/api/providers/search", async (req, reply) => {
    const body = (req.body ?? {}) as {
      query?: unknown; orientation?: unknown;
      minWidth?: unknown; minHeight?: unknown; provider?: unknown;
    };
    const query = (body.query as string | undefined)?.trim();
    if (!query) return reply.code(400).send({ error: "query required" });
    const projectId = projectOfQuery(req.query as Record<string, unknown>);
    if (projectId === PROJECT_ID_ALL) {
      return reply.code(400).send({ error: "select a specific project before searching providers" });
    }

    const opts: SearchOptions = {};
    const orient = (body.orientation as string | undefined)?.trim();
    if (orient === "landscape" || orient === "portrait" || orient === "square") opts.orientation = orient;
    const mw = body.minWidth;
    if (mw != null && mw !== "") { const n = Number(mw); if (Number.isFinite(n)) opts.minWidth = n; }
    const mh = body.minHeight;
    if (mh != null && mh !== "") { const n = Number(mh); if (Number.isFinite(n)) opts.minHeight = n; }

    const { pexels, pixabay } = resolveProviders();
    const providerFilter = (body.provider as string | undefined)?.trim();
    const providerList = providerFilter === "pexels" ? [pexels]
      : providerFilter === "pixabay" ? [pixabay]
      : [pexels, pixabay];

    const failures: string[] = [];
    const pool: AssetCandidate[] = [];
    for (const p of providerList) {
      try {
        pool.push(...(await p.search(query, opts)));
      } catch (e) {
        failures.push(`${p.id}: ${(e as Error).message}`);
      }
    }
    if (failures.length > 0 && pool.length === 0) {
      return reply.code(502).send({ error: `provider search failed: ${failures.join(" | ")}` });
    }
    // Dedupe by provider:providerAssetId.
    const seen = new Set<string>();
    const deduped = pool.filter((c) => {
      const key = `${c.provider}:${c.providerAssetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { query, count: deduped.length, candidates: deduped };
  });

  // --- Acquire a provider candidate (persist + download) ----------------------
  // Persists the candidate as a standalone asset (no shot link) in the given
  // project, then triggers background download + post-processing.
  // Body: { candidate: AssetCandidate, projectId: string }
  app.post("/api/providers/acquire", async (req, reply) => {
    const body = (req.body ?? {}) as { candidate?: unknown; projectId?: unknown };
    const projectId = (body.projectId as string | undefined)?.trim();
    const parsed = assetCandidateSchema.safeParse(body.candidate);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const candidate = parsed.data;
    if (!projectId || projectId === PROJECT_ID_ALL) {
      return reply.code(400).send({ error: "a specific projectId is required" });
    }
    if (!getProject(projectId)) return reply.code(404).send({ error: "project not found" });

    const { assetId } = persistStandaloneCandidate(candidate, projectId);
    const asset = getAsset(assetId);
    if (asset?.local_path) {
      return { assetId, alreadyDownloaded: true, started: false };
    }
    // Start a concurrent download task (does not block on other downloads).
    const task = startAcquireAssetTask(assetId);
    return { assetId, started: true, task };
  });
}
