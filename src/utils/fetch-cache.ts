/**
 * Shared Fetch Cache with SWR (Stale-While-Revalidate)
 *
 * Provides three key performance optimizations:
 *   1. TTL-based caching — returns cached data immediately when fresh.
 *   2. Background SWR revalidation — serves stale data while refreshing.
 *   3. Concurrent-request deduplication — collapses simultaneous fetches to one.
 *
 * Usage:
 *   const data = await fetchWithCache<MyType>(url, { ttl: 60_000 });
 */

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

export interface FetchCacheOptions {
  /** Fresh data TTL in milliseconds. Default: 60 000 (1 minute). */
  ttl?: number;
  /** Maximum age (ms) for stale data served during background revalidation. Default: 5 × ttl. */
  staleTtl?: number;
  /** HTTP headers forwarded to fetch(). */
  headers?: HeadersInit;
  /** AbortSignal — only applied to blocking fetches, not background revalidation. */
  signal?: AbortSignal;
  /** Response parse mode. Default: 'json'. */
  parseAs?: 'json' | 'text';
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_FACTOR = 5;
const MAX_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

let hits = 0;
let misses = 0;

// ── Helpers ──────────────────────────────────────────────────────────

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  // Evict oldest entries until within limit
  const sorted = Array.from(cache.entries()).sort(
    (a, b) => a[1].timestamp - b[1].timestamp,
  );
  const excess = cache.size - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) {
    const entry = sorted[i];
    if (entry) cache.delete(entry[0]);
  }
}

async function executeFetch(
  url: string,
  headers?: HeadersInit,
  signal?: AbortSignal,
  parseAs?: 'json' | 'text',
): Promise<unknown> {
  const init: RequestInit = {};
  if (headers) init.headers = headers;
  if (signal) init.signal = signal;

  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = parseAs === 'text' ? await response.text() : await response.json();
  cache.set(url, { data, timestamp: Date.now() });
  evictIfNeeded();
  return data;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Fetch with transparent caching, SWR revalidation, and request dedup.
 *
 * - **Fresh** (age ≤ ttl): returns cached data, no network request.
 * - **Stale** (ttl < age ≤ staleTtl): returns cached data instantly, triggers
 *   a background revalidation so the next caller gets fresh data.
 * - **Expired / miss** (age > staleTtl or no cache): performs a blocking fetch.
 *   Concurrent requests to the same URL share one in-flight request.
 */
export async function fetchWithCache<T = unknown>(
  url: string,
  options?: FetchCacheOptions,
): Promise<T> {
  const ttl = options?.ttl ?? DEFAULT_TTL_MS;
  const staleTtl = options?.staleTtl ?? ttl * DEFAULT_STALE_FACTOR;
  const now = Date.now();
  const entry = cache.get(url);

  // ① Fresh data — return immediately
  if (entry && now - entry.timestamp <= ttl) {
    hits++;
    return entry.data as T;
  }

  // ② Stale but within revalidation window — serve stale, revalidate in background
  if (entry && now - entry.timestamp <= staleTtl) {
    hits++;
    if (!inflight.has(url)) {
      const bgPromise = executeFetch(url, options?.headers, undefined, options?.parseAs);
      inflight.set(url, bgPromise);
      bgPromise.catch(() => {}).finally(() => inflight.delete(url));
    }
    return entry.data as T;
  }

  // ③ No usable cache — blocking fetch with deduplication
  misses++;

  const existing = inflight.get(url);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = executeFetch(url, options?.headers, options?.signal, options?.parseAs);
  inflight.set(url, promise);

  try {
    return (await promise) as T;
  } finally {
    inflight.delete(url);
  }
}

/** Remove all cached entries and reset hit/miss counters. */
export function clearFetchCache(): void {
  cache.clear();
  inflight.clear();
  hits = 0;
  misses = 0;
}

/** Invalidate a single URL from the cache. */
export function invalidateFetchCache(url: string): void {
  cache.delete(url);
}

/** Snapshot of cache statistics for debugging / telemetry. */
export function getFetchCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  inflightCount: number;
} {
  return { size: cache.size, hits, misses, inflightCount: inflight.size };
}
