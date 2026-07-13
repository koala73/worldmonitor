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
} from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v3';

const FAA_AIRPORT_SET = new Set(FAA_AIRPORTS);
const INTL_AIRPORT_SET = new Set(AVIATIONSTACK_AIRPORTS);
type IntlCoverage = { iata: string; status: 'normal' | 'disruption' | 'omitted' | 'failed'; flightCount: number };

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  // 1. FAA (US) — seed-only read
  // faaSourceCovered = the seed cache hit AND returned a valid alerts array.
  // A miss/parse-error means we have no telemetry for any FAA airport this
  // tick — we MUST NOT publish synthetic "normal" rows for them. See #3707.
  let faaAlerts: AirportDelayAlert[] = [];
  let faaSourceCovered = false;
  try {
    const seedData = await getCachedJson(FAA_CACHE_KEY, true) as { alerts: AirportDelayAlert[] } | null;
    if (seedData && Array.isArray(seedData.alerts)) {
      faaSourceCovered = true;
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
  // A cache hit alone does not prove every configured hub was covered. The
  // seeder records each hub as normal/disruption/omitted/failed so an omitted
  // hub remains UNKNOWN instead of being synthesized as normal.
  let intlAlerts: AirportDelayAlert[] = [];
  let intlCoverage: IntlCoverage[] = [];
  let intlCoveredIatas = new Set<string>();
  try {
    const cached = await getCachedJson(INTL_CACHE_KEY) as { alerts: AirportDelayAlert[]; coverage?: IntlCoverage[] } | null;
    if (cached && Array.isArray(cached.alerts)) {
      intlAlerts = cached.alerts;
      if (Array.isArray(cached.coverage)) {
        intlCoverage = cached.coverage;
        intlCoveredIatas = new Set(cached.coverage
          .filter((hub) => hub.status === 'normal' || hub.status === 'disruption')
          .map((hub) => hub.iata));
      }
    }
  } catch (err) {
    console.warn(`[Aviation] Intl fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 3. NOTAM alerts — shared loader (seed-first with live fallback).
  // loadNotamClosures swallows both the seed-read and live-fetch failures
  // internally (returns null on error), so no outer try/catch is needed — a
  // failure degrades cleanly to "no NOTAM merge this tick" rather than
  // bubbling and tripping every airport to UNKNOWN at the handler boundary.
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

  // Write bootstrap key for initial page load hydration. Canonical writer is
  // scripts/seed-aviation.mjs (BOOTSTRAP_TTL=7200). This RPC-side write is a
  // courtesy mid-tick refresh — TTL kept in lockstep so a user-triggered RPC
  // doesn't shorten the seeder's expiry and re-create the EMPTY-on-quiet-traffic
  // failure mode that motivated the canonical seeder write.
  try {
    await setCachedJson('aviation:delays-bootstrap:v2', { alerts: allAlerts, coverage: intlCoverage }, 7200);
  } catch { /* non-critical */ }

  return { alerts: allAlerts };
}
