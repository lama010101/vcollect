// =============================================================================
// Review actions (PRD §23) — KEEP / REJECT / REVIEW_RIGHTS / REASSIGN / DOWNLOAD
// =============================================================================

import { randomUUID } from "node:crypto";
import type { ReviewRequest } from "@twio/shared";
import { canApprove, transition } from "../state/machine.js";
import { db } from "../db/client.js";
import { getAsset, markRejected, markSelectedExclusive } from "../db/repository.js";

type Stmt = ReturnType<typeof db.prepare>;
let _assetUpdateStatusStmt: Stmt | null = null;
function assetUpdateStatusStmt(): Stmt {
  return (_assetUpdateStatusStmt ??= db.prepare(
    `UPDATE assets SET commercial_status=?, rights_review_status=?, notes=COALESCE(?, notes) WHERE id=?`,
  ));
}
let _insertReviewStmt: Stmt | null = null;
function insertReviewStmt(): Stmt {
  return (_insertReviewStmt ??= db.prepare(
    `INSERT INTO rights_reviews (id, project_id, asset_id, reviewer, reviewed_at, license_verified, commercial_use_confirmed, people_reviewed, trademark_reviewed, logo_reviewed, approved, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ));
}
let _reassignStmt: Stmt | null = null;
function reassignStmt(): Stmt {
  return (_reassignStmt ??= db.prepare(`UPDATE shot_assets SET shot_id=? WHERE shot_id=? AND asset_id=?`));
}
let _shotStatusStmt: Stmt | null = null;
function shotStatusStmt(): Stmt {
  return (_shotStatusStmt ??= db.prepare(`UPDATE shots SET status=? WHERE id=?`));
}

/** Extends the shared ReviewRequest with an optional internal `reviewer` field
 *  (not exposed via the API schema — defaults to "human" in applyReview). */
export type ReviewInput = ReviewRequest & { reviewer?: string };

export function applyReview(shotId: string, assetId: string, inp: ReviewInput): { ok: boolean; status: string; reason?: string } {
  const asset = getAsset(assetId);
  if (!asset) return { ok: false, status: "error", reason: "asset not found" };
  const reviewedAt = new Date().toISOString();
  const reviewer = inp.reviewer ?? "human";

  switch (inp.action) {
    case "KEEP": {
      // PRD §2: only LICENSE_SOURCE_CONFIRMED or human-approved RIGHTS_REVIEW_REQUIRED
      // may become APPROVED_FOR_EDIT.
      const licenseStatus = asset.commercial_status === "HUMAN_REVIEW_REQUIRED" ? "RIGHTS_REVIEW_REQUIRED" : "LICENSE_SOURCE_CONFIRMED";
      const humanApproved = inp.commercialUseConfirmed ?? true;
      if (!canApprove(licenseStatus as never, asset.commercial_status as never, humanApproved)) {
        return { ok: false, status: "rejected", reason: "license status does not allow approval" };
      }
      try {
        transition(asset.commercial_status as never, "APPROVED_FOR_EDIT");
      } catch (e) {
        // If already approved, idempotent; otherwise report invalid transition.
        if (asset.commercial_status !== "APPROVED_FOR_EDIT") {
          return { ok: false, status: "error", reason: (e as Error).message };
        }
      }
      assetUpdateStatusStmt().run("APPROVED_FOR_EDIT", "OK", inp.notes ?? null, assetId);
      markSelectedExclusive(shotId, assetId);
      insertReviewStmt().run(randomUUID(), asset.project_id, assetId, reviewer, reviewedAt, inp.licenseVerified ? 1 : 0, inp.commercialUseConfirmed ? 1 : 0, inp.peopleReviewed ? 1 : 0, inp.trademarkReviewed ? 1 : 0, inp.logoReviewed ? 1 : 0, 1, inp.notes ?? null);
      shotStatusStmt().run("DONE", shotId);
      return { ok: true, status: "APPROVED_FOR_EDIT" };
    }
    case "REJECT": {
      assetUpdateStatusStmt().run("REJECTED", "REJECTED", inp.notes ?? null, assetId);
      markRejected(shotId, assetId, inp.notes ?? "rejected");
      insertReviewStmt().run(randomUUID(), asset.project_id, assetId, reviewer, reviewedAt, 0, 0, 0, 0, 0, 0, inp.notes ?? null);
      return { ok: true, status: "REJECTED" };
    }
    case "REVIEW_RIGHTS": {
      assetUpdateStatusStmt().run("HUMAN_REVIEW_REQUIRED", "REVIEW", inp.notes ?? null, assetId);
      insertReviewStmt().run(randomUUID(), asset.project_id, assetId, reviewer, reviewedAt, inp.licenseVerified ? 1 : 0, 0, inp.peopleReviewed ? 1 : 0, inp.trademarkReviewed ? 1 : 0, inp.logoReviewed ? 1 : 0, 0, inp.notes ?? null);
      return { ok: true, status: "HUMAN_REVIEW_REQUIRED" };
    }
    case "REASSIGN": {
      if (!inp.reassignToShotId) return { ok: false, status: "error", reason: "reassignToShotId required" };
      reassignStmt().run(inp.reassignToShotId, shotId, assetId);
      return { ok: true, status: "reassigned" };
    }
    case "DOWNLOAD":
    case "OPEN_SOURCE":
      return { ok: true, status: "noop" };
    default:
      return { ok: false, status: "error", reason: "unknown action" };
  }
}
