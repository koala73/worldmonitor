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
      cache.set(key, null);
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
