import { getApiBaseUrl } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';

export interface AirstrikeEvent {
  id: string;
  date: string;
  country: string;
  region: string;
  location: string;
  lat: number;
  lon: number;
  actor: string;
  targetActor: string;
  eventType: string;
  subEventType: string;
  fatalities: number;
  notes: string;
}

let _cache: { data: AirstrikeEvent[]; ts: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function fetchAirstrikes(): Promise<AirstrikeEvent[]> {
  if (!isFeatureAvailable('acledAirstrikes')) return [];

  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.data;

  try {
    const url = `${getApiBaseUrl()}/api/acled-events`;
    const res = await fetch(url);
    if (!res.ok) return _cache?.data ?? [];
    const json = await res.json() as { events?: unknown[]; error?: string };
    if (!json.events) return _cache?.data ?? [];

    const events: AirstrikeEvent[] = (json.events as Record<string, unknown>[]).map(e => ({
      id: String(e.event_id_cnty ?? ''),
      date: String(e.event_date ?? ''),
      country: String(e.country ?? ''),
      region: String(e.admin1 ?? ''),
      location: String(e.location ?? ''),
      lat: Number.parseFloat(String(e.latitude ?? '0')),
      lon: Number.parseFloat(String(e.longitude ?? '0')),
      actor: String(e.actor1 ?? ''),
      targetActor: String(e.actor2 ?? ''),
      eventType: String(e.event_type ?? ''),
      subEventType: String(e.sub_event_type ?? ''),
      fatalities: Number.parseInt(String(e.fatalities ?? '0'), 10) || 0,
      notes: String(e.notes ?? ''),
    })).filter(e => e.id && !isNaN(e.lat) && !isNaN(e.lon));

    _cache = { data: events, ts: Date.now() };
    return events;
  } catch {
    return _cache?.data ?? [];
  }
}

export function invalidateAirstrikesCache(): void {
  _cache = null;
}
