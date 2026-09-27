// =============================================================================
// Dashboard data (PRD §24) — license/rights summary
// NEVER show "100% legally safe". Show "Source license verified: N/100".
// =============================================================================

import { db } from "../db/client.js";
import { listShots } from "../db/repository.js";
import { PROJECT_ID_ALL } from "@twio/shared";

export interface Dashboard {
  total: number;
  confirmed: number;
  review: number;
  rejected: number;
  approved: number;
  byProvider: Record<string, number>;
  shotsTotal: number;
  shotsWithCandidates: number;
  shotsApproved: number;
  verifiedLabel: string; // "Source license verified: N/100"
  downloaded: number;
  notDownloaded: number;
  projectId: string;
}

// Lazy prepared statements (must be lazy because modules import before migrate() runs).
type Stmt = ReturnType<typeof db.prepare>;
function lazy(sql: string): () => Stmt {
  let s: Stmt | null = null;
  return () => (s ??= db.prepare(sql));
}

const assetCountsAllStmt = lazy(
  `SELECT
     COUNT(*) AS total,
     SUM(CASE WHEN commercial_status = 'LICENSE_SOURCE_CONFIRMED' OR commercial_status = 'APPROVED_FOR_EDIT' THEN 1 ELSE 0 END) AS confirmed,
     SUM(CASE WHEN commercial_status = 'HUMAN_REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS review,
     SUM(CASE WHEN commercial_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
     SUM(CASE WHEN commercial_status = 'APPROVED_FOR_EDIT' THEN 1 ELSE 0 END) AS approved,
     SUM(CASE WHEN local_path IS NOT NULL THEN 1 ELSE 0 END) AS downloaded
   FROM assets`,
);
const assetCountsByProjectStmt = lazy(
  `SELECT
     COUNT(*) AS total,
     SUM(CASE WHEN commercial_status = 'LICENSE_SOURCE_CONFIRMED' OR commercial_status = 'APPROVED_FOR_EDIT' THEN 1 ELSE 0 END) AS confirmed,
     SUM(CASE WHEN commercial_status = 'HUMAN_REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS review,
     SUM(CASE WHEN commercial_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
     SUM(CASE WHEN commercial_status = 'APPROVED_FOR_EDIT' THEN 1 ELSE 0 END) AS approved,
     SUM(CASE WHEN local_path IS NOT NULL THEN 1 ELSE 0 END) AS downloaded
   FROM assets WHERE project_id = ?`,
);
const byProviderAllStmt = lazy(
  `SELECT provider_id, COUNT(*) AS cnt FROM assets GROUP BY provider_id`,
);
const byProviderByProjectStmt = lazy(
  `SELECT provider_id, COUNT(*) AS cnt FROM assets WHERE project_id = ? GROUP BY provider_id`,
);

export function getDashboard(projectId = PROJECT_ID_ALL): Dashboard {
  const isAll = projectId === PROJECT_ID_ALL;
  const counts = (isAll ? assetCountsAllStmt().get() : assetCountsByProjectStmt().get(projectId)) as {
    total: number; confirmed: number; review: number; rejected: number; approved: number; downloaded: number;
  } | undefined;
  const providerRows = (isAll ? byProviderAllStmt().all() : byProviderByProjectStmt().all(projectId)) as Array<{ provider_id: string; cnt: number }>;
  const byProvider: Record<string, number> = {};
  for (const r of providerRows) byProvider[r.provider_id] = r.cnt;

  // Shot counts still use listShots since we need status filtering in JS.
  // (Could be optimized further with SQL CASE, but shot counts are small.)
  const shots = listShots(projectId);
  const shotsWithCandidates = shots.filter((s) => s.status && s.status !== "SEARCH_PENDING" && s.status !== "FAILED").length;
  const shotsApproved = shots.filter((s) => s.status === "DONE").length;

  const total = counts?.total ?? 0;
  const confirmed = counts?.confirmed ?? 0;
  const downloaded = counts?.downloaded ?? 0;
  return {
    total,
    confirmed,
    review: counts?.review ?? 0,
    rejected: counts?.rejected ?? 0,
    approved: counts?.approved ?? 0,
    byProvider,
    shotsTotal: shots.length,
    shotsWithCandidates,
    shotsApproved,
    verifiedLabel: `Source license verified: ${confirmed}/${total}`,
    downloaded,
    notDownloaded: total - downloaded,
    projectId,
  };
}
