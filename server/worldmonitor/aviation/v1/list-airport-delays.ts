import type {
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import {
  MONITORED_AIRPORTS,
  FAA_AIRPORTS,
  AVIATIONSTACK_AIRPORTS,
} from '../../../../src/config/airports';
import {
  toProtoDelayType,
  toProtoSeverity,
  toProtoRegion,
  toProtoSource,
  buildNotamAlert,
  loadNotamClosures,
  mergeNotamWithExistingAlert,
  isValidAirportDelayAlert,
  isValidIntlCoverage,
} from './_shared';
import { readCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v3';

const FAA_AIRPORT_SET = new Set(FAA_AIRPORTS);
const INTL_AIRPORT_SET = new Set(AVIATIONSTACK_AIRPORTS);

const ALLOWED_QUERY_PARAMS = new Set(['page_size', 'cursor', 'region', 'min_severity', 'jmespath', '_debug', 'rpc']);

export async function listAirportDelays(
  ctx: ServerContext,
  req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  const seenParams = new Set<string>();
  for (const [key, value] of new URL(ctx.request.url).searchParams) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) throw new ApiError(400, `Unsupported airport delay parameter: ${key}`, '');
    if (seenParams.has(key)) throw new ApiError(400, `Duplicate airport delay parameter: ${key}`, '');
    seenParams.add(key);
    if (key === 'page_size' && value !== '0') throw new ApiError(400, 'Airport delay page_size must be 0', '');
    if (key === 'rpc' && value !== 'list-airport-delays') throw new ApiError(400, 'Invalid airport delay route', '');
  }
  if ((req.pageSize ?? 0) !== 0 || req.cursor
    || (req.region && req.region !== 'AIRPORT_REGION_UNSPECIFIED')
    || (req.minSeverity && req.minSeverity !== 'FLIGHT_DELAY_SEVERITY_UNSPECIFIED')) {
    throw new ApiError(400, 'Airport delay filters are not supported', '');
  }
  // 1. FAA (US) — seed-only read
  // faaSourceCovered = the seed cache hit AND returned a valid alerts array.
  // A miss/parse-error means we have no telemetry for any FAA airport this
  // tick — we MUST NOT publish synthetic "normal" rows for them. See #3707.
  // PERF: the three inputs below are independent (different Redis keys / an
  // independent fetcher) and merge only afterwards — start them concurrently
  // instead of paying three serial round-trips per request.
  const faaRead = (async (): Promise<{ faaAlerts: AirportDelayAlert[]; faaSourceCovered: boolean; available: boolean }> => {
    let faaAlerts: AirportDelayAlert[] = [];
    let faaSourceCovered = false;
    try {
      const seed = await readCachedJson(FAA_CACHE_KEY, true);
      const seedData = seed.status === 'hit' ? seed.value as { alerts?: unknown[] } | null : null;
      if (seedData && Array.isArray(seedData.alerts) && seedData.alerts.every(isValidAirportDelayAlert)) {
        faaSourceCovered = true;
        faaAlerts = seedData.alerts!
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
    } catch (err) {
      console.warn(`[Aviation] FAA seed read failed: ${err instanceof Error ? err.message : 'unknown'}`);
      void captureSilentError(err, { tags: { route: 'aviation/list-airport-delays', step: 'faa-seed-read' } });
      faaSourceCovered = false;
      faaAlerts = [];
    }
    return { faaAlerts, faaSourceCovered, available: faaSourceCovered };
  })();

  // 2. International — read-only from Redis (Railway relay seeds the cache)
  // A cache hit alone does not prove every configured hub was covered. The
  // seeder records each hub as normal/disruption/omitted/failed so an omitted
  // hub remains UNKNOWN instead of being synthesized as normal.
  const intlRead = (async (): Promise<{ intlAlerts: AirportDelayAlert[]; intlCoveredIatas: Set<string>; available: boolean }> => {
    let intlAlerts: AirportDelayAlert[] = [];
    let intlCoveredIatas = new Set<string>();
    let available = false;
    try {
      const seed = await readCachedJson(INTL_CACHE_KEY, true);
      const cached = seed.status === 'hit' ? seed.value as { alerts?: unknown[]; coverage?: unknown[] } | null : null;
      const validAlerts = Array.isArray(cached?.alerts) && cached.alerts.every(isValidAirportDelayAlert);
      const validCoverage = cached?.coverage === undefined
        || (Array.isArray(cached.coverage) && cached.coverage.every(isValidIntlCoverage));
      if (validAlerts && validCoverage) {
        available = true;
        intlAlerts = cached.alerts! as AirportDelayAlert[];
        if (Array.isArray(cached.coverage)) {
          intlCoveredIatas = new Set(cached.coverage
            .filter(isValidIntlCoverage)
            .filter((hub) => hub.status === 'normal' || hub.status === 'disruption')
            .map((hub) => hub.iata));
        }
      }
    } catch (err) {
      console.warn(`[Aviation] Intl fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
      void captureSilentError(err, { tags: { route: 'aviation/list-airport-delays', step: 'intl-cache-read' } });
      available = false;
      intlAlerts = [];
      intlCoveredIatas = new Set();
    }
    return { intlAlerts, intlCoveredIatas, available };
  })();

  // 3. NOTAM alerts — optional seed-only enrichment. A missing seed is valid;
  // a read or decode failure keeps the response out of caches.
  const notamRead = loadNotamClosures();

  const [{ faaAlerts, faaSourceCovered, available: faaAvailable }, { intlAlerts, intlCoveredIatas, available: intlAvailable }, notamReadResult] =
    await Promise.all([faaRead, intlRead, notamRead]);

  const notamResult = notamReadResult.data;

  const allAlerts = [...faaAlerts, ...intlAlerts];
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

  // 4. Fill in monitored airports without an active alert.
  //   - Covered (the airport's primary source returned data this tick) →
  //     emit a NORMAL row sourced to the actual upstream (FAA or AviationStack),
  //     not 'computed' which obscured provenance.
  //   - Not covered (cache miss / source stall / NOTAM-only airport with no
  //     active NOTAM) → emit an UNKNOWN row so consumers don't render the
  //     airport as "healthy" when we actually have no telemetry. See #3707.
  const alertedIatas = new Set(allAlerts.map(a => a.iata));
  for (const airport of MONITORED_AIRPORTS) {
    if (alertedIatas.has(airport.iata)) continue;

    const isFaaCovered = FAA_AIRPORT_SET.has(airport.iata) && faaSourceCovered;
    const isIntlCovered = INTL_AIRPORT_SET.has(airport.iata) && intlCoveredIatas.has(airport.iata);
    const covered = isFaaCovered || isIntlCovered;

    if (covered) {
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
        source: toProtoSource(isFaaCovered ? 'faa' : 'aviationstack'),
        updatedAt: Date.now(),
      });
    } else {
      allAlerts.push({
        id: `unknown-${airport.iata}`,
        iata: airport.iata,
        icao: airport.icao,
        name: airport.name,
        city: airport.city,
        country: airport.country,
        location: { latitude: airport.lat, longitude: airport.lon },
        region: toProtoRegion(airport.region),
        delayType: toProtoDelayType('general'),
        severity: toProtoSeverity('unknown'),
        avgDelayMinutes: 0,
        delayedFlightsPct: 0,
        cancelledFlights: 0,
        totalFlights: 0,
        reason: 'Coverage unavailable',
        source: toProtoSource('unspecified'),
        updatedAt: Date.now(),
      });
    }
  }

  const response = { alerts: allAlerts };
  return faaAvailable && intlAvailable && !notamReadResult.unavailable
    ? response
    : markNoStoreFallbackResponse(ctx.request, response);
}
