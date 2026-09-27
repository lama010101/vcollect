// =============================================================================
// Duplicate detection (PRD §16) — three levels
//   L1 exact: SHA-256 identical -> duplicate=TRUE (reject)
//   L2 same source asset: provider + provider_asset_id already exists -> skip
//   L3 near-duplicate: perceptual hash Hamming distance <= threshold -> flag
// =============================================================================

import { createHash } from "node:crypto";
import type { DuplicateFlag } from "@twio/shared";

export function sha256OfBuffer(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Hamming distance between two hex pHash strings (each bit = 1 hex digit). */
export function hammingDistance(a: string, b: string): number {
  // pHash stored as hex; compare bit-by-bit via XOR of BigInt.
  if (!a || !b || a.length !== b.length) return 64;
  const bi = BigInt("0x" + a) ^ BigInt("0x" + b);
  let dist = 0;
  let n = bi;
  while (n) {
    dist += Number(n & 1n);
    n >>= 1n;
  }
  return dist;
}

export function nearDuplicate(a: string | null, b: string | null, threshold: number): boolean {
  if (!a || !b) return false;
  return hammingDistance(a, b) <= threshold;
}

/**
 * Classify an asset's duplicate flag given known existing hashes/ids.
 * Returns the worst flag found (EXACT > SAME_SOURCE > NEAR_DUPLICATE > NONE).
 */
export function classifyDuplicate(
  opts: {
    sha256: string | null;
    provider: string;
    providerAssetId: string | null;
    perceptualHash: string | null;
  },
  existing: {
    sha256s: Set<string>;
    sourceIds: Set<string>; // "provider:assetId"
    perceptualHashes: string[];
    threshold: number;
  },
): { flag: DuplicateFlag; duplicate: boolean; nearDupOf: string | null } {
  if (opts.sha256 && existing.sha256s.has(opts.sha256)) {
    return { flag: "EXACT", duplicate: true, nearDupOf: null };
  }
  if (opts.providerAssetId) {
    const key = `${opts.provider}:${opts.providerAssetId}`;
    if (existing.sourceIds.has(key)) {
      return { flag: "SAME_SOURCE", duplicate: true, nearDupOf: null };
    }
  }
  if (opts.perceptualHash) {
    for (const h of existing.perceptualHashes) {
      if (nearDuplicate(opts.perceptualHash, h, existing.threshold)) {
        return { flag: "NEAR_DUPLICATE", duplicate: false, nearDupOf: h };
      }
    }
  }
  return { flag: "NONE", duplicate: false, nearDupOf: null };
}
