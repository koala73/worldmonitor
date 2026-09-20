import { toApiUrl } from '@/services/runtime';
import { geocodeCacheCell } from '../../shared/geocode-cache-key.js';

export interface GeoResult {
  country: string;
  code: string;
  displayName: string;
}

const cache = new Map<string, GeoResult | null>();

export function __resetReverseGeocodeCacheForTests(): void {
  cache.clear();
}

const TIMEOUT_MS = 8000;

function shouldMemoizeHttpMiss(status: number): boolean {
  // 408/425/429 and every 5xx are retryable. Caching them in a page-lifetime
  // map turns a transient failure into "no country here" until reload.
  return status !== 408 && status !== 425 && status !== 429 && status < 500;
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<GeoResult | null> {
  const key = geocodeCacheCell(lat, lon);
  if (cache.has(key)) return cache.get(key) ?? null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(toApiUrl(`/api/reverse-geocode?lat=${lat}&lon=${lon}`), {
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) {
      if (shouldMemoizeHttpMiss(res.status)) cache.set(key, null);
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
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
