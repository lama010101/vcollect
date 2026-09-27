// =============================================================================
// Search cache — never repeat the same API search unnecessarily (PRD §30)
// Keyed by provider + query + normalized parameters + page. Reuses cached
// normalized candidate lists within a TTL.
// =============================================================================

import { createHash } from "node:crypto";
import type { AssetCandidate, SearchOptions } from "@twio/shared";
import { db } from "../db/client.js";
import { config } from "../config.js";

function paramKey(opts: SearchOptions): string {
  // Stable, sorted JSON so identical options always hit the cache.
  const sorted: Record<string, unknown> = {};
  for (const k of ["orientation", "minWidth", "minHeight", "perPage", "page"]) {
    const v = (opts as Record<string, unknown>)[k];
    if (v !== undefined) sorted[k] = v;
  }
  return JSON.stringify(sorted);
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiresIso(): string {
  return new Date(Date.now() + config.searchCacheTtlMin * 60_000).toISOString();
}

let _getStmt: ReturnType<typeof db.prepare> | null = null;
function getStmt() {
  return (_getStmt ??= db.prepare(
    `SELECT response_body, parameters, expires_at FROM search_cache
     WHERE provider=? AND query=? AND page=?`,
  ));
}

export function getCachedCandidates(
  provider: string,
  query: string,
  opts: SearchOptions,
  page: number,
): AssetCandidate[] | null {
  const pk = paramKey(opts);
  const rows = getStmt().all(provider, query, page) as Array<{
    response_body: string;
    parameters: string;
    expires_at: string | null;
  }>;
  for (const row of rows) {
    if (row.parameters !== pk) continue;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) continue;
    try {
      return JSON.parse(row.response_body) as AssetCandidate[];
    } catch {
      continue;
    }
  }
  return null;
}

let _putStmt: ReturnType<typeof db.prepare> | null = null;
function putStmt() {
  return (_putStmt ??= db.prepare(
    `INSERT INTO search_cache (provider, query, parameters, page, response_hash, response_body, fetched_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ));
}

export function putCachedCandidates(
  provider: string,
  query: string,
  opts: SearchOptions,
  page: number,
  candidates: AssetCandidate[],
): void {
  const pk = paramKey(opts);
  const body = JSON.stringify(candidates);
  const hash = createHash("sha256").update(body).digest("hex");
  putStmt().run(provider, query, pk, page, hash, body, nowIso(), expiresIso());
}

/** Remove expired cache rows (housekeeping). */
export function purgeExpired(): number {
  const res = db.run(`DELETE FROM search_cache WHERE expires_at <= ?`, nowIso());
  return res.changes;
}
