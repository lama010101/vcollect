// =============================================================================
// Provider factory — resolves live providers.
// Real API keys are REQUIRED. No mock fallback — if a key is missing the
// system errors immediately with a clear message.
// =============================================================================

import { config } from "../config.js";
import { PexelsProvider } from "./pexels.js";
import { PixabayProvider } from "./pixabay.js";
import type { Provider } from "./types.js";

export interface ResolvedProviders {
  pexels: Provider;
  pixabay: Provider;
}

export function resolveProviders(): ResolvedProviders {
  const pexels = new PexelsProvider();
  const pixabay = new PixabayProvider();

  if (!pexels.live) {
    throw new Error(
      "PEXELS_API_KEY is missing. Set it in .env.local — no mock fallback is available.",
    );
  }
  if (!pixabay.live) {
    throw new Error(
      "PIXABAY_API_KEY is missing. Set it in .env.local — no mock fallback is available.",
    );
  }

  void config;
  return { pexels, pixabay };
}
