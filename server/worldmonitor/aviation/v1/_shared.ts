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
  MONITORED_AIRPORTS,
  FAA_AIRPORTS,
  DELAY_SEVERITY_THRESHOLDS,
} from '../../../../src/config/airports';
import { CHROME_UA } from '../../../_shared/constants';

// ---------- Constants ----------

export const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
export const AVIATIONSTACK_URL = 'https://api.aviationstack.com/v1/flights';
export const ICAO_NOTAM_URL = 'https://dataservices.icao.int/api/notams-realtime-list';
const BATCH_CONCURRENCY = 10;
const MIN_FLIGHTS_FOR_CLOSURE = 10;
const NOTAM_CLOSURE_QCODES = new Set(['FA', 'AH', 'AL', 'AW', 'AC', 'AM']);

// ---------- XML Parser ----------

export const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name: string, jpath: string) => {
    // Force arrays for list items regardless of count to prevent single-item-as-object bug
    return /\.(Ground_Delay|Ground_Stop|Delay|Airport)$/.test(jpath);
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
  };
  return map[s] || 'FLIGHT_DELAY_SEVERITY_NORMAL';
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
    faa: 'FLIGHT_DELAY_SOURCE_FAA',
    eurocontrol: 'FLIGHT_DELAY_SOURCE_EUROCONTROL',
    computed: 'FLIGHT_DELAY_SOURCE_COMPUTED',
  };
  return map[s] || 'FLIGHT_DELAY_SOURCE_COMPUTED';
}

// ---------- Severity classification ----------

export function determineSeverity(avgDelayMinutes: number, delayedPct?: number): string {
  const t = DELAY_SEVERITY_THRESHOLDS;
  if (avgDelayMinutes >= t.severe.avgDelayMinutes || (delayedPct && delayedPct >= t.severe.delayedPct)) return 'severe';
  if (avgDelayMinutes >= t.major.avgDelayMinutes || (delayedPct && delayedPct >= t.major.delayedPct)) return 'major';
  if (avgDelayMinutes >= t.moderate.avgDelayMinutes || (delayedPct && delayedPct >= t.moderate.delayedPct)) return 'moderate';
  if (avgDelayMinutes >= t.minor.avgDelayMinutes || (delayedPct && delayedPct >= t.minor.delayedPct)) return 'minor';
  return 'normal';
}

// ---------- AviationStack integration ----------

interface AviationStackFlight {
  flight_status?: string;
  departure?: { delay?: number };
}

export interface AviationStackResult {
  alerts: AirportDelayAlert[];
  healthy: boolean;
}

export async function fetchAviationStackDelays(
  allAirports: MonitoredAirport[]
): Promise<AviationStackResult> {
  const apiKey = process.env.AVIATIONSTACK_API;
  if (!apiKey) {
    console.log('[Aviation] No AVIATIONSTACK_API key — skipping');
    return { alerts: [], healthy: false };
  }

  console.log(`[Aviation] Querying ${allAirports.length} airports (concurrency=${BATCH_CONCURRENCY})`);
  const alerts: AirportDelayAlert[] = [];
  let succeeded = 0, failed = 0;
  const deadline = Date.now() + 50_000;

  for (let i = 0; i < allAirports.length; i += BATCH_CONCURRENCY) {
    if (Date.now() >= deadline) {
      console.warn(`[Aviation] Deadline hit after ${succeeded + failed}/${allAirports.length} airports`);
      break;
    }
    const chunk = allAirports.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(airport => fetchSingleAirport(apiKey, airport))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.ok) { succeeded++; if (r.value.alert) alerts.push(r.value.alert); }
        else failed++;
      } else {
        failed++;
      }
    }
  }

  const healthy = allAirports.length < 5 || failed <= succeeded;
  console.log(`[Aviation] Done: ${succeeded} ok, ${failed} failed, ${alerts.length} alerts, healthy=${healthy}`);
  if (!healthy) {
    console.warn(`[Aviation] Systemic failure: ${failed}/${failed + succeeded} airports failed`);
  }
  return { alerts, healthy };
}

interface FetchResult { ok: boolean; alert: AirportDelayAlert | null; }

async function fetchSingleAirport(
  apiKey: string, airport: MonitoredAirport
): Promise<FetchResult> {
  try {
    const url = `${AVIATIONSTACK_URL}?access_key=${apiKey}&dep_iata=${airport.iata}&limit=100`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      console.warn(`[Aviation] ${airport.iata}: HTTP ${resp.status}`);
      return { ok: false, alert: null };
    }
    const json = await resp.json() as { data?: AviationStackFlight[]; error?: { message?: string } };
    if (json.error) {
      console.warn(`[Aviation] ${airport.iata}: API error: ${json.error.message}`);
      return { ok: false, alert: null };
    }
    const flights = json?.data ?? [];
    const alert = aggregateFlights(airport, flights);
    if (flights.length > 0) {
      const cancelled = flights.filter(f => f.flight_status === 'cancelled').length;
      const delayed = flights.filter(f => f.departure?.delay && f.departure.delay > 0).length;
      console.log(`[Aviation] ${airport.iata}: ${flights.length} flights, ${cancelled} cancelled, ${delayed} delayed → ${alert ? alert.severity.replace('FLIGHT_DELAY_SEVERITY_', '') : 'normal'}`);
    }
    return { ok: true, alert };
  } catch (err) {
    console.warn(`[Aviation] ${airport.iata}: fetch error: ${err instanceof Error ? err.message : 'unknown'}`);
    return { ok: false, alert: null };
  }
}

function aggregateFlights(
  airport: MonitoredAirport, flights: AviationStackFlight[]
): AirportDelayAlert | null {
  if (flights.length === 0) return null;

  let delayed = 0, cancelled = 0, totalDelay = 0;
  for (const f of flights) {
    if (f.flight_status === 'cancelled') cancelled++;
    if (f.departure?.delay && f.departure.delay > 0) {
      delayed++;
      totalDelay += f.departure.delay;
    }
  }

  const total = flights.length;
  const cancelledPct = (cancelled / total) * 100;
  const delayedPct = (delayed / total) * 100;
  const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;

  let severity: string, delayType: string, reason: string;
  if (cancelledPct >= 80 && total >= MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'severe'; delayType = 'closure';
    reason = 'Airport closure / airspace restrictions';
  } else if (cancelledPct >= 50 && total >= MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'major'; delayType = 'ground_stop';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (cancelledPct >= 20 && total >= MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'moderate'; delayType = 'ground_delay';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (cancelledPct >= 10 && total >= MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'minor'; delayType = 'general';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (avgDelay > 0) {
    severity = determineSeverity(avgDelay, delayedPct);
    delayType = avgDelay >= 60 ? 'ground_delay' : 'general';
    reason = `Avg ${avgDelay}min delay, ${Math.round(delayedPct)}% delayed`;
  } else {
    return null;
  }
  if (severity === 'normal') return null;

  return {
    id: `avstack-${airport.iata}`,
    iata: airport.iata, icao: airport.icao,
    name: airport.name, city: airport.city, country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType(delayType),
    severity: toProtoSeverity(severity),
    avgDelayMinutes: avgDelay,
    delayedFlightsPct: Math.round(delayedPct),
    cancelledFlights: cancelled,
    totalFlights: total,
    reason,
    source: toProtoSource('computed'),
    updatedAt: Date.now(),
  };
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
  notamsByIcao: Map<string, string>;
}

export async function fetchNotamClosures(
  airports: MonitoredAirport[]
): Promise<NotamClosureResult> {
  const apiKey = process.env.ICAO_API_KEY;
  const result: NotamClosureResult = { closedIcaoCodes: new Set(), notamsByIcao: new Map() };
  if (!apiKey) return result;

  const icaoCodes = airports.map(a => a.icao);
  const batchSize = 20;
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < icaoCodes.length; i += batchSize) {
    const batch = icaoCodes.slice(i, i + batchSize);
    const locations = batch.join(',');
    try {
      const url = `${ICAO_NOTAM_URL}?api_key=${apiKey}&format=json&locations=${locations}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`[Aviation] NOTAM batch ${i / batchSize + 1}: HTTP ${resp.status}`);
        continue;
      }
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        console.warn(`[Aviation] NOTAM batch ${i / batchSize + 1}: got HTML instead of JSON (API may be down or key invalid)`);
        continue;
      }
      const notams = await resp.json() as IcaoNotam[];
      if (!Array.isArray(notams)) continue;

      for (const n of notams) {
        const icao = n.itema || n.location || '';
        if (!icao || !batch.includes(icao)) continue;
        if (n.endvalidity && n.endvalidity < now) continue;

        const code23 = (n.code23 || '').toUpperCase();
        const code45 = (n.code45 || '').toUpperCase();
        const text = (n.iteme || '').toUpperCase();
        const isClosureCode = NOTAM_CLOSURE_QCODES.has(code23) &&
          (code45 === 'LC' || code45 === 'AS' || code45 === 'AU' || code45 === 'XX' || code45 === 'AW');
        const isClosureText = /\b(AD CLSD|AIRPORT CLOSED|AIRSPACE CLOSED|AD NOT AVBL|CLSD TO ALL)\b/.test(text);

        if (isClosureCode || isClosureText) {
          result.closedIcaoCodes.add(icao);
          result.notamsByIcao.set(icao, n.iteme || 'Airport closure (NOTAM)');
        }
      }
    } catch (err) {
      console.warn(`[Aviation] NOTAM batch ${i / batchSize + 1}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  if (result.closedIcaoCodes.size > 0) {
    console.log(`[Aviation] NOTAM closures: ${[...result.closedIcaoCodes].join(', ')}`);
  }
  return result;
}

export function buildNotamAlert(airport: MonitoredAirport, reason: string): AirportDelayAlert {
  return {
    id: `notam-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType('closure'),
    severity: toProtoSeverity('severe'),
    avgDelayMinutes: 0,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason: reason.length > 200 ? reason.slice(0, 200) + '…' : reason,
    source: toProtoSource('computed'),
    updatedAt: Date.now(),
  };
}

// ---------- Simulated delay generation ----------

export function generateSimulatedDelay(airport: typeof MONITORED_AIRPORTS[number]): AirportDelayAlert | null {
  const hour = new Date().getUTCHours();
  const isRushHour = (hour >= 6 && hour <= 10) || (hour >= 16 && hour <= 20);
  const busyAirports = ['LHR', 'CDG', 'FRA', 'JFK', 'LAX', 'ORD', 'PEK', 'HND', 'DXB', 'SIN'];
  const isBusy = busyAirports.includes(airport.iata);
  const random = Math.random();
  const delayChance = isRushHour ? 0.35 : 0.15;
  const hasDelay = random < (isBusy ? delayChance * 1.5 : delayChance);

  if (!hasDelay) return null;

  let avgDelayMinutes = 0;
  let delayType = 'general';
  let reason = 'Minor delays';

  const severityRoll = Math.random();
  if (severityRoll < 0.05) {
    avgDelayMinutes = 60 + Math.floor(Math.random() * 60);
    delayType = Math.random() < 0.3 ? 'ground_stop' : 'ground_delay';
    reason = Math.random() < 0.5 ? 'Weather conditions' : 'Air traffic volume';
  } else if (severityRoll < 0.2) {
    avgDelayMinutes = 45 + Math.floor(Math.random() * 20);
    delayType = 'ground_delay';
    reason = Math.random() < 0.5 ? 'Weather' : 'High traffic volume';
  } else if (severityRoll < 0.5) {
    avgDelayMinutes = 25 + Math.floor(Math.random() * 20);
    delayType = Math.random() < 0.5 ? 'departure_delay' : 'arrival_delay';
    reason = 'Congestion';
  } else {
    avgDelayMinutes = 15 + Math.floor(Math.random() * 15);
    delayType = 'general';
    reason = 'Minor delays';
  }

  const severity = determineSeverity(avgDelayMinutes);
  // Only return if severity is not normal (matching legacy behavior: filter out normal)
  if (severity === 'normal') return null;

  return {
    id: `sim-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType(delayType),
    severity: toProtoSeverity(severity),
    avgDelayMinutes,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason,
    source: toProtoSource('computed'),
    updatedAt: Date.now(),
  };
}
