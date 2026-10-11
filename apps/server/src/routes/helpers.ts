// =============================================================================
// Shared route helpers — numeric clamping + the `?project=` query-param reader.
// =============================================================================

import { DEFAULT_PROJECT_ID } from "@twio/shared";

// Coerce an optional request field to a clamped integer.
//   undefined input  → returns `def` (caller decides: null = clear, undefined = unchanged)
//   null input       → returns `def`
//   invalid input    → returns `def`
export function clampInt(v: unknown, min: number, max: number, def: number | null | undefined): number | null | undefined {
  if (v == null) return def;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}
export function clampNum(v: unknown, min: number, max: number, def: number | null | undefined): number | null | undefined {
  if (v == null) return def;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Extract the `?project=` query param, defaulting to the seeded project. */
export function projectOfQuery(query: Record<string, unknown>): string {
  const q = (query.project as string | undefined)?.trim();
  return q || DEFAULT_PROJECT_ID;
}
