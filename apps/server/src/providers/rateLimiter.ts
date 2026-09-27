// =============================================================================
// Rate limiter — per-provider request queue + exponential backoff (PRD §31)
//   - Token-bucket-ish gate: maxRequests per perMs window.
//   - On HTTP 429 / Retry-After: honor it, then exponential backoff.
//   - Never hundreds of concurrent API calls.
// =============================================================================

import { RATE_LIMITS } from "@twio/shared";
import type { ProviderName } from "@twio/shared";

interface Bucket {
  maxRequests: number;
  perMs: number;
  timestamps: number[];
}

const buckets = new Map<ProviderName, Bucket>();

function bucketFor(p: ProviderName): Bucket {
  let b = buckets.get(p);
  if (!b) {
    const limits = RATE_LIMITS as Record<ProviderName, { maxRequests: number; perMs: number }>;
    const r = limits[p];
    b = { maxRequests: r.maxRequests, perMs: r.perMs, timestamps: [] };
    buckets.set(p, b);
  }
  return b;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Block until a request slot is available, then record the timestamp. */
export async function acquire(p: ProviderName): Promise<void> {
  const b = bucketFor(p);
  if (!Number.isFinite(b.maxRequests)) return; // unlimited budget
  while (true) {
    const now = Date.now();
    b.timestamps = b.timestamps.filter((t) => now - t < b.perMs);
    if (b.timestamps.length < b.maxRequests) {
      b.timestamps.push(now);
      return;
    }
    // Wait until the oldest timestamp leaves the window.
    const wait = b.perMs - (now - b.timestamps[0]!);
    await sleep(Math.max(wait, 10));
  }
}

/** Exponential backoff sleep after a failure. attempt is 1-based. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  const base = 500;
  const cap = 60_000;
  return Math.min(cap, base * 2 ** (attempt - 1));
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  /** Max attempts including the first. */
  maxAttempts?: number;
  /** Tag for logs. */
  tag?: string;
}

/**
 * Fetch JSON with rate limiting + retry/backoff. Throws on non-2xx after
 * exhausting attempts. Returns { status, json }.
 */
export async function fetchJsonWithRetry(
  provider: ProviderName,
  url: string,
  opts: FetchJsonOptions = {},
): Promise<{ status: number; json: unknown }> {
  const maxAttempts = opts.maxAttempts ?? 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await acquire(provider);
    try {
      const res = await fetch(url, { headers: opts.headers });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        const wait = backoffMs(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
        if (opts.tag) console.warn(`[${opts.tag}] HTTP ${res.status} — backoff ${wait}ms (attempt ${attempt})`);
        if (attempt === maxAttempts) {
          throw new Error(`HTTP ${res.status} after ${maxAttempts} attempts: ${url}`);
        }
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${url}`);
      }
      const json = await res.json();
      return { status: res.status, json };
    } catch (err) {
      lastErr = err;
      // Network error → backoff and retry.
      if (attempt < maxAttempts) {
        const wait = backoffMs(attempt);
        if (opts.tag) console.warn(`[${opts.tag}] fetch error — backoff ${wait}ms (attempt ${attempt}): ${(err as Error).message}`);
        await sleep(wait);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetch failed: ${url}`);
}
