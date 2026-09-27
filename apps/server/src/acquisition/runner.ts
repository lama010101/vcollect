// =============================================================================
// Final-chorus reserve pool (PRD §28)
//
// Searches additional queries for the final-chorus climax and persists the
// results as reserve candidates (not separate shot IDs). Target 10-20.
// =============================================================================

import { FINAL_CHORUS_RESERVE_QUERIES, FINAL_CHORUS_RESERVE_TARGET, DEFAULT_PROJECT_ID } from "@twio/shared";
import { config } from "../config.js";
import { resolveProviders } from "../providers/factory.js";
import { persistCandidate } from "../db/repository.js";

const RESERVE_SHOT_ID = "RESERVE_FINAL_CHORUS";

export interface ReserveResult {
  query: string;
  candidatesPersisted: number;
}

export async function acquireReserve(
  projectId: string = DEFAULT_PROJECT_ID,
): Promise<{ total: number; perQuery: ReserveResult[] }> {
  const providers = resolveProviders();
  const opts = { orientation: "landscape" as const, minWidth: 1920, minHeight: 1080, perPage: 15 };
  const perQuery: ReserveResult[] = [];
  let total = 0;
  for (const q of FINAL_CHORUS_RESERVE_QUERIES) {
    if (total >= FINAL_CHORUS_RESERVE_TARGET) break;
    let persisted = 0;
    for (const provider of [providers.pexels, providers.pixabay]) {
      try {
        const candidates = await provider.search(q, opts);
        for (const c of candidates.slice(0, 4)) {
          persistCandidate(RESERVE_SHOT_ID, persisted + 1, c, projectId, true);
          persisted++;
          total++;
          if (total >= FINAL_CHORUS_RESERVE_TARGET) break;
        }
      } catch (e) {
        console.warn(`[reserve] ${q} via ${provider.id} failed: ${(e as Error).message}`);
      }
      if (total >= FINAL_CHORUS_RESERVE_TARGET) break;
    }
    perQuery.push({ query: q, candidatesPersisted: persisted });
    console.log(`[reserve] "${q}": +${persisted} (total ${total}/${FINAL_CHORUS_RESERVE_TARGET})`);
  }
  void config;
  return { total, perQuery };
}
