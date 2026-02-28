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
  fetchNotamClosures,
  buildNotamAlert,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson, setCachedJson } from '../../../_shared/redis';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v1';
const INTL_LOCK_KEY = 'aviation:delays:intl:lock';
const NOTAM_CACHE_KEY = 'aviation:notam:closures:v1';
const CACHE_TTL = 1800;   // 30 min for FAA, intl, and NOTAM
const LOCK_TTL = 30;      // 30s lock — enough for AviationStack batch (~8-10s)

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  const t0 = Date.now();
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
    console.log(`[Aviation] FAA: ${faaAlerts.length} alerts`);
  } catch (err) {
    console.warn(`[Aviation] FAA fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 2. International — with cross-isolate stampede protection
  let intlAlerts: AirportDelayAlert[] = [];
  try {
    intlAlerts = await fetchIntlWithLock();
    console.log(`[Aviation] Intl: ${intlAlerts.length} alerts`);
  } catch (err) {
    console.warn(`[Aviation] Intl fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 3. NOTAM closures (ICAO API) — overlay on existing alerts
  let allAlerts = [...faaAlerts, ...intlAlerts];
  if (process.env.ICAO_API_KEY) {
    try {
      const notamResult = await cachedFetchJson<{ closedIcaos: string[]; reasons: Record<string, string> }>(
        NOTAM_CACHE_KEY, CACHE_TTL, async () => {
          const mena = MONITORED_AIRPORTS.filter(a => a.region === 'mena');
          const result = await fetchNotamClosures(mena);
          const closedIcaos = [...result.closedIcaoCodes];
          const reasons: Record<string, string> = {};
          for (const [icao, reason] of result.notamsByIcao) reasons[icao] = reason;
          return { closedIcaos, reasons };
        }
      );
      if (notamResult && notamResult.closedIcaos.length > 0) {
        const existingIatas = new Set(allAlerts.map(a => a.iata));
        for (const icao of notamResult.closedIcaos) {
          const airport = MONITORED_AIRPORTS.find(a => a.icao === icao);
          if (!airport) continue;
          const reason = notamResult.reasons[icao] || 'Airport closure (NOTAM)';
          if (existingIatas.has(airport.iata)) {
            const idx = allAlerts.findIndex(a => a.iata === airport.iata);
            if (idx >= 0) {
              allAlerts[idx] = buildNotamAlert(airport, reason);
            }
          } else {
            allAlerts.push(buildNotamAlert(airport, reason));
          }
        }
        console.log(`[Aviation] NOTAM: ${notamResult.closedIcaos.length} closures applied`);
      }
    } catch (err) {
      console.warn(`[Aviation] NOTAM fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  console.log(`[Aviation] Total: ${allAlerts.length} alerts in ${Date.now() - t0}ms`);
  return { alerts: allAlerts };
}

async function fetchIntlWithLock(): Promise<AirportDelayAlert[]> {
  const cached = await getCachedJson(INTL_CACHE_KEY);
  if (cached && typeof cached === 'object' && 'alerts' in (cached as Record<string, unknown>)) {
    const alerts = (cached as { alerts: AirportDelayAlert[] }).alerts;
    console.log(`[Aviation] Intl cache HIT: ${alerts.length} alerts`);
    return alerts;
  }

  console.log('[Aviation] Intl cache MISS — acquiring lock');
  const gotLock = await tryAcquireLock(INTL_LOCK_KEY, LOCK_TTL);

  if (!gotLock) {
    console.log('[Aviation] Lock held by another isolate — waiting 3s');
    await new Promise(r => setTimeout(r, 3_000));
    const retry = await getCachedJson(INTL_CACHE_KEY);
    if (retry && typeof retry === 'object' && 'alerts' in (retry as Record<string, unknown>)) {
      const alerts = (retry as { alerts: AirportDelayAlert[] }).alerts;
      console.log(`[Aviation] Intl cache HIT after wait: ${alerts.length} alerts`);
      return alerts;
    }
    console.log('[Aviation] Still no cache after wait — falling back to simulation');
    const nonUs = MONITORED_AIRPORTS.filter(a => a.country !== 'USA');
    return nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
  }

  console.log('[Aviation] Lock acquired — fetching AviationStack');
  try {
    const nonUs = MONITORED_AIRPORTS.filter(a => a.country !== 'USA');
    const apiKey = process.env.AVIATIONSTACK_API;

    let alerts: AirportDelayAlert[];
    if (!apiKey) {
      console.log('[Aviation] No API key — using simulation');
      alerts = nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
    } else {
      const avResult = await fetchAviationStackDelays(nonUs);
      if (!avResult.healthy) {
        console.warn('[Aviation] AviationStack unhealthy — falling back to simulation');
        alerts = nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
      } else {
        alerts = avResult.alerts;
      }
    }

    await setCachedJson(INTL_CACHE_KEY, { alerts }, CACHE_TTL);
    return alerts;
  } catch (err) {
    console.warn(`[Aviation] Intl fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
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
