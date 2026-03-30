export interface GeocodeResult {
  displayName: string;
  lat: number;
  lon: number;
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const REQUEST_TIMEOUT_MS = 8000;

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 1000;

async function throttledFetch(url: string): Promise<Response> {
  const sleepUntil = lastRequestTime + MIN_INTERVAL_MS;
  lastRequestTime = sleepUntil;
  const wait = sleepUntil - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'en', 'User-Agent': 'WorldMonitor/1.0' },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function forwardGeocode(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(trimmed)}&format=json&limit=5&addressdetails=0`;
  try {
    const res = await throttledFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
    return data
      .filter((item) => item.display_name && item.lat && item.lon)
      .map((item) => ({
        displayName: item.display_name,
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
      }))
      .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  } catch {
    return [];
  }
}

export async function reverseGeocodeLabel(lat: number, lon: number): Promise<string | null> {
  const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=0`;
  try {
    const res = await throttledFetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name ?? null;
  } catch {
    return null;
  }
}
