// =============================================================================
// Final ranker (PRD §19)
//
// FINAL = semantic_relevance*0.35 + visual_quality*0.15 + technical*0.15
//       + diversity*0.15 + action_match*0.10 + licensing_confidence*0.10
//
// Hard rejections override score (license_unknown, resolution_too_low,
// corrupt_file, restricted_license). P1 substitutions noted inline.
// =============================================================================

import { FINAL_SCORE_WEIGHTS } from "@twio/shared";
import type { LicenseStatus } from "@twio/shared";

export interface RankInputs {
  relevanceScore: number; // P1 heuristic (P2: semantic_score)
  visualQualityScore: number; // P1: derived from technical
  technicalScore: number;
  diversityScore: number;
  actionMatchScore: number; // P1 verb heuristic (P2: vision)
  licenseStatus: LicenseStatus;
  hardRejection: string | null;
}

export interface RankResult {
  finalScore: number;
  licensingConfidence: number;
  rejected: boolean;
  rejectionReason: string | null;
}

export function licensingConfidence(license: LicenseStatus): number {
  switch (license) {
    case "LICENSE_SOURCE_CONFIRMED":
      return 1.0;
    case "RIGHTS_REVIEW_REQUIRED":
      return 0.5;
    case "NOT_APPROVED":
    case "UNKNOWN":
      return 0.0;
    default:
      return 0.0;
  }
}

export function rank(inp: RankInputs): RankResult {
  // Hard rejection overrides score (PRD §19).
  if (inp.hardRejection) {
    return { finalScore: 0, licensingConfidence: licensingConfidence(inp.licenseStatus), rejected: true, rejectionReason: inp.hardRejection };
  }
  if (inp.licenseStatus === "UNKNOWN" || inp.licenseStatus === "NOT_APPROVED") {
    return { finalScore: 0, licensingConfidence: 0, rejected: true, rejectionReason: "license_unknown_or_not_approved" };
  }
  const conf = licensingConfidence(inp.licenseStatus);
  const score =
    inp.relevanceScore * FINAL_SCORE_WEIGHTS.semanticRelevance +
    inp.visualQualityScore * FINAL_SCORE_WEIGHTS.visualQuality +
    inp.technicalScore * FINAL_SCORE_WEIGHTS.technicalQuality +
    inp.diversityScore * FINAL_SCORE_WEIGHTS.diversity +
    inp.actionMatchScore * FINAL_SCORE_WEIGHTS.actionMatch +
    conf * FINAL_SCORE_WEIGHTS.licensingConfidence;
  return {
    finalScore: Math.max(0, Math.min(1, score)),
    licensingConfidence: conf,
    rejected: false,
    rejectionReason: null,
  };
}

/** Convert a 0..1 score to a 0..100 integer for display. */
export function scoreTo100(s: number): number {
  return Math.round(Math.max(0, Math.min(1, s)) * 100);
}
