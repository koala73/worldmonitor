import { getApiBaseUrl } from '@/services/runtime';

export interface S2UndergroundEvent {
  lon: number;
  lat: number;
  layerTitle: string;
  name: string;
  description: string;
  eventType: string;
  date: string;
  popupInfo: string;
}

let _cache: { data: S2UndergroundEvent[]; ts: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function fetchS2Underground(): Promise<S2UndergroundEvent[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.data;

  try {
    const url = `${getApiBaseUrl()}/api/s2-underground`;
    const res = await fetch(url);
    if (!res.ok) return _cache?.data ?? [];
    const json = (await res.json()) as { events?: unknown[]; error?: string };
    if (!json.events) return _cache?.data ?? [];

    const events: S2UndergroundEvent[] = (json.events as Record<string, unknown>[])
      .map((e) => ({
        lon: Number(e['lon'] ?? 0),
        lat: Number(e['lat'] ?? 0),
        layerTitle: String(e['layerTitle'] ?? ''),
        name: String(e['name'] ?? ''),
        description: String(e['description'] ?? ''),
        eventType: String(e['eventType'] ?? ''),
        date: String(e['date'] ?? ''),
        popupInfo: String(e['popupInfo'] ?? ''),
      }))
      .filter((e) => !isNaN(e.lat) && !isNaN(e.lon) && (e.lat !== 0 || e.lon !== 0));

    _cache = { data: events, ts: Date.now() };
    return events;
  } catch {
    return _cache?.data ?? [];
  }
}

export function invalidateS2UndergroundCache(): void {
  _cache = null;
}
