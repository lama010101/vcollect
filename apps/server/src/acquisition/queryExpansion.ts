// =============================================================================
// Query expansion (PRD §9, §29)
//
// Generate 3-5 meaning-preserving variants from the primary query using
// synonym swaps. Reject meaning-changing expansions (PRD §29 forbidden list).
// Never make queries excessively long.
// =============================================================================

import { QUERY_FORBIDDEN_TOKENS, QUERY_SYNONYMS } from "@twio/shared";

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Generate up to 4 variants (so total incl. primary = 5, per PRD §9). */
export function expandQuery(primaryQuery: string, max = 4): string[] {
  const tokens = tokenize(primaryQuery);
  const variants = new Set<string>();
  // Strategy 1: swap each token that has synonyms.
  for (let i = 0; i < tokens.length && variants.size < max; i++) {
    const tok = tokens[i]!;
    const syn = QUERY_SYNONYMS.find(([w]: readonly [string, readonly string[]]) => w === tok);
    if (!syn) continue;
    for (const s of syn[1]) {
      if (variants.size >= max) break;
      const candidateTokens = [...tokens];
      candidateTokens[i] = s;
      const candidate = candidateTokens.join(" ");
      if (candidate === primaryQuery) continue;
      if (containsForbidden(candidate)) continue;
      if (candidate.split(/\s+/).length > 8) continue; // not excessively long
      variants.add(candidate);
    }
  }
  // Strategy 2: drop trailing word (shorter, same meaning) if still >2 words.
  if (variants.size < max && tokens.length > 3) {
    const shorter = tokens.slice(0, -1).join(" ");
    if (!containsForbidden(shorter)) variants.add(shorter);
  }
  return Array.from(variants).slice(0, max);
}

function containsForbidden(q: string): boolean {
  const lower = q.toLowerCase();
  return QUERY_FORBIDDEN_TOKENS.some((f: string) => lower.includes(f));
}

/** All queries for a shot: primary + expansions (deduped, primary first). */
export function allQueries(primaryQuery: string): string[] {
  const out = [primaryQuery];
  for (const v of expandQuery(primaryQuery)) {
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
