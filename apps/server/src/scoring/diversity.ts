// =============================================================================
// Diversity scoring (PRD §17, §18)
//
// Penalize reuse of the same creator / same source asset / near-duplicate
// across shots. We do NOT infer ethnicity (PRD §18) — use provider metadata
// only. A diversity penalty is applied when an asset/creator already appears
// among selected assets in other shots.
// =============================================================================

import { DIVERSITY_MAX_REUSE_BEFORE_REJECT, DIVERSITY_PENALTY } from "@twio/shared";
import type { AssetRow } from "../db/schema.js";

export interface DiversityContext {
  /** asset_id -> count of shots where it was selected */
  selectedAssetIds: Map<string, number>;
  /** creator_name -> count of distinct selected assets by that creator */
  selectedCreators: Map<string, number>;
  /** perceptual_hash -> count of near-duplicates already selected */
  selectedHashes: Map<string, number>;
}

export function emptyDiversityContext(): DiversityContext {
  return {
    selectedAssetIds: new Map(),
    selectedCreators: new Map(),
    selectedHashes: new Map(),
  };
}

export interface DiversityResult {
  score: number; // 0..1
  penaltyApplied: boolean;
  reject: boolean; // reused too many times
  reason: string | null;
}

export function diversityScore(
  asset: AssetRow,
  ctx: DiversityContext,
  perceptualHash: string | null,
): DiversityResult {
  let reuse = 0;
  const reasons: string[] = [];

  const assetReuse = ctx.selectedAssetIds.get(asset.id) ?? 0;
  if (assetReuse > 0) {
    reuse = Math.max(reuse, assetReuse);
    reasons.push(`same_asset_used_${assetReuse}`);
  }

  if (asset.creator_name) {
    const creatorReuse = ctx.selectedCreators.get(asset.creator_name) ?? 0;
    if (creatorReuse > 0) {
      reuse = Math.max(reuse, creatorReuse);
      reasons.push(`same_creator_${asset.creator_name}_used_${creatorReuse}`);
    }
  }

  if (perceptualHash) {
    const hashReuse = ctx.selectedHashes.get(perceptualHash) ?? 0;
    if (hashReuse > 0) {
      reuse = Math.max(reuse, hashReuse);
      reasons.push(`near_duplicate_used_${hashReuse}`);
    }
  }

  if (reuse === 0) {
    return { score: 1.0, penaltyApplied: false, reject: false, reason: null };
  }
  if (reuse >= DIVERSITY_MAX_REUSE_BEFORE_REJECT) {
    return {
      score: Math.max(0, 1 + DIVERSITY_PENALTY * reuse),
      penaltyApplied: true,
      reject: true,
      reason: `diversity_reuse_exceeded: ${reasons.join(", ")}`,
    };
  }
  return {
    score: Math.max(0, 1 + DIVERSITY_PENALTY * reuse),
    penaltyApplied: true,
    reject: false,
    reason: `diversity_penalty: ${reasons.join(", ")}`,
  };
}

/** Record a selected asset so subsequent shots see it in the context. */
export function recordSelection(asset: AssetRow, ctx: DiversityContext, pHash: string | null): void {
  ctx.selectedAssetIds.set(asset.id, (ctx.selectedAssetIds.get(asset.id) ?? 0) + 1);
  if (asset.creator_name) {
    ctx.selectedCreators.set(
      asset.creator_name,
      (ctx.selectedCreators.get(asset.creator_name) ?? 0) + 1,
    );
  }
  if (pHash) {
    ctx.selectedHashes.set(pHash, (ctx.selectedHashes.get(pHash) ?? 0) + 1);
  }
}
