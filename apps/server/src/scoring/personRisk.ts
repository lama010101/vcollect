// =============================================================================
// Person-risk screening — P1 conservative heuristic (PRD §14)
//
// WITHOUT a vision model we cannot detect faces. This heuristic flags assets
// whose query/tags imply people so they route to RIGHTS_REVIEW_REQUIRED for a
// human to confirm model-release / third-party-rights status.
//
// IMPORTANT: this is a screening aid, NOT a legal determination. It never
// claims a model release exists. (PRD §14)
// =============================================================================

import type { RiskLevel } from "@twio/shared";

const PEOPLE_TOKENS = [
  "child",
  "children",
  "kid",
  "kids",
  "person",
  "people",
  "family",
  "families",
  "adult",
  "adults",
  "elderly",
  "senior",
  "stranger",
  "strangers",
  "friends",
  "friend",
  "crowd",
  "group",
  "man",
  "woman",
  "boy",
  "girl",
  "baby",
  "parent",
  "parents",
  "human",
  "face",
  "smile",
  "smiling",
  "laughing",
  "dancing",
  "running",
  "walking",
  "celebration",
  "community",
];

export interface PersonRiskResult {
  personRisk: RiskLevel;
  reason: string | null;
}

/** Conservative screening: if query/tags imply people, route to REVIEW. */
export function screenPersonRisk(query: string, tags: string[]): PersonRiskResult {
  const hay = (query + " " + tags.join(" ")).toLowerCase();
  for (const tok of PEOPLE_TOKENS) {
    if (hay.includes(tok)) {
      return {
        personRisk: "REVIEW",
        reason: `people_token_present:"${tok}" — human must confirm rights/model release`,
      };
    }
  }
  return { personRisk: "LOW", reason: null };
}
