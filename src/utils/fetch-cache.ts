/**
 * Cached fetch utility with AbortSignal support.
 *
 * Wraps the native fetch() with:
 * - Optional AbortSignal forwarding so callers can cancel in-flight requests
 * - Simple in-memory response cache keyed by URL (GET only)
 * - Deduplication of concurrent requests to the same URL
 */

export interface FetchWithCacheOptions {
  /** AbortSignal to cancel the request (e.g. from a panel's AbortController) */
  signal?: AbortSignal;
  /** Cache TTL in milliseconds. 0 disables caching. Default: 0 (no cache) */
  cacheTtlMs?: number;
  /** Extra fetch init options (method, headers, body, etc.) */
  init?: RequestInit;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/** In-memory cache keyed by URL */
const responseCache = new Map<string, CacheEntry<unknown>>();

/** In-flight request deduplication map */
const inflightRequests = new Map<string, Promise<Response>>();

/**
 * Fetch with optional caching and AbortSignal support.
 *
 * @param url - The URL to fetch
 * @param options - Cache TTL, AbortSignal, and extra fetch init options
 * @returns The parsed JSON response
 */
export async function fetchWithCache<T = unknown>(
  url: string,
  options: FetchWithCacheOptions = {},
): Promise<T> {
  const { signal, cacheTtlMs = 0, init } = options;

  // Check cache first (only for GET requests with caching enabled)
  const isGet = !init?.method || init.method.toUpperCase() === 'GET';
  if (isGet && cacheTtlMs > 0) {
    const cached = responseCache.get(url) as CacheEntry<T> | undefined;
    if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
      return cached.data;
    }
  }

  // Check for already in-flight request to same URL (deduplication for GET)
  if (isGet && inflightRequests.has(url)) {
    const inflight = inflightRequests.get(url)!;
    // If signal provided, race the inflight request against the abort
    const response = signal
      ? await raceAbort(inflight.then(r => r.clone()), signal)
      : await inflight.then(r => r.clone());
    return response.json() as Promise<T>;
  }

  // Build fetch init with signal
  const fetchInit: RequestInit = { ...init };
  if (signal) {
    fetchInit.signal = signal;
  }

  // Create the fetch promise
  const fetchPromise = fetch(url, fetchInit);

  // Register for deduplication (GET only)
  if (isGet) {
    inflightRequests.set(url, fetchPromise);
  }

  try {
    const response = await fetchPromise;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as T;

    // Store in cache if caching enabled
    if (isGet && cacheTtlMs > 0) {
      responseCache.set(url, { data, timestamp: Date.now() });
    }

    return data;
  } finally {
    // Clean up inflight tracking
    if (isGet) {
      inflightRequests.delete(url);
    }
  }
}

/**
 * Race a promise against an AbortSignal.
 * Rejects with AbortError if the signal fires before the promise resolves.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Clear the in-memory response cache (useful for testing or forced refresh).
 */
export function clearFetchCache(): void {
  responseCache.clear();
}

/**
 * Check whether an error is an AbortError (request was cancelled).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
