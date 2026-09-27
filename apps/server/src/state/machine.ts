// =============================================================================
// Asset state machine (PRD §8)
//
// DISCOVERED -> TECHNICALLY_VALID -> LICENSE_SOURCE_CONFIRMED -> AI_REVIEWED
//   -> HUMAN_REVIEW_REQUIRED -> APPROVED_FOR_EDIT
//
// Rejection paths:
//   DISCOVERED -> REJECTED
//   LICENSE_SOURCE_CONFIRMED -> RIGHTS_RISK -> REJECTED
//
// Human review toggle: APPROVED_FOR_EDIT and REJECTED are reversible by the
// reviewer (KEEP/REJECT toggle in the UI). This is a human decision override,
// not a license-status change.
//
// Never allowed: UNKNOWN -> APPROVED_FOR_EDIT (enforced by canApprove).
// =============================================================================

import type { AssetState, LicenseStatus } from "@twio/shared";

const TRANSITIONS: Record<AssetState, AssetState[]> = {
  DISCOVERED: ["TECHNICALLY_VALID", "REJECTED"],
  TECHNICALLY_VALID: ["LICENSE_SOURCE_CONFIRMED", "REJECTED"],
  // LICENSE_SOURCE_CONFIRMED → APPROVED_FOR_EDIT is the human KEEP path (PRD
  // §2): the license is already confirmed, the reviewer's SELECT completes it.
  LICENSE_SOURCE_CONFIRMED: ["AI_REVIEWED", "HUMAN_REVIEW_REQUIRED", "RIGHTS_RISK", "REJECTED", "APPROVED_FOR_EDIT"],
  AI_REVIEWED: ["HUMAN_REVIEW_REQUIRED", "REJECTED"],
  HUMAN_REVIEW_REQUIRED: ["APPROVED_FOR_EDIT", "REJECTED"],
  RIGHTS_RISK: ["REJECTED", "HUMAN_REVIEW_REQUIRED"],
  // APPROVED_FOR_EDIT and REJECTED are reversible by human review — the
  // reviewer can change their mind. This is a UI toggle, not a legal status
  // change (the underlying license classification is unchanged).
  APPROVED_FOR_EDIT: ["REJECTED", "LICENSE_SOURCE_CONFIRMED"],
  REJECTED: ["APPROVED_FOR_EDIT", "LICENSE_SOURCE_CONFIRMED", "HUMAN_REVIEW_REQUIRED"],
};

export function canTransition(from: AssetState, to: AssetState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(from: AssetState, to: AssetState): AssetState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
  return to;
}

/**
 * Compute the license status (PRD §2) from a license string + provider policy.
 * An empty/unknown license yields UNKNOWN which can NEVER reach APPROVED.
 */
export function classifyLicense(
  sourceLicense: string | null,
  providerPolicy: LicenseStatus,
): LicenseStatus {
  if (!sourceLicense) {
    return "UNKNOWN";
  }
  return providerPolicy;
}

/**
 * The PRD §2 hard rule: only LICENSE_SOURCE_CONFIRMED and human-approved
 * RIGHTS_REVIEW_REQUIRED assets may reach APPROVED_FOR_EDIT.
 * A human reviewer can override a previous REJECTED decision (toggle behavior).
 */
export function canApprove(
  licenseStatus: LicenseStatus,
  state: AssetState,
  humanApproved: boolean,
): boolean {
  // REJECTED is reversible by explicit human approval — the reviewer is
  // changing their mind, not bypassing license checks.
  if (state === "REJECTED") return humanApproved;
  if (licenseStatus === "LICENSE_SOURCE_CONFIRMED") return true;
  if (licenseStatus === "RIGHTS_REVIEW_REQUIRED" && humanApproved) return true;
  return false;
}
