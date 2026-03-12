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
  buildNotamAlert,
  loadNotamClosures,
  mergeNotamWithExistingAlert,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson, setCachedJson } from '../../../_shared/redis';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v3';
const CACHE_TTL = 1800; // 30 minutes

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  const t0 = Date.now();
  // 1. FAA (US) — seed-first with live fallback
  const SEED_FRESHNESS_MS = 20 * 60 * 1000; // 20 minutes
  let faaAlerts: AirportDelayAlert[] = [];
  let faaFromSeed = false;
  try {
    const meta = await getCachedJson('seed-meta:aviation:faa', true) as { fetchedAt?: number } | null;
    const seedAge = meta?.fetchedAt ? t0 - meta.fetchedAt : Infinity;
    const seedData = await getCachedJson(FAA_CACHE_KEY, true) as { alerts: AirportDelayAlert[] } | null;
    if (seedData && Array.isArray(seedData.alerts) && (seedAge < SEED_FRESHNESS_MS || !process.env.SEED_FALLBACK_FAA)) {
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
      faaFromSeed = true;
    }
  } catch {}
  // Live fallback: only reached if seed is missing/stale AND SEED_FALLBACK_FAA is set.
  // Default (no env var): stale seed is still served — no live fetch, no cross-isolate stampede.
  // With env var: cachedFetchJson coalesces within one isolate, but parallel isolates
  // may each fire one FAA request until Redis is populated (~same as pre-seed behavior).
  if (!faaFromSeed) {
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
  } catch (err) {
    console.warn(`[Aviation] FAA fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  }

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
  let allAlerts = [...faaAlerts, ...intlAlerts];
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
  //    so they always appear on the map (gray dots)
  const alertedIatas = new Set(allAlerts.map(a => a.iata));
  let normalCount = 0;
  for (const airport of MONITORED_AIRPORTS) {
    if (!alertedIatas.has(airport.iata)) {
      normalCount++;
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

