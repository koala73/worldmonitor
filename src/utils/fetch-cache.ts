/**
 * PERF-017: Shared fetch cache with Stale-While-Revalidate pattern.
 * Centralizes all fetch calls with built-in:
 * - TTL-based caching (returns cached data instantly if within TTL)
 * - Background revalidation (refreshes cache after returning stale data)
 * - Request deduplication (concurrent requests to same URL share one fetch)
 * - AbortController support (PERF-018)
 */

interface CacheEntry<T = unknown> {
    data: T;
    timestamp: number;
    etag?: string;
}

interface FetchWithCacheOptions {
    /** Time-to-live in milliseconds. Cached data within TTL is returned immediately. */
    ttl?: number;
    /** If true, revalidate in background even when cache is fresh. */
    revalidateOnMount?: boolean;
    /** AbortSignal to cancel the request. */
    signal?: AbortSignal;
    /** Custom fetch options (headers, method, etc.) */
    fetchOptions?: RequestInit;
    /** Transform the response before caching. Default: response.json() */
    transform?: (response: Response) => Promise<unknown>;
    /** Cache key override. Default: the URL. */
    cacheKey?: string;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const DEFAULT_TTL = 60_000; // 1 minute

/**
 * Fetch with SWR cache. Returns cached data if available and fresh.
 * Deduplicates concurrent requests to the same URL.
 */
export async function fetchWithCache<T = unknown>(
    url: string,
    options: FetchWithCacheOptions = {},
): Promise<T> {
    const key = options.cacheKey || url;
    const ttl = options.ttl ?? DEFAULT_TTL;
    const now = Date.now();

    // 1. Check cache
    const cached = cache.get(key);
    if (cached && (now - cached.timestamp) < ttl) {
        // Cache hit within TTL — return immediately
        if (options.revalidateOnMount) {
            // Fire-and-forget background revalidation
            void revalidate<T>(url, key, options);
        }
        return cached.data as T;
    }

    // 2. Check if there's already an in-flight request for this URL
    const existing = inflight.get(key);
    if (existing) {
        return existing as Promise<T>;
    }

    // 3. Fetch fresh data
    const fetchPromise = revalidate<T>(url, key, options);
    inflight.set(key, fetchPromise);

    try {
        const data = await fetchPromise;
        return data;
    } finally {
        inflight.delete(key);
    }
}

async function revalidate<T>(
    url: string,
    key: string,
    options: FetchWithCacheOptions,
): Promise<T> {
    const fetchOpts: RequestInit = { ...options.fetchOptions };
    if (options.signal) {
        fetchOpts.signal = options.signal;
    }

    const response = await fetch(url, fetchOpts);
    if (!response.ok) {
        // If we have stale cache, return it on error
        const stale = cache.get(key);
        if (stale) {
            return stale.data as T;
        }
        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    const transform = options.transform || ((r: Response) => r.json());
    const data = await transform(response) as T;

    cache.set(key, {
        data,
        timestamp: Date.now(),
        etag: response.headers.get('etag') || undefined,
    });

    return data;
}

/**
 * PERF-032: Evict cache entries older than maxAge.
 * Call periodically to prevent unbounded memory growth.
 */
export function evictStaleCache(maxAge = 5 * 60_000): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.timestamp > maxAge) {
            cache.delete(key);
        }
    }
}

/**
 * Clear the entire cache.
 */
export function clearCache(): void {
    cache.clear();
}

/**
 * Get cache size for debugging.
 */
export function getCacheSize(): number {
    return cache.size;
}
