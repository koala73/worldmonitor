/**
 * Military service handler -- implements the generated
 * MilitaryServiceHandler interface with 7 RPCs:
 *   - ListMilitaryFlights   (OpenSky bounded query)
 *   - ListMilitaryVessels   (stub -- client-side fetches from AIS stream)
 *   - GetTheaterPosture     (OpenSky + Wingbits -> theater posture aggregation)
 *   - GetAircraftDetails    (Wingbits single aircraft lookup)
 *   - GetAircraftDetailsBatch (Wingbits batch aircraft lookup)
 *   - GetWingbitsStatus     (Wingbits API key check)
 *   - GetUSNIFleetReport    (USNI Fleet Tracker article parsing + caching)
 *
 * Consolidates legacy edge functions:
 *   api/theater-posture.js, api/wingbits/, api/usni-fleet.js
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
  GetAircraftDetailsRequest,
  GetAircraftDetailsResponse,
  GetAircraftDetailsBatchRequest,
  GetAircraftDetailsBatchResponse,
  GetWingbitsStatusRequest,
  GetWingbitsStatusResponse,
  AircraftDetails,
  GetUSNIFleetReportRequest,
  GetUSNIFleetReportResponse,
  USNIVessel,
  USNIStrikeGroup,
  BattleForceSummary,
  USNIFleetReport,
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
// USNI Fleet Tracker parsing (ported from api/usni-fleet.js)
// ========================================================================

const USNI_CACHE_KEY = 'usni-fleet:sebuf:v1';
const USNI_STALE_CACHE_KEY = 'usni-fleet:sebuf:stale:v1';
const USNI_CACHE_TTL = 21600; // 6 hours
const USNI_STALE_TTL = 604800; // 7 days

const HULL_TYPE_MAP: Record<string, string> = {
  CVN: 'carrier', CV: 'carrier',
  DDG: 'destroyer', CG: 'destroyer',
  LHD: 'amphibious', LHA: 'amphibious', LPD: 'amphibious', LSD: 'amphibious', LCC: 'amphibious',
  SSN: 'submarine', SSBN: 'submarine', SSGN: 'submarine',
  FFG: 'frigate', LCS: 'frigate',
  MCM: 'patrol', PC: 'patrol',
  AS: 'auxiliary', ESB: 'auxiliary', ESD: 'auxiliary',
  'T-AO': 'auxiliary', 'T-AKE': 'auxiliary', 'T-AOE': 'auxiliary',
  'T-ARS': 'auxiliary', 'T-ESB': 'auxiliary', 'T-EPF': 'auxiliary',
  'T-AGOS': 'research', 'T-AGS': 'research', 'T-AGM': 'research', AGOS: 'research',
};

function hullToVesselType(hull: string): string {
  if (!hull) return 'unknown';
  for (const [prefix, type] of Object.entries(HULL_TYPE_MAP)) {
    if (hull.startsWith(prefix)) return type;
  }
  return 'unknown';
}

function detectDeploymentStatus(text: string): string {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();
  if (lower.includes('deployed') || lower.includes('deployment')) return 'deployed';
  if (lower.includes('underway') || lower.includes('transiting') || lower.includes('transit')) return 'underway';
  if (lower.includes('homeport') || lower.includes('in port') || lower.includes('pierside') || lower.includes('returned')) return 'in-port';
  return 'unknown';
}

function extractHomePort(text: string): string | undefined {
  const match = text.match(/homeported (?:at|in) ([^.,]+)/i) || text.match(/home[ -]?ported (?:at|in) ([^.,]+)/i);
  return match ? match[1].trim() : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '\u2013')
    .replace(/\s+/g, ' ')
    .trim();
}

const REGION_COORDS: Record<string, { lat: number; lon: number }> = {
  'Philippine Sea': { lat: 18.0, lon: 130.0 },
  'South China Sea': { lat: 14.0, lon: 115.0 },
  'East China Sea': { lat: 28.0, lon: 125.0 },
  'Sea of Japan': { lat: 40.0, lon: 135.0 },
  'Arabian Sea': { lat: 18.0, lon: 63.0 },
  'Red Sea': { lat: 20.0, lon: 38.0 },
  'Mediterranean Sea': { lat: 35.0, lon: 18.0 },
  'Eastern Mediterranean': { lat: 34.5, lon: 33.0 },
  'Western Mediterranean': { lat: 37.0, lon: 3.0 },
  'Persian Gulf': { lat: 26.5, lon: 52.0 },
  'Gulf of Oman': { lat: 24.5, lon: 58.5 },
  'Gulf of Aden': { lat: 12.0, lon: 47.0 },
  'Caribbean Sea': { lat: 15.0, lon: -73.0 },
  'North Atlantic': { lat: 45.0, lon: -30.0 },
  'Atlantic Ocean': { lat: 30.0, lon: -40.0 },
  'Western Atlantic': { lat: 30.0, lon: -60.0 },
  'Pacific Ocean': { lat: 20.0, lon: -150.0 },
  'Eastern Pacific': { lat: 18.0, lon: -125.0 },
  'Western Pacific': { lat: 20.0, lon: 140.0 },
  'Indian Ocean': { lat: -5.0, lon: 75.0 },
  Antarctic: { lat: -70.0, lon: 20.0 },
  'Baltic Sea': { lat: 58.0, lon: 20.0 },
  'Black Sea': { lat: 43.5, lon: 34.0 },
  'Bay of Bengal': { lat: 14.0, lon: 87.0 },
  Yokosuka: { lat: 35.29, lon: 139.67 },
  Japan: { lat: 35.29, lon: 139.67 },
  Sasebo: { lat: 33.16, lon: 129.72 },
  Guam: { lat: 13.45, lon: 144.79 },
  'Pearl Harbor': { lat: 21.35, lon: -157.95 },
  'San Diego': { lat: 32.68, lon: -117.15 },
  Norfolk: { lat: 36.95, lon: -76.30 },
  Mayport: { lat: 30.39, lon: -81.40 },
  Bahrain: { lat: 26.23, lon: 50.55 },
  Rota: { lat: 36.63, lon: -6.35 },
  'Diego Garcia': { lat: -7.32, lon: 72.42 },
  Djibouti: { lat: 11.55, lon: 43.15 },
  Singapore: { lat: 1.35, lon: 103.82 },
  'Souda Bay': { lat: 35.49, lon: 24.08 },
  Naples: { lat: 40.84, lon: 14.25 },
};

function getRegionCoords(regionText: string): { lat: number; lon: number } | null {
  const normalized = regionText
    .replace(/^(In the|In|The)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (REGION_COORDS[normalized]) return REGION_COORDS[normalized];
  const lower = normalized.toLowerCase();
  for (const [key, coords] of Object.entries(REGION_COORDS)) {
    if (key.toLowerCase() === lower || lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return coords;
    }
  }
  return null;
}

function parseLeadingInteger(text: string): number | undefined {
  const match = text.match(/\d{1,3}(?:,\d{3})*/);
  if (!match) return undefined;
  return parseInt(match[0].replace(/,/g, ''), 10);
}

function extractBattleForceSummary(tableHtml: string): BattleForceSummary | undefined {
  const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  if (rows.length < 2) return undefined;

  const headerCells = Array.from(rows[0][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map((m) => stripHtml(m[1]).toLowerCase());
  const valueCells = Array.from(rows[1][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map((m) => parseLeadingInteger(stripHtml(m[1])));

  const summary: BattleForceSummary = { totalShips: 0, deployed: 0, underway: 0 };
  let matched = false;

  for (let idx = 0; idx < headerCells.length; idx++) {
    const label = headerCells[idx] || '';
    const value = valueCells[idx];
    if (!Number.isFinite(value)) continue;

    if (label.includes('battle force') || label.includes('total') || label.includes('ships')) {
      summary.totalShips = value!;
      matched = true;
    } else if (label.includes('deployed')) {
      summary.deployed = value!;
      matched = true;
    } else if (label.includes('underway')) {
      summary.underway = value!;
      matched = true;
    }
  }

  if (matched) return summary;

  // Fallback for unexpected table layouts
  const tableText = stripHtml(tableHtml);
  const totalMatch = tableText.match(/(?:battle[- ]?force|ships?|total)[^0-9]{0,40}(\d{1,3}(?:,\d{3})*)/i)
    || tableText.match(/(\d{1,3}(?:,\d{3})*)\s*(?:battle[- ]?force|ships?|total)/i);
  const deployedMatch = tableText.match(/deployed[^0-9]{0,40}(\d{1,3}(?:,\d{3})*)/i)
    || tableText.match(/(\d{1,3}(?:,\d{3})*)\s*deployed/i);
  const underwayMatch = tableText.match(/underway[^0-9]{0,40}(\d{1,3}(?:,\d{3})*)/i)
    || tableText.match(/(\d{1,3}(?:,\d{3})*)\s*underway/i);

  if (!totalMatch && !deployedMatch && !underwayMatch) return undefined;
  return {
    totalShips: totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0,
    deployed: deployedMatch ? parseInt(deployedMatch[1].replace(/,/g, ''), 10) : 0,
    underway: underwayMatch ? parseInt(underwayMatch[1].replace(/,/g, ''), 10) : 0,
  };
}

interface ParsedStrikeGroup {
  name: string;
  carrier?: string;
  airWing?: string;
  destroyerSquadron?: string;
  escorts: string[];
}

function parseUSNIArticle(
  html: string,
  articleUrl: string,
  articleDate: string,
  articleTitle: string,
): USNIFleetReport {
  const warnings: string[] = [];
  const vessels: USNIVessel[] = [];
  const vesselByRegionHull = new Map<string, USNIVessel>();
  const strikeGroups: ParsedStrikeGroup[] = [];
  const regionsSet = new Set<string>();

  // Extract battle force summary from first table
  let battleForceSummary: BattleForceSummary | undefined;
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) {
    battleForceSummary = extractBattleForceSummary(tableMatch[1]);
  }

  // Split by H2 for region sections
  const h2Parts = html.split(/<h2[^>]*>/i);

  for (let i = 1; i < h2Parts.length; i++) {
    const part = h2Parts[i];
    const h2EndIdx = part.indexOf('</h2>');
    if (h2EndIdx === -1) continue;
    const regionRaw = stripHtml(part.substring(0, h2EndIdx));
    const regionContent = part.substring(h2EndIdx + 5);

    const regionName = regionRaw
      .replace(/^(In the|In|The)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!regionName) continue;
    regionsSet.add(regionName);

    const coords = getRegionCoords(regionName);
    if (!coords) {
      warnings.push(`Unknown region: "${regionName}"`);
    }
    const regionLat = coords?.lat ?? 0;
    const regionLon = coords?.lon ?? 0;

    // Detect H3 strike groups within this region
    const h3Parts = regionContent.split(/<h3[^>]*>/i);

    let currentStrikeGroup: ParsedStrikeGroup | null = null;

    for (let j = 0; j < h3Parts.length; j++) {
      const section = h3Parts[j];

      if (j > 0) {
        const h3EndIdx = section.indexOf('</h3>');
        if (h3EndIdx !== -1) {
          const sgName = stripHtml(section.substring(0, h3EndIdx));
          if (sgName) {
            currentStrikeGroup = {
              name: sgName,
              carrier: undefined,
              airWing: undefined,
              destroyerSquadron: undefined,
              escorts: [],
            };
            strikeGroups.push(currentStrikeGroup);
          }
        }
      }

      const shipRegex = /USS\s+<(?:em|i)>([^<]+)<\/(?:em|i)>\s*\(([^)]+)\)/gi;
      let match: RegExpExecArray | null;
      const sectionText = stripHtml(section);
      const deploymentStatus = detectDeploymentStatus(sectionText);
      const homePort = extractHomePort(sectionText);
      const activityDesc = sectionText.length > 10 ? sectionText.substring(0, 200).trim() : '';

      const upsertVessel = (entry: USNIVessel) => {
        const key = `${entry.region}|${entry.hullNumber.toUpperCase()}`;
        const existing = vesselByRegionHull.get(key);
        if (existing) {
          if (!existing.strikeGroup && entry.strikeGroup) existing.strikeGroup = entry.strikeGroup;
          if (existing.deploymentStatus === 'unknown' && entry.deploymentStatus !== 'unknown') {
            existing.deploymentStatus = entry.deploymentStatus;
          }
          if (!existing.homePort && entry.homePort) existing.homePort = entry.homePort;
          if ((!existing.activityDescription || existing.activityDescription.length < (entry.activityDescription || '').length) && entry.activityDescription) {
            existing.activityDescription = entry.activityDescription;
          }
          return;
        }
        vessels.push(entry);
        vesselByRegionHull.set(key, entry);
      };

      while ((match = shipRegex.exec(section)) !== null) {
        const shipName = match[1].trim();
        const hullNumber = match[2].trim();
        const vesselType = hullToVesselType(hullNumber);

        if (vesselType === 'carrier' && currentStrikeGroup) {
          currentStrikeGroup.carrier = `USS ${shipName} (${hullNumber})`;
        }
        if (currentStrikeGroup) {
          currentStrikeGroup.escorts.push(`USS ${shipName} (${hullNumber})`);
        }

        upsertVessel({
          name: `USS ${shipName}`,
          hullNumber,
          vesselType,
          region: regionName,
          regionLat,
          regionLon,
          deploymentStatus,
          homePort: homePort || '',
          strikeGroup: currentStrikeGroup?.name || '',
          activityDescription: activityDesc,
          articleUrl,
          articleDate,
        });
      }

      // Also match USNS ships
      const usnsRegex = /USNS\s+<(?:em|i)>([^<]+)<\/(?:em|i)>\s*\(([^)]+)\)/gi;
      while ((match = usnsRegex.exec(section)) !== null) {
        const shipName = match[1].trim();
        const hullNumber = match[2].trim();
        upsertVessel({
          name: `USNS ${shipName}`,
          hullNumber,
          vesselType: hullToVesselType(hullNumber),
          region: regionName,
          regionLat,
          regionLon,
          deploymentStatus,
          homePort: homePort || '',
          strikeGroup: currentStrikeGroup?.name || '',
          activityDescription: activityDesc,
          articleUrl,
          articleDate,
        });
      }
    }
  }

  // Extract air wings from strike group content
  for (const sg of strikeGroups) {
    const wingMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Carrier Air Wing\\s*(\\w+)', 'i'));
    if (wingMatch) sg.airWing = `Carrier Air Wing ${wingMatch[1]}`;
    const desronMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Destroyer Squadron\\s*(\\w+)', 'i'));
    if (desronMatch) sg.destroyerSquadron = `Destroyer Squadron ${desronMatch[1]}`;
    sg.escorts = Array.from(new Set(sg.escorts));
  }

  const protoStrikeGroups: USNIStrikeGroup[] = strikeGroups.map((sg) => ({
    name: sg.name,
    carrier: sg.carrier || '',
    airWing: sg.airWing || '',
    destroyerSquadron: sg.destroyerSquadron || '',
    escorts: sg.escorts,
  }));

  return {
    articleUrl,
    articleDate,
    articleTitle,
    battleForceSummary,
    vessels,
    strikeGroups: protoStrikeGroups,
    regions: Array.from(regionsSet),
    parsingWarnings: warnings,
    timestamp: Date.now(),
  };
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

  // ======================================================================
  // Wingbits aircraft enrichment RPCs (replaces api/wingbits/ proxy)
  // ======================================================================

  async getAircraftDetails(
    _ctx: ServerContext,
    req: GetAircraftDetailsRequest,
  ): Promise<GetAircraftDetailsResponse> {
    const apiKey = process.env.WINGBITS_API_KEY;
    if (!apiKey) return { details: undefined, configured: false };

    const icao24 = req.icao24.toLowerCase();
    try {
      const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        return { details: undefined, configured: true };
      }

      const data = (await resp.json()) as Record<string, unknown>;
      return {
        details: mapWingbitsDetails(icao24, data),
        configured: true,
      };
    } catch {
      return { details: undefined, configured: true };
    }
  },

  async getAircraftDetailsBatch(
    _ctx: ServerContext,
    req: GetAircraftDetailsBatchRequest,
  ): Promise<GetAircraftDetailsBatchResponse> {
    const apiKey = process.env.WINGBITS_API_KEY;
    if (!apiKey) return { results: {}, fetched: 0, requested: 0, configured: false };

    const limitedList = req.icao24s.slice(0, 20).map((id) => id.toLowerCase());
    const results: Record<string, AircraftDetails> = {};

    const fetches = limitedList.map(async (icao24) => {
      try {
        const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
          headers: { 'x-api-key': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const data = (await resp.json()) as Record<string, unknown>;
          return { icao24, details: mapWingbitsDetails(icao24, data) };
        }
      } catch { /* skip failed lookups */ }
      return null;
    });

    const fetchResults = await Promise.all(fetches);
    for (const r of fetchResults) {
      if (r) results[r.icao24] = r.details;
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
      configured: true,
    };
  },

  async getWingbitsStatus(
    _ctx: ServerContext,
    _req: GetWingbitsStatusRequest,
  ): Promise<GetWingbitsStatusResponse> {
    const apiKey = process.env.WINGBITS_API_KEY;
    return { configured: !!apiKey };
  },

  async getUSNIFleetReport(
    _ctx: ServerContext,
    req: GetUSNIFleetReportRequest,
  ): Promise<GetUSNIFleetReportResponse> {
    try {
      // Check cache (skip on force_refresh)
      if (!req.forceRefresh) {
        const cached = (await getCachedJson(USNI_CACHE_KEY)) as USNIFleetReport | null;
        if (cached) {
          console.log('[USNI Fleet] Cache hit');
          return { report: cached, cached: true, stale: false, error: '' };
        }
      }

      console.log('[USNI Fleet] Fetching from WordPress API...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      let wpData: Array<Record<string, unknown>>;
      try {
        const response = await fetch(
          'https://news.usni.org/wp-json/wp/v2/posts?categories=4137&per_page=1',
          {
            headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/2.0' },
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`USNI API error: ${response.status}`);
        wpData = (await response.json()) as Array<Record<string, unknown>>;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!wpData || !wpData.length) {
        return { report: undefined, cached: false, stale: false, error: 'No USNI fleet tracker articles found' };
      }

      const post = wpData[0];
      const articleUrl = (post.link as string) || `https://news.usni.org/?p=${post.id}`;
      const articleDate = (post.date as string) || new Date().toISOString();
      const articleTitle = stripHtml(((post.title as Record<string, string>)?.rendered) || 'USNI Fleet Tracker');
      const htmlContent = ((post.content as Record<string, string>)?.rendered) || '';

      if (!htmlContent) {
        return { report: undefined, cached: false, stale: false, error: 'Empty article content' };
      }

      const report = parseUSNIArticle(htmlContent, articleUrl, articleDate, articleTitle);
      console.log(`[USNI Fleet] Parsed: ${report.vessels.length} vessels, ${report.strikeGroups.length} CSGs, ${report.regions.length} regions`);

      if (report.parsingWarnings.length > 0) {
        console.warn('[USNI Fleet] Warnings:', report.parsingWarnings.join('; '));
      }

      await Promise.all([
        setCachedJson(USNI_CACHE_KEY, report, USNI_CACHE_TTL),
        setCachedJson(USNI_STALE_CACHE_KEY, report, USNI_STALE_TTL),
      ]);

      return { report, cached: false, stale: false, error: '' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[USNI Fleet] Error:', message);

      const stale = (await getCachedJson(USNI_STALE_CACHE_KEY)) as USNIFleetReport | null;
      if (stale) {
        console.log('[USNI Fleet] Returning stale cached data');
        return { report: stale, cached: true, stale: true, error: 'Using cached data' };
      }

      return { report: undefined, cached: false, stale: false, error: message };
    }
  },
};

// ========================================================================
// Wingbits response mapper
// ========================================================================

function mapWingbitsDetails(icao24: string, data: Record<string, unknown>): AircraftDetails {
  return {
    icao24,
    registration: String(data.registration ?? ''),
    manufacturerIcao: String(data.manufacturerIcao ?? ''),
    manufacturerName: String(data.manufacturerName ?? ''),
    model: String(data.model ?? ''),
    typecode: String(data.typecode ?? ''),
    serialNumber: String(data.serialNumber ?? ''),
    icaoAircraftType: String(data.icaoAircraftType ?? ''),
    operator: String(data.operator ?? ''),
    operatorCallsign: String(data.operatorCallsign ?? ''),
    operatorIcao: String(data.operatorIcao ?? ''),
    owner: String(data.owner ?? ''),
    built: String(data.built ?? ''),
    engines: String(data.engines ?? ''),
    categoryDescription: String(data.categoryDescription ?? ''),
  };
}
