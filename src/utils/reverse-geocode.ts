/**
 * Reverse geocoding using Nominatim (OpenStreetMap) - free, no API key
 * Converts lat/lon to country name + ISO code
 */

export interface GeoResult {
  country: string;
  code: string; // ISO 3166-1 alpha-2 (e.g. "IR", "US")
  displayName: string;
}

const cache = new Map<string, GeoResult | null>();
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 1100; // Nominatim: max 1 req/sec

function cacheKey(lat: number, lon: number): string {
  // Round to ~11km grid to avoid duplicate calls for nearby clicks
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeoResult | null> {
  const key = cacheKey(lat, lon);
  if (cache.has(key)) return cache.get(key) ?? null;

  // Throttle
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastRequestTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=3&accept-language=en`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WorldMonitor/2.0 (https://worldmonitor.app)' },
    });
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }

    const data = await res.json();
    const country = data.address?.country;
    const code = data.address?.country_code?.toUpperCase();

    if (!country || !code) {
      cache.set(key, null);
      return null;
    }

    const result: GeoResult = { country, code, displayName: data.display_name || country };
    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn('[reverseGeocode] Failed:', err);
    cache.set(key, null);
    return null;
  }
}
