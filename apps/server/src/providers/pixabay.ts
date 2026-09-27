// =============================================================================
// Pixabay provider — SECONDARY (PRD §3.2)
//   GET https://pixabay.com/api/videos/
//   Requires `key`. Supports q, video_type, category, min_width, min_height,
//   page, per_page. Docs: default 100 req / 60s (rate-limited in rateLimiter.ts).
//   UI must provide source attribution/linking (handled in web UI).
// =============================================================================

import type { AssetCandidate, SearchOptions } from "@twio/shared";
import { providerLicenseStatus } from "@twio/shared";
import { config } from "../config.js";
import { fetchJsonWithRetry } from "./rateLimiter.js";
import { getCachedCandidates, putCachedCandidates } from "./searchCache.js";
import type { Provider } from "./types.js";

interface PixabayVideoHit {
  id: number;
  pageURL: string;
  type: string; // "film" | "animation"
  tags: string;
  duration: number; // seconds
  videos: {
    large?: PixabayVideoVariant;
    medium: PixabayVideoVariant;
    small: PixabayVideoVariant;
    tiny?: PixabayVideoVariant;
  };
  user: string; // creator name
  user_id: number;
  views: number;
  downloads: number;
  favorites: number;
  likes: number;
  comments: number;
}

interface PixabayVideoVariant {
  url: string;
  width: number;
  height: number;
  size: number; // bytes
  thumbnail: string;
}

interface PixabayResponse {
  total: number;
  totalHits: number;
  hits: PixabayVideoHit[];
}

/** Pick the largest variant meeting min dims; fall back to the largest overall. */
function pickVariant(
  v: PixabayVideoHit["videos"],
  minWidth?: number,
  minHeight?: number,
): { variant: PixabayVideoVariant; width: number; height: number } | null {
  const all = ["tiny", "small", "medium", "large"]
    .map((k) => (v as Record<string, PixabayVideoVariant | undefined>)[k])
    .filter((x): x is PixabayVideoVariant => !!x);
  if (!all.length) return null;
  const mw = minWidth ?? 0;
  const mh = minHeight ?? 0;
  const meeting = all.filter((x) => x.width >= mw && x.height >= mh);
  const pool = meeting.length ? meeting : all; // relax if none meet min
  const best = [...pool].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
  return { variant: best, width: best.width, height: best.height };
}

function thumbnailUrl(hit: PixabayVideoHit): string | null {
  // Pixabay provides a thumbnail per variant; medium is the most reliable.
  return hit.videos.medium?.thumbnail
    ?? hit.videos.small?.thumbnail
    ?? hit.videos.large?.thumbnail
    ?? hit.videos.tiny?.thumbnail
    ?? null;
}

const PIXABAY_LICENSE = "Pixabay Content License";
const PIXABAY_LICENSE_URL = "https://pixabay.com/service/terms/";

export class PixabayProvider implements Provider {
  readonly id = "pixabay" as const;
  readonly live: boolean;

  constructor() {
    this.live = !!config.pixabayApiKey;
  }

  async search(query: string, opts: SearchOptions): Promise<AssetCandidate[]> {
    if (!this.live) {
      throw new Error("Pixabay API key not configured (PIXABAY_API_KEY is empty)");
    }
    const page = opts.page ?? 1;
    const cached = getCachedCandidates("pixabay", query, opts, page);
    if (cached) {
      console.debug(`[pixabay] cache hit: "${query}" page ${page}`);
      return cached;
    }

    const perPage = Math.min(opts.perPage ?? config.candidatesPerProvider, 100);
    const params = new URLSearchParams({
      key: config.pixabayApiKey,
      q: query,
      page: String(page),
      per_page: String(perPage),
      video_type: "film", // real footage, not animation
    });
    if (opts.minWidth) params.set("min_width", String(opts.minWidth));
    if (opts.minHeight) params.set("min_height", String(opts.minHeight));

    const url = `https://pixabay.com/api/videos/?${params.toString()}`;
    const { json } = await fetchJsonWithRetry("pixabay", url, { tag: "pixabay" });
    const data = json as PixabayResponse;
    const license = providerLicenseStatus("pixabay");
    void license;

    const candidates: AssetCandidate[] = [];
    for (const hit of data.hits ?? []) {
      const picked = pickVariant(hit.videos, opts.minWidth, opts.minHeight);
      if (!picked) continue;
      candidates.push({
        provider: "pixabay",
        providerAssetId: String(hit.id),
        providerUrl: hit.pageURL,
        downloadUrl: picked.variant.url,
        title: hit.tags,
        creatorName: hit.user,
        creatorUrl: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`,
        width: picked.width,
        height: picked.height,
        durationSeconds: hit.duration,
        fps: null, // Pixabay doesn't expose fps in the API response
        thumbnailUrl: thumbnailUrl(hit),
        sourceLicense: PIXABAY_LICENSE,
        licenseUrl: PIXABAY_LICENSE_URL,
        tags: hit.tags ? hit.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      });
    }

    putCachedCandidates("pixabay", query, opts, page, candidates);
    console.debug(`[pixabay] "${query}" page ${page}: ${candidates.length} candidates`);
    return candidates;
  }
}
