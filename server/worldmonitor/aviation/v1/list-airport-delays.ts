import type {
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import {
  MONITORED_AIRPORTS,
  FAA_AIRPORTS,
} from '../../../../src/config/airports';
import {
  FAA_URL,
  parseFaaXml,
  toProtoDelayType,
  toProtoSeverity,
  toProtoRegion,
  toProtoSource,
  determineSeverity,
  generateSimulatedDelay,
  fetchAviationStackDelays,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson, setCachedJson } from '../../../_shared/redis';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v1';
const INTL_LOCK_KEY = 'aviation:delays:intl:lock';
const CACHE_TTL = 1800;   // 30 min for both FAA and intl
const LOCK_TTL = 30;      // 30s lock — enough for AviationStack batch (~8-10s)

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  // 1. FAA (US) — independent try-catch
  let faaAlerts: AirportDelayAlert[] = [];
  try {
    const result = await cachedFetchJson<{ alerts: AirportDelayAlert[] }>(
      FAA_CACHE_KEY, CACHE_TTL, async () => {
        const alerts: AirportDelayAlert[] = [];
        const faaResponse = await fetch(FAA_URL, {
          headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(15_000),
        });

        let faaDelays = new Map<string, { airport: string; reason: string; avgDelay: number; type: string }>();
        if (faaResponse.ok) {
          const xml = await faaResponse.text();
          faaDelays = parseFaaXml(xml);
        }

        for (const iata of FAA_AIRPORTS) {
          const airport = MONITORED_AIRPORTS.find((a) => a.iata === iata);
          if (!airport) continue;
          const faaDelay = faaDelays.get(iata);
          if (faaDelay) {
            alerts.push({
              id: `faa-${iata}`,
              iata,
              icao: airport.icao,
              name: airport.name,
              city: airport.city,
              country: airport.country,
              location: { latitude: airport.lat, longitude: airport.lon },
              region: toProtoRegion(airport.region),
              delayType: toProtoDelayType(faaDelay.type),
              severity: toProtoSeverity(determineSeverity(faaDelay.avgDelay)),
              avgDelayMinutes: faaDelay.avgDelay,
              delayedFlightsPct: 0,
              cancelledFlights: 0,
              totalFlights: 0,
              reason: faaDelay.reason,
              source: toProtoSource('faa'),
              updatedAt: Date.now(),
            });
          }
        }

        return { alerts };
      }
    );
    faaAlerts = result?.alerts ?? [];
  } catch { /* FAA down doesn't blank intl */ }

  // 2. International — with cross-isolate stampede protection
  let intlAlerts: AirportDelayAlert[] = [];
  try {
    intlAlerts = await fetchIntlWithLock();
  } catch { /* AviationStack + simulation both failed → empty intl */ }

  return { alerts: [...faaAlerts, ...intlAlerts] };
}

async function fetchIntlWithLock(): Promise<AirportDelayAlert[]> {
  // Fast path: cache hit
  const cached = await getCachedJson(INTL_CACHE_KEY);
  if (cached && typeof cached === 'object' && 'alerts' in (cached as Record<string, unknown>)) {
    return (cached as { alerts: AirportDelayAlert[] }).alerts;
  }

  // Cache miss — try to acquire Redis lock (SETNX)
  const gotLock = await tryAcquireLock(INTL_LOCK_KEY, LOCK_TTL);

  if (!gotLock) {
    // Another isolate is refreshing — wait briefly, then check cache again
    await new Promise(r => setTimeout(r, 3_000));
    const retry = await getCachedJson(INTL_CACHE_KEY);
    if (retry && typeof retry === 'object' && 'alerts' in (retry as Record<string, unknown>)) {
      return (retry as { alerts: AirportDelayAlert[] }).alerts;
    }
    // Still nothing after 3s — fall back to simulation (don't pile on AviationStack)
    const nonUs = MONITORED_AIRPORTS.filter(a => a.country !== 'USA');
    return nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
  }

  // We won the lock — do the actual fetch
  try {
    const nonUs = MONITORED_AIRPORTS.filter(a => a.country !== 'USA');
    const apiKey = process.env.AVIATIONSTACK_API;

    let alerts: AirportDelayAlert[];
    if (!apiKey) {
      alerts = nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
    } else {
      const avResult = await fetchAviationStackDelays(nonUs);
      if (!avResult.healthy) {
        alerts = nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
      } else {
        alerts = avResult.alerts;
      }
    }

    // Write to cache — all other isolates will pick this up
    await setCachedJson(INTL_CACHE_KEY, { alerts }, CACHE_TTL);
    return alerts;
  } catch {
    // Fetch failed — still write empty so other isolates don't also try
    await setCachedJson(INTL_CACHE_KEY, { alerts: [] }, 120);
    return [];
  }
}

async function tryAcquireLock(lockKey: string, ttlSeconds: number): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return true; // No Redis → just proceed (single instance)

  try {
    const resp = await fetch(
      `${url}/set/${encodeURIComponent(lockKey)}/1/EX/${ttlSeconds}/NX`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      }
    );
    if (!resp.ok) return true; // Redis error → proceed rather than block
    const data = await resp.json() as { result?: string | null };
    return data.result === 'OK'; // NX returns OK if set, null if already exists
  } catch {
    return true; // Network error → proceed
  }
}
