import { toApiUrl } from '@/services/runtime';

export interface GeoResult {
  country: string;
  code: string;
  displayName: string;
}

const cache = new Map<string, GeoResult | null>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

const TIMEOUT_MS = 8000;

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<GeoResult | null> {
  const key = cacheKey(lat, lon);
  if (cache.has(key)) return cache.get(key) ?? null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(toApiUrl(`/api/reverse-geocode?lat=${lat}&lon=${lon}`), {
      signal: controller.signal,
    });
    if (!res.ok) {
      // Never memoize a retryable status. `cache` has no TTL and is consulted
      // before every fetch, so caching a 429 (the route is rate-limited since
      // #6234) or a 503 would mark this 0.1-degree cell "no country here" for
      // the rest of the page session — a transient throttle turned permanent.
      // Genuine negative results still cache exactly as before. (#6412 review)
      if (res.status !== 429 && res.status !== 503) cache.set(key, null);
      return null;
    }

    const data = await res.json();
    if (!data.country || !data.code) {
      cache.set(key, null);
      return null;
    }

    const result: GeoResult = { country: data.country, code: data.code, displayName: data.displayName || data.country };
    cache.set(key, result);
    return result;
  } catch {
    if (!controller.signal.aborted) {
      cache.set(key, null);
    }
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
