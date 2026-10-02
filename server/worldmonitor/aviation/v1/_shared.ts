import { XMLParser } from 'fast-xml-parser';
import type {
  AirportDelayAlert,
  FlightDelayType,
  FlightDelaySeverity,
  FlightDelaySource,
  AirportRegion,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import type { MonitoredAirport } from '../../../../src/types';
import {
  FAA_AIRPORTS,
  DELAY_SEVERITY_THRESHOLDS,
} from '../../../../src/config/airports';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { CHROME_UA } from '../../../_shared/constants';
import { incrementProviderCounter } from './_counters';
import { readCachedJson } from '../../../_shared/redis';
import { requirePremiumRpcAccess } from '../../../_shared/premium-check';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';
export { parseStringArray } from '../../../_shared/parse-string-array';

export type IntlCoverage = { iata: string; status: 'normal' | 'disruption' | 'omitted' | 'failed'; flightCount: number };
const COVERAGE_STATUSES = new Set<IntlCoverage['status']>(['normal', 'disruption', 'omitted', 'failed']);

export function isValidAirportDelayAlert(value: unknown): value is AirportDelayAlert {
  if (!value || typeof value !== 'object') return false;
  const alert = value as Partial<AirportDelayAlert>;
  return typeof alert.iata === 'string'
    && (alert.reason === undefined || typeof alert.reason === 'string')
    && (alert.delayedFlightsPct === undefined || Number.isFinite(alert.delayedFlightsPct))
    && (alert.avgDelayMinutes === undefined || Number.isFinite(alert.avgDelayMinutes))
    && (alert.cancelledFlights === undefined || Number.isFinite(alert.cancelledFlights))
    && (alert.totalFlights === undefined || Number.isFinite(alert.totalFlights));
}

export function isValidIntlCoverage(value: unknown): value is IntlCoverage {
  if (!value || typeof value !== 'object') return false;
  const coverage = value as Partial<IntlCoverage>;
  return typeof coverage.iata === 'string' && typeof coverage.status === 'string'
    && COVERAGE_STATUSES.has(coverage.status as IntlCoverage['status']);
}

// ---------- Live (metered) aviation access ----------

export const LIVE_AVIATION_PRO_MESSAGE =
  'PRO subscription or API key required for live flight data';

/**
 * Gate for the AviationStack-metered routes: list-airport-flights,
 * get-carrier-ops, get-flight-status.
 *
 * These three are the ONLY aviation surfaces that spend money per request —
 * each cache miss buys an AviationStack call, and get-carrier-ops buys one per
 * airport. They were anonymous, which is what made them free to abuse: in
 * August 2026 a single scripted client took ~1,000 paid calls/day, ~43% of
 * total spend, from an account already over its 50,000/cycle plan.
 *
 * Edge heuristics could not stop it. A Cloudflare rule blocking bot-like user
 * agents missed a client rotating six real browser UAs, and an IP rule at
 * Vercel could not match because Cloudflare fronts the domain and Vercel only
 * ever sees a proxy address. Identity is checkable where the request is
 * served; intent is not checkable at the edge.
 *
 * Deliberately NOT applied to the rest of the aviation surface. list-airport-
 * delays and get-airport-ops-summary read `aviation:delays:intl:v3`, which the
 * cron seeder already paid for — serving it to one more anonymous visitor
 * costs nothing, so the map's airport-delay layer stays free and signup-free.
 *
 * Call FIRST in each handler, before the cache key is built and before any
 * Redis read, so a denied request costs nothing and cannot probe which airport
 * codes or flight numbers are valid.
 */
export async function requireLiveAviationAccess(request: Request): Promise<void> {
  await requirePremiumRpcAccess(request, ApiError, LIVE_AVIATION_PRO_MESSAGE);
}

// ---------- Constants ----------

export const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
export const ICAO_NOTAM_URL = 'https://dataservices.icao.int/api/notams-realtime-list';
export const DEFAULT_WATCHED_AIRPORTS = ['IST', 'ESB', 'SAW', 'LHR', 'FRA', 'CDG'];

// Shared by every route that turns a caller-supplied airport code into a PAID
// AviationStack call. Rejecting non-IATA input before the fetch bounds cache-key
// cardinality and stops arbitrary strings being used to probe upstream.
export const IATA_RE = /^[A-Z]{3}$/;

// Ceiling on how many airports one request may fan out to. get-carrier-ops
// issues one paid AviationStack call PER AIRPORT, and `parseStringArray` puts no
// bound on the list, so `?airports=A,B,...` was an unauthenticated multiplier on
// spend — 26 codes meant 26 paid calls from one anonymous request. Sized to
// DEFAULT_WATCHED_AIRPORTS so the full watched set still resolves in one call.
export const MAX_AIRPORTS_PER_REQUEST = DEFAULT_WATCHED_AIRPORTS.length;
const NOTAM_CLOSURE_QCODES = new Set(['FA', 'AH', 'AL', 'AW', 'AC', 'AM']);
const NOTAM_RESTRICTION_QCODES = new Set(['RA', 'RO']);

// ---------- XML Parser ----------

export const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name: string, jpath: unknown) => {
    // Force arrays for list items regardless of count to prevent single-item-as-object bug
    return typeof jpath === 'string' && /\.(Ground_Delay|Ground_Stop|Delay|Airport)$/.test(jpath);
  },
});

// ---------- Internal types ----------

export interface FAADelayInfo {
  airport: string;
  reason: string;
  avgDelay: number;
  type: string;
}

// ---------- Helpers ----------

export function parseDelayTypeFromReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}

export function parseFaaXml(xml: string): Map<string, FAADelayInfo> {
  const delays = new Map<string, FAADelayInfo>();
  const parsed = xmlParser.parse(xml);
  const root = parsed?.AIRPORT_STATUS_INFORMATION;
  if (!root) return delays;

  // Delay_type may be array or single object
  const delayTypes = Array.isArray(root.Delay_type)
    ? root.Delay_type
    : root.Delay_type ? [root.Delay_type] : [];

  for (const dt of delayTypes) {
    // Ground Delays
    if (dt.Ground_Delay_List?.Ground_Delay) {
      for (const gd of dt.Ground_Delay_List.Ground_Delay) {
        if (gd.ARPT) {
          delays.set(gd.ARPT, {
            airport: gd.ARPT,
            reason: gd.Reason || 'Ground delay',
            avgDelay: gd.Avg ? parseInt(gd.Avg, 10) : 30,
            type: 'ground_delay',
          });
        }
      }
    }
    // Ground Stops
    if (dt.Ground_Stop_List?.Ground_Stop) {
      for (const gs of dt.Ground_Stop_List.Ground_Stop) {
        if (gs.ARPT) {
          delays.set(gs.ARPT, {
            airport: gs.ARPT,
            reason: gs.Reason || 'Ground stop',
            avgDelay: 60,
            type: 'ground_stop',
          });
        }
      }
    }
    // Arrival/Departure Delays
    if (dt.Arrival_Departure_Delay_List?.Delay) {
      for (const d of dt.Arrival_Departure_Delay_List.Delay) {
        if (d.ARPT) {
          const min = parseInt(d.Arrival_Delay?.Min || d.Departure_Delay?.Min || '15', 10);
          const max = parseInt(d.Arrival_Delay?.Max || d.Departure_Delay?.Max || '30', 10);
          const existing = delays.get(d.ARPT);
          // Don't downgrade ground_stop to lesser delay
          if (!existing || existing.type !== 'ground_stop') {
            delays.set(d.ARPT, {
              airport: d.ARPT,
              reason: d.Reason || 'Delays',
              avgDelay: Math.round((min + max) / 2),
              type: parseDelayTypeFromReason(d.Reason || ''),
            });
          }
        }
      }
    }
    // Airport Closures
    if (dt.Airport_Closure_List?.Airport) {
      for (const ac of dt.Airport_Closure_List.Airport) {
        if (ac.ARPT && FAA_AIRPORTS.includes(ac.ARPT)) {
          delays.set(ac.ARPT, {
            airport: ac.ARPT,
            reason: 'Airport closure',
            avgDelay: 120,
            type: 'ground_stop',
          });
        }
      }
    }
  }

  return delays;
}

// ---------- Proto enum mappers ----------

export function toProtoDelayType(t: string): FlightDelayType {
  const map: Record<string, FlightDelayType> = {
    ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP',
    ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
    departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
    arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
    general: 'FLIGHT_DELAY_TYPE_GENERAL',
    closure: 'FLIGHT_DELAY_TYPE_CLOSURE',
  };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}

export function toProtoSeverity(s: string): FlightDelaySeverity {
  const map: Record<string, FlightDelaySeverity> = {
    normal: 'FLIGHT_DELAY_SEVERITY_NORMAL',
    minor: 'FLIGHT_DELAY_SEVERITY_MINOR',
    moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE',
    major: 'FLIGHT_DELAY_SEVERITY_MAJOR',
    severe: 'FLIGHT_DELAY_SEVERITY_SEVERE',
    unknown: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
  };
  // #3707: default to UNKNOWN (not NORMAL) for unrecognised input — the whole
  // point of the fix is to refuse to render uncovered/unmappable airports as
  // healthy.
  return map[s] || 'FLIGHT_DELAY_SEVERITY_UNKNOWN';
}

export function toProtoRegion(r: string): AirportRegion {
  const map: Record<string, AirportRegion> = {
    americas: 'AIRPORT_REGION_AMERICAS',
    europe: 'AIRPORT_REGION_EUROPE',
    apac: 'AIRPORT_REGION_APAC',
    mena: 'AIRPORT_REGION_MENA',
    africa: 'AIRPORT_REGION_AFRICA',
  };
  return map[r] || 'AIRPORT_REGION_UNSPECIFIED';
}

export function toProtoSource(s: string): FlightDelaySource {
  const map: Record<string, FlightDelaySource> = {
    unspecified: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
    faa: 'FLIGHT_DELAY_SOURCE_FAA',
    eurocontrol: 'FLIGHT_DELAY_SOURCE_EUROCONTROL',
    computed: 'FLIGHT_DELAY_SOURCE_COMPUTED',
    aviationstack: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
    notam: 'FLIGHT_DELAY_SOURCE_NOTAM',
  };
  return map[s] || 'FLIGHT_DELAY_SOURCE_COMPUTED';
}

// ---------- Severity classification ----------

export function severityFromCancelRate(cancelRate: number): string {
  if (cancelRate >= 80) return 'severe';
  if (cancelRate >= 50) return 'major';
  if (cancelRate >= 20) return 'moderate';
  if (cancelRate >= 10) return 'minor';
  return 'normal';
}

export function determineSeverity(avgDelayMinutes: number, delayedPct?: number): string {
  const t = DELAY_SEVERITY_THRESHOLDS;
  if (avgDelayMinutes >= t.severe.avgDelayMinutes || (delayedPct && delayedPct >= t.severe.delayedPct)) return 'severe';
  if (avgDelayMinutes >= t.major.avgDelayMinutes || (delayedPct && delayedPct >= t.major.delayedPct)) return 'major';
  if (avgDelayMinutes >= t.moderate.avgDelayMinutes || (delayedPct && delayedPct >= t.moderate.delayedPct)) return 'moderate';
  if (avgDelayMinutes >= t.minor.avgDelayMinutes || (delayedPct && delayedPct >= t.minor.delayedPct)) return 'minor';
  return 'normal';
}

// ---------- NOTAM closure detection (ICAO API) ----------

interface IcaoNotam {
  id?: string;
  location?: string;
  itema?: string;
  iteme?: string;
  code23?: string;
  code45?: string;
  scope?: string;
  startvalidity?: number;
  endvalidity?: number;
}

export interface NotamClosureResult {
  closedIcaoCodes: Set<string>;
  restrictedIcaoCodes: Set<string>;
  notamsByIcao: Map<string, string>;
}

import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
export { getRelayBaseUrl, getRelayHeaders };

export async function fetchNotamClosures(
  airports: MonitoredAirport[]
): Promise<NotamClosureResult> {
  const apiKey = process.env.ICAO_API_KEY;
  const result: NotamClosureResult = { closedIcaoCodes: new Set(), restrictedIcaoCodes: new Set(), notamsByIcao: new Map() };
  if (!apiKey) {
    console.warn('[Aviation] NOTAM: no ICAO_API_KEY — skipping');
    incrementProviderCounter('notamAuthRejection');
    return result;
  }

  const relayBase = getRelayBaseUrl();
  const icaoCodes = airports.map(a => a.icao);
  const now = Math.floor(Date.now() / 1000);

  // Send all locations in one request (relay or direct)
  const locations = icaoCodes.join(',');
  let notams: IcaoNotam[] = [];

  try {
    if (relayBase) {
      // Route through Railway relay — avoids Vercel edge timeout / CloudFront blocking
      const relayUrl = `${relayBase}/notam?locations=${encodeURIComponent(locations)}`;
      const resp = await fetch(relayUrl, {
        headers: getRelayHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status === 401 || resp.status === 403) incrementProviderCounter('notamAuthRejection');
      if (!resp.ok) {
        incrementProviderCounter('notamTerminalFailure');
        console.warn(`[Aviation] NOTAM relay: HTTP ${resp.status}`);
        return result;
      }
      const data = await resp.json();
      if (Array.isArray(data)) notams = data;
    } else {
      // Direct ICAO call (slower from Vercel, may timeout)
      const url = `${ICAO_NOTAM_URL}?api_key=${apiKey}&format=json&locations=${locations}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (resp.status === 401 || resp.status === 403) incrementProviderCounter('notamAuthRejection');
      if (!resp.ok) {
        incrementProviderCounter('notamTerminalFailure');
        console.warn(`[Aviation] NOTAM direct: HTTP ${resp.status}`);
        return result;
      }
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        incrementProviderCounter('notamTerminalFailure');
        console.warn('[Aviation] NOTAM direct: got HTML instead of JSON');
        return result;
      }
      const data = await resp.json();
      if (Array.isArray(data)) notams = data;
    }
    incrementProviderCounter('notamSuccess');
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out'));
    if (isTimeout) incrementProviderCounter('notamTimeout');
    else incrementProviderCounter('notamTerminalFailure');
    console.warn(`[Aviation] NOTAM fetch: ${err instanceof Error ? err.message : 'unknown'}`);
    return result;
  }

  for (const n of notams) {
    const icao = n.itema || n.location || '';
    if (!icao || !icaoCodes.includes(icao)) continue;
    if (n.endvalidity && n.endvalidity < now) continue;

    const code23 = (n.code23 || '').toUpperCase();
    const code45 = (n.code45 || '').toUpperCase();
    const text = (n.iteme || '').toUpperCase();
    const closureCode45 = code45 === 'LC' || code45 === 'AS' || code45 === 'AU' || code45 === 'XX' || code45 === 'AW';
    const restrictionCode45 = code45 === 'RE' || code45 === 'RT';
    const isClosureCode = NOTAM_CLOSURE_QCODES.has(code23) && closureCode45;
    const isRestrictionCode = (NOTAM_RESTRICTION_QCODES.has(code23) || NOTAM_CLOSURE_QCODES.has(code23)) && restrictionCode45;
    const isClosureText = /\b(AD CLSD|AIRPORT CLOSED|AIRSPACE CLOSED|AD NOT AVBL|CLSD TO ALL)\b/.test(text);
    const isRestrictionText = /\b(RESTRICTED AREA|PROHIBITED AREA|DANGER AREA|TFR|TEMPORARY FLIGHT RESTRICTION)\b/.test(text);

    if (isClosureCode || isClosureText) {
      result.closedIcaoCodes.add(icao);
      result.notamsByIcao.set(icao, n.iteme || 'Airport closure (NOTAM)');
    } else if (isRestrictionCode || isRestrictionText) {
      result.restrictedIcaoCodes.add(icao);
      result.notamsByIcao.set(icao, n.iteme || 'Airspace restriction (NOTAM)');
    }
  }

  if (result.closedIcaoCodes.size > 0 || result.restrictedIcaoCodes.size > 0) {
    console.warn(`[Aviation] NOTAM: ${result.closedIcaoCodes.size} closures [${[...result.closedIcaoCodes].join(', ')}], ${result.restrictedIcaoCodes.size} restrictions [${[...result.restrictedIcaoCodes].join(', ')}]`);
  }
  return result;
}

export function buildNotamAlert(
  airport: MonitoredAirport,
  reason: string,
  severity: 'severe' | 'major' = 'severe',
  delayType: 'closure' | 'general' = 'closure',
): AirportDelayAlert {
  return {
    id: `notam-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType(delayType),
    severity: toProtoSeverity(severity),
    avgDelayMinutes: 0,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason: reason.length > 200 ? reason.slice(0, 200) + '…' : reason,
    source: toProtoSource('notam'),
    updatedAt: Date.now(),
  };
}

// ---------- Shared NOTAM loader (used by both list-airport-delays and get-airport-ops-summary) ----------

const NOTAM_CACHE_KEY = 'aviation:notam:closures:v2';
export interface LoadedNotamResult {
  closedIcaos: string[];
  restrictedIcaos: string[];
  reasons: Record<string, string>;
}

export interface LoadedNotamRead {
  data: LoadedNotamResult | null;
  unavailable: boolean;
}

export async function loadNotamClosures(): Promise<LoadedNotamRead> {
  try {
    const seed = await readCachedJson(NOTAM_CACHE_KEY, true);
    if (seed.status === 'miss') return { data: null, unavailable: false };
    if (seed.status === 'error') return { data: null, unavailable: true };
    const value = seed.value as Partial<LoadedNotamResult> | null;
    if (!value || !Array.isArray(value.closedIcaos) || !Array.isArray(value.restrictedIcaos)
      || !value.reasons || typeof value.reasons !== 'object') return { data: null, unavailable: true };
    if (!value.closedIcaos.every((icao) => typeof icao === 'string')
      || !value.restrictedIcaos.every((icao) => typeof icao === 'string')
      || !Object.values(value.reasons).every((reason) => typeof reason === 'string')) {
      return { data: null, unavailable: true };
    }
    return { data: {
      closedIcaos: value.closedIcaos,
      restrictedIcaos: value.restrictedIcaos,
      reasons: value.reasons,
    }, unavailable: false };
  } catch (err) {
    console.warn(`[Aviation] NOTAM seed read failed: ${err instanceof Error ? err.message : 'unknown'}`);
    void captureSilentError(err, { tags: { route: 'aviation/notam', step: 'seed-read' } });
  }
  return { data: null, unavailable: true };
}

// ---------- NOTAM + flight data merge ----------

const SEV_ORDER = ['normal', 'minor', 'moderate', 'major', 'severe'];

export function mergeNotamWithExistingAlert(
  airport: MonitoredAirport,
  notamReason: string,
  existing: AirportDelayAlert | null,
  severity: 'severe' | 'major' = 'severe',
  delayType: 'closure' | 'general' = 'closure',
): AirportDelayAlert {
  if (!existing || existing.totalFlights === 0) {
    return buildNotamAlert(airport, notamReason, severity, delayType);
  }

  const cancelRate = (existing.cancelledFlights / existing.totalFlights) * 100;
  const notamCancelSev = severityFromCancelRate(cancelRate);
  const notamFloor = 'moderate';

  const existingSevName = (existing.severity ?? '')
    .replace('FLIGHT_DELAY_SEVERITY_', '').toLowerCase() || 'normal';
  const effectiveSev = SEV_ORDER[Math.max(
    SEV_ORDER.indexOf(existingSevName),
    SEV_ORDER.indexOf(notamCancelSev),
    SEV_ORDER.indexOf(notamFloor),
  )] ?? 'moderate';

  const cancelText = `${Math.round(cancelRate)}% cxl`;
  const reason = `NOTAM: ${notamReason.slice(0, 120)} — ${cancelText}`;

  return {
    ...existing,
    id: `notam-${airport.iata}`,
    severity: toProtoSeverity(effectiveSev),
    delayType: toProtoDelayType(delayType),
    reason: reason.length > 200 ? reason.slice(0, 200) + '…' : reason,
    source: toProtoSource('notam'),
    updatedAt: Date.now(),
  };
}
