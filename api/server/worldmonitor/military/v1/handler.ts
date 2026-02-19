/**
 * Military service handler -- implements the generated
 * MilitaryServiceHandler interface with 3 RPCs:
 *   - ListMilitaryFlights   (stub -- client-side fetches from OpenSky/Wingbits directly)
 *   - ListMilitaryVessels   (stub -- client-side fetches from AIS stream)
 *   - GetTheaterPosture     (OpenSky + Wingbits -> theater posture aggregation)
 *
 * Consolidates legacy edge function:
 *   api/theater-posture.js
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  MilitaryServiceHandler,
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  ListMilitaryVesselsRequest,
  ListMilitaryVesselsResponse,
  GetTheaterPostureRequest,
  GetTheaterPostureResponse,
  TheaterPosture,
} from '../../../../../src/generated/server/worldmonitor/military/v1/service_server';

// @ts-expect-error -- JS data module, no declarations
import { MILITARY_HEX_LIST } from '../../../../data/military-hex-db.js';

// ========================================================================
// Upstash Redis helpers (inline -- edge-compatible)
// ========================================================================

async function getCachedJson(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string };
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value)),
      signal: AbortSignal.timeout(3_000),
    });
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* best-effort */ }
}

// ========================================================================
// Constants
// ========================================================================

const UPSTREAM_TIMEOUT_MS = 20_000;
const CACHE_KEY = 'theater-posture:sebuf:v1';
const STALE_CACHE_KEY = 'theater-posture:sebuf:stale:v1';
const BACKUP_CACHE_KEY = 'theater-posture:sebuf:backup:v1';
const CACHE_TTL = 300;
const STALE_TTL = 86400;
const BACKUP_TTL = 604800;

// ========================================================================
// Military identification
// ========================================================================

const MILITARY_HEX_SET = new Set(
  (MILITARY_HEX_LIST as string[]).map((h: string) => h.toLowerCase()),
);

function isMilitaryHex(hexId: string | null | undefined): boolean {
  if (!hexId) return false;
  return MILITARY_HEX_SET.has(String(hexId).replace(/^~/, '').toLowerCase());
}

const MILITARY_PREFIXES = [
  'RCH', 'REACH', 'MOOSE', 'EVAC', 'DUSTOFF', 'PEDRO',
  'DUKE', 'HAVOC', 'KNIFE', 'WARHAWK', 'VIPER', 'RAGE', 'FURY',
  'SHELL', 'TEXACO', 'ARCO', 'ESSO', 'PETRO',
  'SENTRY', 'AWACS', 'MAGIC', 'DISCO', 'DARKSTAR',
  'COBRA', 'PYTHON', 'RAPTOR', 'EAGLE', 'HAWK', 'TALON',
  'BOXER', 'OMNI', 'TOPCAT', 'SKULL', 'REAPER', 'HUNTER',
  'ARMY', 'NAVY', 'USAF', 'USMC', 'USCG',
  'AE', 'CNV', 'PAT', 'SAM', 'EXEC',
  'OPS', 'CTF', 'TF',
  'NATO', 'GAF', 'RRF', 'RAF', 'FAF', 'IAF', 'RNLAF', 'BAF', 'DAF', 'HAF', 'PAF',
  'SWORD', 'LANCE', 'ARROW', 'SPARTAN',
  'RSAF', 'EMIRI', 'UAEAF', 'KAF', 'QAF', 'BAHAF', 'OMAAF',
  'IRIAF', 'IRG', 'IRGC',
  'TAF', 'TUAF',
  'RSD', 'RF', 'RFF', 'VKS',
  'CHN', 'PLAAF', 'PLA',
];

const AIRLINE_CODES = new Set([
  'SVA', 'QTR', 'THY', 'UAE', 'ETD', 'GFA', 'MEA', 'RJA', 'KAC', 'ELY',
  'IAW', 'IRA', 'MSR', 'SYR', 'PGT', 'AXB', 'FDB', 'KNE', 'FAD', 'ADY', 'OMA',
  'ABQ', 'ABY', 'NIA', 'FJA', 'SWR', 'HZA', 'OMS', 'EGF', 'NOS', 'SXD',
  'BAW', 'AFR', 'DLH', 'KLM', 'AUA', 'SAS', 'FIN', 'LOT', 'AZA', 'TAP', 'IBE',
  'VLG', 'RYR', 'EZY', 'WZZ', 'NOZ', 'BEL', 'AEE', 'ROT',
  'AIC', 'CPA', 'SIA', 'MAS', 'THA', 'VNM', 'JAL', 'ANA', 'KAL', 'AAR', 'EVA',
  'CAL', 'CCA', 'CES', 'CSN', 'HDA', 'CHH', 'CXA', 'GIA', 'PAL', 'SLK',
  'AAL', 'DAL', 'UAL', 'SWA', 'JBU', 'FFT', 'ASA', 'NKS', 'WJA', 'ACA',
  'FDX', 'UPS', 'GTI', 'ABW', 'CLX', 'MPH',
  'AIR', 'SKY', 'JET',
]);

function isMilitaryCallsign(callsign: string | null | undefined): boolean {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();
  for (const prefix of MILITARY_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }
  if (/^[A-Z]{4,}\d{1,3}$/.test(cs)) return true;
  if (/^[A-Z]{3}\d{1,2}$/.test(cs)) {
    const prefix = cs.slice(0, 3);
    if (!AIRLINE_CODES.has(prefix)) return true;
  }
  return false;
}

function detectAircraftType(callsign: string | null | undefined): string {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(cs)) return 'tanker';
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(cs)) return 'awacs';
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(cs)) return 'transport';
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO|RC|U2|SR)/.test(cs)) return 'reconnaissance';
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(cs)) return 'bomber';
  return 'unknown';
}

// ========================================================================
// Theater definitions
// ========================================================================

interface TheaterDef {
  id: string;
  name: string;
  bounds: { north: number; south: number; east: number; west: number };
  thresholds: { elevated: number; critical: number };
  strikeIndicators: { minTankers: number; minAwacs: number; minFighters: number };
}

const POSTURE_THEATERS: TheaterDef[] = [
  { id: 'iran-theater', name: 'Iran Theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', name: 'Taiwan Strait', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', name: 'Baltic Theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', name: 'Black Sea', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', name: 'Korean Peninsula', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', name: 'South China Sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', name: 'Eastern Mediterranean', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', name: 'Israel/Gaza', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', name: 'Yemen/Red Sea', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
];

// ========================================================================
// Flight fetching (OpenSky + Wingbits fallback)
// ========================================================================

interface RawFlight {
  id: string;
  callsign: string;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  speed: number;
  aircraftType: string;
}

async function fetchMilitaryFlightsFromOpenSky(): Promise<RawFlight[]> {
  const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
  const baseUrl = isSidecar
    ? 'https://opensky-network.org/api/states/all'
    : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

  if (!baseUrl) return [];

  const resp = await fetch(baseUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 WorldMonitor/1.0' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`OpenSky API error: ${resp.status}`);

  const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
  if (!data.states) return [];

  const flights: RawFlight[] = [];
  for (const state of data.states) {
    const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
      string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
    ];
    if (lat == null || lon == null || onGround) continue;
    if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

    flights.push({
      id: icao24,
      callsign: callsign?.trim() || '',
      lat, lon,
      altitude: altitude ?? 0,
      heading: heading ?? 0,
      speed: (velocity as number) ?? 0,
      aircraftType: detectAircraftType(callsign),
    });
  }
  return flights;
}

async function fetchMilitaryFlightsFromWingbits(): Promise<RawFlight[] | null> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return null;

  const areas = POSTURE_THEATERS.map((t) => ({
    alias: t.id,
    by: 'box',
    la: (t.bounds.north + t.bounds.south) / 2,
    lo: (t.bounds.east + t.bounds.west) / 2,
    w: Math.abs(t.bounds.east - t.bounds.west) * 60,
    h: Math.abs(t.bounds.north - t.bounds.south) * 60,
    unit: 'nm',
  }));

  try {
    const resp = await fetch('https://customer-api.wingbits.com/v1/flights', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(areas),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as Array<{ flights?: Array<Record<string, unknown>> }>;
    const flights: RawFlight[] = [];
    const seenIds = new Set<string>();

    for (const areaResult of data) {
      const flightList = Array.isArray(areaResult.flights || areaResult) ? (areaResult.flights || areaResult) as Array<Record<string, unknown>> : [];
      for (const f of flightList) {
        const icao24 = (f.h || f.icao24 || f.id) as string;
        if (!icao24 || seenIds.has(icao24)) continue;
        seenIds.add(icao24);
        const callsign = ((f.f || f.callsign || f.flight || '') as string).trim();
        if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;
        flights.push({
          id: icao24,
          callsign,
          lat: (f.la || f.latitude || f.lat) as number,
          lon: (f.lo || f.longitude || f.lon || f.lng) as number,
          altitude: (f.ab || f.altitude || f.alt || 0) as number,
          heading: (f.th || f.heading || f.track || 0) as number,
          speed: (f.gs || f.groundSpeed || f.speed || f.velocity || 0) as number,
          aircraftType: detectAircraftType(callsign),
        });
      }
    }
    return flights;
  } catch {
    return null;
  }
}

// ========================================================================
// Theater posture calculation
// ========================================================================

function calculatePostures(flights: RawFlight[]): TheaterPosture[] {
  return POSTURE_THEATERS.map((theater) => {
    const theaterFlights = flights.filter(
      (f) => f.lat >= theater.bounds.south && f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west && f.lon <= theater.bounds.east,
    );

    const total = theaterFlights.length;
    const byType = {
      tankers: theaterFlights.filter((f) => f.aircraftType === 'tanker').length,
      awacs: theaterFlights.filter((f) => f.aircraftType === 'awacs').length,
      fighters: theaterFlights.filter((f) => f.aircraftType === 'fighter').length,
    };

    const postureLevel = total >= theater.thresholds.critical
      ? 'critical'
      : total >= theater.thresholds.elevated
        ? 'elevated'
        : 'normal';

    const strikeCapable =
      byType.tankers >= theater.strikeIndicators.minTankers &&
      byType.awacs >= theater.strikeIndicators.minAwacs &&
      byType.fighters >= theater.strikeIndicators.minFighters;

    const ops: string[] = [];
    if (strikeCapable) ops.push('strike_capable');
    if (byType.tankers > 0) ops.push('aerial_refueling');
    if (byType.awacs > 0) ops.push('airborne_early_warning');

    return {
      theater: theater.id,
      postureLevel,
      activeFlights: total,
      trackedVessels: 0,
      activeOperations: ops,
      assessedAt: Date.now(),
    };
  });
}

// ========================================================================
// Handler export
// ========================================================================

export const militaryHandler: MilitaryServiceHandler = {
  async listMilitaryFlights(
    _ctx: ServerContext,
    req: ListMilitaryFlightsRequest,
  ): Promise<ListMilitaryFlightsResponse> {
    try {
      const bb = req.boundingBox;

      // If bounding box provided, fetch from OpenSky with bounds
      // Otherwise return empty (global fetch too expensive for a single RPC)
      if (!bb?.southWest || !bb?.northEast) return { flights: [], clusters: [], pagination: undefined };

      const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
      const baseUrl = isSidecar
        ? 'https://opensky-network.org/api/states/all'
        : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

      if (!baseUrl) return { flights: [], clusters: [], pagination: undefined };

      const params = new URLSearchParams();
      params.set('lamin', String(bb.southWest.latitude));
      params.set('lamax', String(bb.northEast.latitude));
      params.set('lomin', String(bb.southWest.longitude));
      params.set('lomax', String(bb.northEast.longitude));

      const url = `${baseUrl}${params.toString() ? '?' + params.toString() : ''}`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 WorldMonitor/1.0' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (!resp.ok) return { flights: [], clusters: [], pagination: undefined };

      const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
      if (!data.states) return { flights: [], clusters: [], pagination: undefined };

      const flights: ListMilitaryFlightsResponse['flights'] = [];
      for (const state of data.states) {
        const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
          string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
        ];
        if (lat == null || lon == null || onGround) continue;
        if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

        const aircraftType = detectAircraftType(callsign);
        const AIRCRAFT_TYPE_MAP: Record<string, string> = {
          tanker: 'MILITARY_AIRCRAFT_TYPE_TANKER',
          awacs: 'MILITARY_AIRCRAFT_TYPE_AWACS',
          transport: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
          reconnaissance: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
          drone: 'MILITARY_AIRCRAFT_TYPE_DRONE',
          bomber: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
        };

        flights.push({
          id: icao24,
          callsign: (callsign || '').trim(),
          hexCode: icao24,
          registration: '',
          aircraftType: AIRCRAFT_TYPE_MAP[aircraftType] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN',
          aircraftModel: '',
          operator: 'MILITARY_OPERATOR_OTHER',
          operatorCountry: '',
          location: { latitude: lat, longitude: lon },
          altitude: altitude ?? 0,
          heading: heading ?? 0,
          speed: (velocity as number) ?? 0,
          verticalRate: 0,
          onGround: false,
          squawk: '',
          origin: '',
          destination: '',
          lastSeenAt: Date.now(),
          firstSeenAt: 0,
          confidence: 'MILITARY_CONFIDENCE_LOW',
          isInteresting: false,
          note: '',
          enrichment: undefined,
        });
      }

      return { flights, clusters: [], pagination: undefined };
    } catch {
      return { flights: [], clusters: [], pagination: undefined };
    }
  },

  async listMilitaryVessels(
    _ctx: ServerContext,
    _req: ListMilitaryVesselsRequest,
  ): Promise<ListMilitaryVesselsResponse> {
    // Vessel tracking is client-side (AIS stream).
    return { vessels: [], clusters: [], pagination: undefined };
  },

  async getTheaterPosture(
    _ctx: ServerContext,
    _req: GetTheaterPostureRequest,
  ): Promise<GetTheaterPostureResponse> {
    // Check cache
    const cached = (await getCachedJson(CACHE_KEY)) as GetTheaterPostureResponse | null;
    if (cached) return cached;

    try {
      // Try OpenSky first, then Wingbits fallback
      let flights: RawFlight[];
      try {
        flights = await fetchMilitaryFlightsFromOpenSky();
      } catch {
        const wingbits = await fetchMilitaryFlightsFromWingbits();
        if (wingbits && wingbits.length > 0) {
          flights = wingbits;
        } else {
          throw new Error('Both OpenSky and Wingbits unavailable');
        }
      }

      const theaters = calculatePostures(flights);
      const result: GetTheaterPostureResponse = { theaters };

      await Promise.all([
        setCachedJson(CACHE_KEY, result, CACHE_TTL),
        setCachedJson(STALE_CACHE_KEY, result, STALE_TTL),
        setCachedJson(BACKUP_CACHE_KEY, result, BACKUP_TTL),
      ]);
      return result;
    } catch {
      // Fallback chain: stale -> backup -> empty
      const stale = (await getCachedJson(STALE_CACHE_KEY)) as GetTheaterPostureResponse | null;
      if (stale) return stale;
      const backup = (await getCachedJson(BACKUP_CACHE_KEY)) as GetTheaterPostureResponse | null;
      if (backup) return backup;
      return { theaters: [] };
    }
  },
};
