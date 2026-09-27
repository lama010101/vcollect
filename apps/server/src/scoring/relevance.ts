// =============================================================================
// Relevance score — P1 heuristic (PRD §13)
//
// P2 would call a vision model; P0+P1 uses keyword/tag overlap between the
// shot query (and expansions) and the asset title+tags. This is clearly a
// placeholder pending the vision API. The P2 field semantic_score stays null.
// =============================================================================

import type { AssetCandidate } from "@twio/shared";

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Heuristic semantic relevance: token-overlap between the union of
 * (query ∪ expansions) and the asset title+tags, boosted by exact-subject
 * keyword hits. Range 0–1.
 */
export function relevanceScore(
  query: string,
  expansions: string[],
  asset: AssetCandidate,
): number {
  const qTokens = new Set<string>([
    ...tokenize(query),
    ...expansions.flatMap(tokenize),
  ]);
  const aTokens = new Set<string>([
    ...tokenize(asset.title ?? ""),
    ...asset.tags.flatMap(tokenize),
    ...tokenize(asset.creatorName ?? ""),
  ]);
  const base = jaccard(qTokens, aTokens);
  // Boost: each query keyword present in tags/title adds a bit.
  let boost = 0;
  const hay = ((asset.title ?? "") + " " + asset.tags.join(" ")).toLowerCase();
  for (const t of tokenize(query)) {
    if (hay.includes(t)) boost += 0.05;
  }
  return Math.max(0, Math.min(1, base * 0.7 + Math.min(boost, 0.3)));
}

/**
 * Action match heuristic (PRD §19) — verb overlap. P1 placeholder; P2 vision.
 */
export function actionMatchScore(query: string, asset: AssetCandidate): number {
  const verbs = ["running", "dancing", "playing", "laughing", "smiling", "helping", "walking", "jumping", "celebrating", "spinning"];
  const qVerbs = new Set(verbs.filter((v) => query.toLowerCase().includes(v)));
  if (qVerbs.size === 0) return 0.5; // neutral when no action verb in query
  const hay = ((asset.title ?? "") + " " + asset.tags.join(" ")).toLowerCase();
  let hits = 0;
  for (const v of qVerbs) if (hay.includes(v)) hits++;
  return Math.max(0, Math.min(1, hits / qVerbs.size));
}
