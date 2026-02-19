import { createCircuitBreaker, fetchWithCache } from '@/utils';
import type { UcdpGeoEvent } from '@/types';

interface UcdpEventsResponse {
  success: boolean;
  count: number;
  data: UcdpGeoEvent[];
  cached_at: string;
}

const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const RAILWAY_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/ucdp-events'
  : '';
const VERCEL_URL = '/api/ucdp-events';

const breaker = createCircuitBreaker<UcdpEventsResponse>({ name: 'UCDP Events' });

async function fetchFromUrl(url: string): Promise<UcdpEventsResponse> {
  return fetchWithCache<UcdpEventsResponse>(url, {
    ttl: 120_000,
    headers: { Accept: 'application/json' },
  });
}

export async function fetchUcdpEvents(): Promise<UcdpEventsResponse> {
  return breaker.execute(async () => {
    if (RAILWAY_URL) {
      try {
        return await fetchFromUrl(RAILWAY_URL);
      } catch {
        // Railway unavailable or route not deployed yet — fall back to Vercel
      }
    }
    return fetchFromUrl(VERCEL_URL);
  }, { success: false, count: 0, data: [], cached_at: '' });
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface AcledEvent {
  latitude: string | number;
  longitude: string | number;
  event_date: string;
  fatalities: string | number;
}

export function deduplicateAgainstAcled(
  ucdpEvents: UcdpGeoEvent[],
  acledEvents: AcledEvent[],
): UcdpGeoEvent[] {
  if (!acledEvents.length) return ucdpEvents;

  return ucdpEvents.filter(ucdp => {
    const uLat = ucdp.latitude;
    const uLon = ucdp.longitude;
    const uDate = new Date(ucdp.date_start).getTime();
    const uDeaths = ucdp.deaths_best;

    for (const acled of acledEvents) {
      const aLat = Number(acled.latitude);
      const aLon = Number(acled.longitude);
      const aDate = new Date(acled.event_date).getTime();
      const aDeaths = Number(acled.fatalities) || 0;

      const dayDiff = Math.abs(uDate - aDate) / (1000 * 60 * 60 * 24);
      if (dayDiff > 7) continue;

      const dist = haversineKm(uLat, uLon, aLat, aLon);
      if (dist > 50) continue;

      if (uDeaths === 0 && aDeaths === 0) return false;
      if (uDeaths > 0 && aDeaths > 0) {
        const ratio = uDeaths / aDeaths;
        if (ratio >= 0.5 && ratio <= 2.0) return false;
      }
    }
    return true;
  });
}

export function groupByCountry(events: UcdpGeoEvent[]): Map<string, UcdpGeoEvent[]> {
  const map = new Map<string, UcdpGeoEvent[]>();
  for (const e of events) {
    const country = e.country || 'Unknown';
    if (!map.has(country)) map.set(country, []);
    map.get(country)!.push(e);
  }
  return map;
}

export function groupByType(events: UcdpGeoEvent[]): Record<string, UcdpGeoEvent[]> {
  return {
    'state-based': events.filter(e => e.type_of_violence === 'state-based'),
    'non-state': events.filter(e => e.type_of_violence === 'non-state'),
    'one-sided': events.filter(e => e.type_of_violence === 'one-sided'),
  };
}
