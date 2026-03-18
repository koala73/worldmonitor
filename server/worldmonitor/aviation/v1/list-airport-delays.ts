import type {
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import {
  MONITORED_AIRPORTS,
} from '../../../../src/config/airports';
import {
  toProtoDelayType,
  toProtoSeverity,
  toProtoRegion,
  toProtoSource,
  buildNotamAlert,
  loadNotamClosures,
  mergeNotamWithExistingAlert,
} from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v3';

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  // 1. FAA (US) — seed-only read
  let faaAlerts: AirportDelayAlert[] = [];
  try {
    const seedData = await getCachedJson(FAA_CACHE_KEY, true) as { alerts: AirportDelayAlert[] } | null;
    if (seedData && Array.isArray(seedData.alerts)) {
      faaAlerts = seedData.alerts
        .map(a => {
          const airport = MONITORED_AIRPORTS.find(ap => ap.iata === a.iata);
          if (!airport) return null;
          if (!a.icao || a.icao === '') {
            return { ...a, icao: airport.icao, name: airport.name, city: airport.city, country: airport.country, location: { latitude: airport.lat, longitude: airport.lon }, region: toProtoRegion(airport.region) };
          }
          return a;
        })
        .filter((a): a is AirportDelayAlert => a !== null);
    }
  } catch {}

  // 2. International — read-only from Redis (Railway relay seeds the cache)
  let intlAlerts: AirportDelayAlert[] = [];
  try {
    const cached = await getCachedJson(INTL_CACHE_KEY) as { alerts: AirportDelayAlert[] } | null;
    if (cached?.alerts) {
      intlAlerts = cached.alerts;
    }
  } catch (err) {
    console.warn(`[Aviation] Intl fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 3. NOTAM alerts — shared loader (seed-first with live fallback)
  const allAlerts = [...faaAlerts, ...intlAlerts];
  const notamResult = await loadNotamClosures();
  if (notamResult) {
    const existingIatas = new Set(allAlerts.map(a => a.iata));
    const applyNotam = (icao: string, severity: 'severe' | 'major', delayType: 'closure' | 'general', fallback: string) => {
      const airport = MONITORED_AIRPORTS.find(a => a.icao === icao);
      if (!airport) return;
      const reason = notamResult.reasons[icao] || fallback;
      if (existingIatas.has(airport.iata)) {
        const idx = allAlerts.findIndex(a => a.iata === airport.iata);
        if (idx >= 0) {
          allAlerts[idx] = mergeNotamWithExistingAlert(airport, reason, allAlerts[idx] ?? null, severity, delayType);
        }
      } else {
        allAlerts.push(buildNotamAlert(airport, reason, severity, delayType));
        existingIatas.add(airport.iata);
      }
    };
    for (const icao of notamResult.closedIcaos ?? []) {
      applyNotam(icao, 'severe', 'closure', 'Airport closure (NOTAM)');
    }
    for (const icao of notamResult.restrictedIcaos ?? []) {
      applyNotam(icao, 'major', 'general', 'Airspace restriction (NOTAM)');
    }
    const total = (notamResult.closedIcaos?.length ?? 0) + (notamResult.restrictedIcaos?.length ?? 0);
    if (total > 0) {
      console.warn(`[Aviation] NOTAM: ${notamResult.closedIcaos?.length ?? 0} closures, ${notamResult.restrictedIcaos?.length ?? 0} restrictions applied`);
    }
  }

  // 4. Fill in ALL monitored airports with no alerts as "normal operations"
  const alertedIatas = new Set(allAlerts.map(a => a.iata));
  for (const airport of MONITORED_AIRPORTS) {
    if (!alertedIatas.has(airport.iata)) {
      allAlerts.push({
        id: `status-${airport.iata}`,
        iata: airport.iata,
        icao: airport.icao,
        name: airport.name,
        city: airport.city,
        country: airport.country,
        location: { latitude: airport.lat, longitude: airport.lon },
        region: toProtoRegion(airport.region),
        delayType: toProtoDelayType('general'),
        severity: toProtoSeverity('normal'),
        avgDelayMinutes: 0,
        delayedFlightsPct: 0,
        cancelledFlights: 0,
        totalFlights: 0,
        reason: 'Normal operations',
        source: toProtoSource('computed'),
        updatedAt: Date.now(),
      });
    }
  }

  // Write bootstrap key for initial page load hydration
  try {
    await setCachedJson('aviation:delays-bootstrap:v1', { alerts: allAlerts }, 1800);
  } catch { /* non-critical */ }

  return { alerts: allAlerts };
}
