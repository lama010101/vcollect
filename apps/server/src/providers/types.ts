// =============================================================================
// Provider interface — all stock providers implement this (PRD §3)
// =============================================================================

import type { AssetCandidate, ProviderName, SearchOptions } from "@twio/shared";

export interface Provider {
  readonly id: ProviderName;
  /** True if this provider is ready to make live API calls (has key, enabled). */
  readonly live: boolean;
  /** Search for candidates matching a query. Returns normalized candidates. */
  search(query: string, opts: SearchOptions): Promise<AssetCandidate[]>;
}
