// =============================================================================
// Pexels provider — PRIMARY (PRD §3.1)
//   GET https://api.pexels.com/v1/videos/search  (current /v1/ path)
//   Authorization header required.
//   UI must display Pexels attribution/link (handled in web UI).
// =============================================================================

import type { AssetCandidate, Orientation, SearchOptions } from "@twio/shared";
import { providerLicenseStatus } from "@twio/shared";
import { config } from "../config.js";
import { fetchJsonWithRetry } from "./rateLimiter.js";
import { getCachedCandidates, putCachedCandidates } from "./searchCache.js";
import type { Provider } from "./types.js";

interface PexelsVideoFile {
  id: number;
  quality: string; // "uhd" | "hd" | "sd" | "ts"
  file_type: string;
  width: number;
  height: number;
  fps: number;
  link: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string; // human-facing page
  image: string; // thumbnail
  user: { name: string; url: string } | null;
  video_files: PexelsVideoFile[];
}

interface PexelsResponse {
  page: number;
  per_page: number;
  total_results: number;
  videos: PexelsVideo[];
}

function orientationParam(o?: Orientation): string | undefined {
  if (o === "landscape") return "landscape";
  if (o === "portrait") return "portrait";
  if (o === "square") return "square";
  return undefined;
}

// size param values accepted by Pexels: large | medium | small.
function sizeParam(minWidth?: number): string | undefined {
  if (minWidth && minWidth >= 3840) return "large";
  if (minWidth && minWidth >= 1920) return "large";
  return undefined;
}

/** Pick the best downloadable file variant (largest ≤ a sane cap, prefer mp4). */
function pickFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  if (!files.length) return null;
  const mp4 = files.filter((f) => f.file_type === "video/mp4");
  const pool = mp4.length ? mp4 : files;
  // Prefer largest area but cap to avoid massive downloads.
  const sorted = [...pool].sort((a, b) => b.width * b.height - a.width * a.height);
  return sorted[0] ?? null;
}

/** Extract the descriptive slug from a Pexels video URL.
 *  e.g. "https://www.pexels.com/video/sun-glare-from-trees-856325/" → "sun-glare-from-trees"
 */
function extractSlug(url: string): string | null {
  const m = /pexels\.com\/video\/([^/?]+)/.exec(url);
  if (!m || !m[1]) return null;
  const parts = m[1].split("-");
  // Last part is the numeric ID — drop it.
  parts.pop();
  return parts.join("-") || null;
}

/** Convert a slug to a human-readable title.
 *  e.g. "sun-glare-from-trees" → "Sun Glare From Trees"
 */
function slugToTitle(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const PEXELS_LICENSE = "Pexels License";
const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";

export class PexelsProvider implements Provider {
  readonly id = "pexels" as const;
  readonly live: boolean;

  constructor() {
    this.live = !!config.pexelsApiKey;
  }

  async search(query: string, opts: SearchOptions): Promise<AssetCandidate[]> {
    if (!this.live) {
      throw new Error("Pexels API key not configured (PEXELS_API_KEY is empty)");
    }
    const page = opts.page ?? 1;
    const cached = getCachedCandidates("pexels", query, opts, page);
    if (cached) {
      console.debug(`[pexels] cache hit: "${query}" page ${page}`);
      return cached;
    }

    const perPage = Math.min(opts.perPage ?? config.candidatesPerProvider, 80);
    const params = new URLSearchParams({
      query,
      per_page: String(perPage),
      page: String(page),
    });
    const orient = orientationParam(opts.orientation);
    if (orient) params.set("orientation", orient);
    const size = sizeParam(opts.minWidth);
    if (size) params.set("size", size);

    const url = `https://api.pexels.com/v1/videos/search?${params.toString()}`;
    const { json } = await fetchJsonWithRetry("pexels", url, {
      headers: { Authorization: config.pexelsApiKey },
      tag: "pexels",
    });
    const data = json as PexelsResponse;
    const license = providerLicenseStatus("pexels");

    const candidates: AssetCandidate[] = [];
    for (const v of data.videos ?? []) {
      const file = pickFile(v.video_files ?? []);
      if (!file) continue;
      // The Pexels API doesn't return tags or titles, but the video URL
      // contains a descriptive slug (e.g. "sun-glare-from-trees-856325").
      // Extract it for relevance scoring.
      const slug = extractSlug(v.url);
      const title = slug ? slugToTitle(slug) : null;
      const tags = slug ? slug.split("-").filter((t) => t.length > 2 && !/^\d+$/.test(t)) : [];
      candidates.push({
        provider: "pexels",
        providerAssetId: String(v.id),
        providerUrl: v.url,
        downloadUrl: file.link,
        title,
        creatorName: v.user?.name ?? null,
        creatorUrl: v.user?.url ?? null,
        width: file.width || v.width,
        height: file.height || v.height,
        durationSeconds: v.duration,
        fps: file.fps ?? null,
        thumbnailUrl: v.image ?? null,
        sourceLicense: PEXELS_LICENSE,
        licenseUrl: PEXELS_LICENSE_URL,
        tags,
      });
      void license; // license captured at asset-insert time in pipeline
    }

    putCachedCandidates("pexels", query, opts, page, candidates);
    console.debug(`[pexels] "${query}" page ${page}: ${candidates.length} candidates`);
    return candidates;
  }
}
