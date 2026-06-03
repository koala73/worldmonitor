import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
  MilitaryOperator,
  MilitaryConfidence,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const REDIS_CACHE_KEY = 'military:flights:v1';
const REDIS_CACHE_TTL = 1200; // 20 min — bound RapidAPI quota burn (37 hub calls/cycle)

/** Snap a coordinate to a grid step so nearby bbox values share cache entries. */
const quantize = (v: number, step: number) => Math.round(v / step) * step;
const BBOX_GRID_STEP = 1; // 1-degree grid (~111 km at equator)

interface RequestBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

function getRelayRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

function normalizeBounds(req: ListMilitaryFlightsRequest): RequestBounds {
  return {
    south: Math.min(req.swLat, req.neLat),
    north: Math.max(req.swLat, req.neLat),
    west: Math.min(req.swLon, req.neLon),
    east: Math.max(req.swLon, req.neLon),
  };
}

function filterFlightsToBounds(
  flights: ListMilitaryFlightsResponse['flights'],
  bounds: RequestBounds,
): ListMilitaryFlightsResponse['flights'] {
  return flights.filter((flight) => {
    const lat = flight.location?.latitude;
    const lon = flight.location?.longitude;
    if (lat == null || lon == null) return false;
    return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// ADSBExchange (RapidAPI) — primary source, authoritative military feed.
// On Redis cache miss, this is what we hit; results are cached for REDIS_CACHE_TTL.
// ──────────────────────────────────────────────────────────────────────────

const ADSBX_HOST = 'adsbexchange-com1.p.rapidapi.com';
const ADSBX_MIL_URL = `https://${ADSBX_HOST}/v2/mil/`;

// "All aircraft within radius" endpoint — layers civilian traffic on top of the
// military feed for visual density (product request). dist is in nautical miles
// (ADSBX caps at 250).
const adsbxRadiusUrl = (lat: number, lon: number, distNm: number) =>
  `https://${ADSBX_HOST}/v2/lat/${lat}/lon/${lon}/dist/${distNm}/`;

// Globally-spread regions sampled for civilian aircraft. Each region's
// contribution is capped (CIVILIAN_MAX_PER_REGION) so a single dense airspace
// (e.g. Central Europe — the busiest on Earth) can't crowd out every other
// region once the client applies its own pin cap. One RapidAPI call per region
// per cache miss, shared across all clients via the REDIS_CACHE_TTL window.
// ADSBExchange caps the radius at 250 nm, so wide-coverage = many circles over
// major aviation hubs (empty interiors have little ADS-B receiver coverage
// anyway). Heavy emphasis on Asia / Africa / Canada / South America, which a
// few large circles previously left almost empty. Each entry = 1 RapidAPI call
// per cache miss, shared across all clients via REDIS_CACHE_TTL.
const CIVILIAN_REGIONS: Array<{ lat: number; lon: number; dist: number }> = [
  // — North America —
  { lat: 40.7, lon: -74.0, dist: 250 },   // US East (New York)
  { lat: 39.0, lon: -98.0, dist: 250 },   // US Central
  { lat: 34.0, lon: -118.2, dist: 250 },  // US West (Los Angeles)
  { lat: 26.0, lon: -80.2, dist: 250 },   // US Southeast (Miami)
  { lat: 43.7, lon: -79.4, dist: 250 },   // Canada East (Toronto)
  { lat: 49.2, lon: -123.1, dist: 250 },  // Canada West (Vancouver)
  { lat: 51.0, lon: -114.1, dist: 250 },  // Canada Central (Calgary)
  { lat: 19.4, lon: -99.1, dist: 250 },   // Mexico City
  // — South America —
  { lat: -23.5, lon: -46.6, dist: 250 },  // São Paulo
  { lat: -34.6, lon: -58.4, dist: 250 },  // Buenos Aires
  { lat: 4.7, lon: -74.1, dist: 250 },    // Bogotá
  { lat: -12.0, lon: -77.0, dist: 250 },  // Lima
  { lat: -33.4, lon: -70.7, dist: 250 },  // Santiago
  // — Europe —
  { lat: 51.5, lon: -0.1, dist: 250 },    // Western Europe (London)
  { lat: 50.1, lon: 8.7, dist: 250 },     // Central Europe (Frankfurt)
  { lat: 48.0, lon: 30.0, dist: 250 },    // Eastern Europe / Black Sea
  // — Africa —
  { lat: 30.0, lon: 31.2, dist: 250 },    // Cairo
  { lat: 6.5, lon: 3.3, dist: 250 },      // Lagos
  { lat: 33.6, lon: -7.6, dist: 250 },    // Casablanca
  { lat: -1.3, lon: 36.8, dist: 250 },    // Nairobi
  { lat: -26.1, lon: 28.0, dist: 250 },   // Johannesburg
  { lat: 9.0, lon: 38.7, dist: 250 },     // Addis Ababa
  // — Middle East —
  { lat: 25.2, lon: 55.3, dist: 250 },    // Dubai
  { lat: 41.0, lon: 29.0, dist: 250 },    // Istanbul
  // — Asia —
  { lat: 28.6, lon: 77.2, dist: 250 },    // Delhi
  { lat: 19.1, lon: 72.9, dist: 250 },    // Mumbai
  { lat: 13.0, lon: 80.2, dist: 250 },    // Chennai (South India)
  { lat: 24.9, lon: 67.1, dist: 250 },    // Karachi
  { lat: 40.0, lon: 116.4, dist: 250 },   // Beijing
  { lat: 31.2, lon: 121.5, dist: 250 },   // Shanghai
  { lat: 22.8, lon: 113.5, dist: 250 },   // Hong Kong / Guangzhou
  { lat: 37.5, lon: 127.0, dist: 250 },   // Seoul
  { lat: 35.7, lon: 139.7, dist: 250 },   // Tokyo
  { lat: 13.7, lon: 100.5, dist: 250 },   // Bangkok
  // — SE Asia / Oceania —
  { lat: 1.5, lon: 103.8, dist: 250 },    // Singapore / Kuala Lumpur
  { lat: -6.2, lon: 106.8, dist: 250 },   // Jakarta
  { lat: -33.9, lon: 151.2, dist: 250 },  // Sydney
];

// Max civilian aircraft taken from any single region. Keeps the global picture
// balanced rather than dominated by whichever airspace happens to be busiest.
const CIVILIAN_MAX_PER_REGION = 120;

/** ICAO type code → high-level category enum string (subset of common military types). */
const ICAO_TYPE_TO_ENUM: Record<string, MilitaryAircraftType> = {
  // Tankers
  K35R: 'MILITARY_AIRCRAFT_TYPE_TANKER', K35E: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  K35T: 'MILITARY_AIRCRAFT_TYPE_TANKER', KC10: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  KC30: 'MILITARY_AIRCRAFT_TYPE_TANKER', KC46: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  KDC1: 'MILITARY_AIRCRAFT_TYPE_TANKER', VC10: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  A332: 'MILITARY_AIRCRAFT_TYPE_TANKER', A310: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  // AWACS / battle management
  E3: 'MILITARY_AIRCRAFT_TYPE_AWACS', E3CF: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  E3TF: 'MILITARY_AIRCRAFT_TYPE_AWACS', E737: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  E2: 'MILITARY_AIRCRAFT_TYPE_AWACS', E2D: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  E6: 'MILITARY_AIRCRAFT_TYPE_AWACS', E8: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  // ISR / patrol
  U2: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE', RC35: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
  P3: 'MILITARY_AIRCRAFT_TYPE_PATROL', P8: 'MILITARY_AIRCRAFT_TYPE_PATROL',
  RC1: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE', E11: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
  // UAVs
  MQ9: 'MILITARY_AIRCRAFT_TYPE_DRONE', MQ1: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  RQ1: 'MILITARY_AIRCRAFT_TYPE_DRONE', RQ4: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  MQ4: 'MILITARY_AIRCRAFT_TYPE_DRONE', MQ25: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  // Bombers
  B1: 'MILITARY_AIRCRAFT_TYPE_BOMBER', B2: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  B52: 'MILITARY_AIRCRAFT_TYPE_BOMBER', TU95: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  TU22: 'MILITARY_AIRCRAFT_TYPE_BOMBER', TU60: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  H6: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  // Fighters / attack
  F15: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', F16: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  F18: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', F22: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  F35: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', A10: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  EUFI: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', TYPH: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  RAFL: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', GR4: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  J10: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', J11: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  J20: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', JH7: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  SU25: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', SU27: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  SU30: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', SU34: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  SU35: 'MILITARY_AIRCRAFT_TYPE_FIGHTER', SU57: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  // Transport / cargo
  C17: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', C5: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  C5M: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', C130: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  C30J: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', C160: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  A400: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', C295: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  C212: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', CN35: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  C40: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', C2: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  AN12: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', AN26: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  AN72: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', IL76: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  Y8: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', Y9: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  Y20: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  // VIP
  C32: 'MILITARY_AIRCRAFT_TYPE_VIP', C32A: 'MILITARY_AIRCRAFT_TYPE_VIP',
  C37: 'MILITARY_AIRCRAFT_TYPE_VIP', GLF5: 'MILITARY_AIRCRAFT_TYPE_VIP',
  GLF4: 'MILITARY_AIRCRAFT_TYPE_VIP', GLEX: 'MILITARY_AIRCRAFT_TYPE_VIP',
  // Helicopters
  H60: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', S70: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  H47: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', H53: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  H1: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', H64: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  EC35: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', AS65: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  NH90: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', PUMA: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  EH10: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', AS32: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  LYNX: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER', H145: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  H225: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
};

/** Lowercase callsign category (from detectAircraftType) → enum string. */
const CATEGORY_TO_ENUM: Record<string, MilitaryAircraftType> = {
  tanker: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  awacs: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  transport: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  reconnaissance: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
  drone: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  bomber: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  fighter: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  patrol: 'MILITARY_AIRCRAFT_TYPE_PATROL',
};

/** Hex prefix → operator + country (covers the most common military air arms). */
const HEX_RANGES: Array<{ start: number; end: number; operator: MilitaryOperator; country: string }> = [
  { start: 0xADF7C8, end: 0xAFFFFF, operator: 'MILITARY_OPERATOR_USAF', country: 'USA' },
  { start: 0x400000, end: 0x40003F, operator: 'MILITARY_OPERATOR_RAF', country: 'UK' },
  { start: 0x43C000, end: 0x43CFFF, operator: 'MILITARY_OPERATOR_RAF', country: 'UK' },
  { start: 0x3AA000, end: 0x3AFFFF, operator: 'MILITARY_OPERATOR_FAF', country: 'France' },
  { start: 0x3B7000, end: 0x3BFFFF, operator: 'MILITARY_OPERATOR_FAF', country: 'France' },
  { start: 0x3EA000, end: 0x3EBFFF, operator: 'MILITARY_OPERATOR_GAF', country: 'Germany' },
  { start: 0x3F4000, end: 0x3FBFFF, operator: 'MILITARY_OPERATOR_GAF', country: 'Germany' },
  { start: 0x738A00, end: 0x738BFF, operator: 'MILITARY_OPERATOR_IAF', country: 'Israel' },
  { start: 0x4D0000, end: 0x4D03FF, operator: 'MILITARY_OPERATOR_NATO', country: 'NATO' },
  { start: 0x33FF00, end: 0x33FFFF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Italy' },
  { start: 0x350000, end: 0x3503FF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Spain' },
  { start: 0x480000, end: 0x480FFF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Netherlands' },
  { start: 0x4B8200, end: 0x4B82FF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Turkey' },
  { start: 0x7CF800, end: 0x7CFAFF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Australia' },
  { start: 0xC2D000, end: 0xC2DFFF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Canada' },
  { start: 0x468000, end: 0x4683FF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Greece' },
  { start: 0x478100, end: 0x4781FF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Norway' },
  { start: 0x44F000, end: 0x44FFFF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Belgium' },
  { start: 0x4B7000, end: 0x4B7FFF, operator: 'MILITARY_OPERATOR_OTHER', country: 'Switzerland' },
  { start: 0x48D800, end: 0x48D87F, operator: 'MILITARY_OPERATOR_OTHER', country: 'Poland' },
];

function lookupHexOperator(hex: string): { operator: MilitaryOperator; country: string } {
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return { operator: 'MILITARY_OPERATOR_OTHER', country: '' };
  for (const r of HEX_RANGES) {
    if (n >= r.start && n <= r.end) return { operator: r.operator, country: r.country };
  }
  return { operator: 'MILITARY_OPERATOR_OTHER', country: '' };
}

function classifyAircraftType(typeCode: string, callsign: string): MilitaryAircraftType {
  const tc = (typeCode || '').toUpperCase();
  if (tc && ICAO_TYPE_TO_ENUM[tc]) return ICAO_TYPE_TO_ENUM[tc];
  const category = detectAircraftType(callsign || '');
  return CATEGORY_TO_ENUM[category] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN';
}

interface ADSBXAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  dbFlags?: number;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  seen?: number;
}

interface ADSBXResponse {
  ac?: ADSBXAircraft[];
  msg?: string;
  total?: number;
}

async function fetchADSBExchangeFlights(): Promise<ListMilitaryFlightsResponse['flights'] | null> {
  const key = process.env.RAPIDAPI_KEY || process.env.ADSBX_API_KEY;
  if (!key) {
    console.warn('[military-flights] RAPIDAPI_KEY not configured — skipping ADSBX');
    return null;
  }

  let resp: Response;
  try {
    resp = await fetch(ADSBX_MIL_URL, {
      headers: {
        'x-rapidapi-host': ADSBX_HOST,
        'x-rapidapi-key': key,
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[military-flights] ADSBX fetch failed:', (err as Error).message);
    return null;
  }

  if (!resp.ok) {
    console.warn(`[military-flights] ADSBX HTTP ${resp.status}`);
    return null;
  }

  const data = (await resp.json()) as ADSBXResponse;
  const acs = Array.isArray(data?.ac) ? data.ac : [];

  const flights: ListMilitaryFlightsResponse['flights'] = [];
  const now = Date.now();

  for (const ac of acs) {
    const hex = String(ac.hex || '').toLowerCase();
    if (!hex) continue;

    const lat = typeof ac.lat === 'number' ? ac.lat : null;
    const lon = typeof ac.lon === 'number' ? ac.lon : null;
    if (lat == null || lon == null) continue; // skip aircraft with no position

    const callsign = String(ac.flight || '').trim();
    const registration = String(ac.r || '').trim();
    const typeCode = String(ac.t || '').trim().toUpperCase();

    const altRaw = ac.alt_baro;
    const onGround = altRaw === 'ground';
    const altitude = onGround ? 0 : (typeof altRaw === 'number' ? altRaw : 0);
    const speed = typeof ac.gs === 'number' ? Math.round(ac.gs) : 0;
    const heading = typeof ac.track === 'number' ? ac.track : 0;
    const verticalRate = typeof ac.baro_rate === 'number'
      ? Math.round(ac.baro_rate)
      : (typeof ac.geom_rate === 'number' ? Math.round(ac.geom_rate) : 0);
    const squawk = String(ac.squawk || '');
    const seenSec = typeof ac.seen === 'number' ? ac.seen : 0;
    const lastSeenAt = Math.floor((now - Math.round(seenSec * 1000)) / 1000); // seconds since epoch

    const { operator, country } = lookupHexOperator(hex);
    const aircraftType = classifyAircraftType(typeCode, callsign);
    const isInteresting = (typeof ac.dbFlags === 'number' && (ac.dbFlags & 2) === 2)
      || aircraftType === 'MILITARY_AIRCRAFT_TYPE_BOMBER'
      || aircraftType === 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE'
      || aircraftType === 'MILITARY_AIRCRAFT_TYPE_AWACS';

    flights.push({
      id: `adsbx-${hex}`,
      callsign: callsign || `MIL-${hex.substring(0, 4).toUpperCase()}`,
      hexCode: hex.toUpperCase(),
      registration,
      aircraftType,
      aircraftModel: typeCode,
      operator,
      operatorCountry: country,
      location: { latitude: lat, longitude: lon },
      altitude,
      heading,
      speed,
      verticalRate,
      onGround,
      squawk,
      origin: '',
      destination: '',
      lastSeenAt,
      firstSeenAt: 0,
      confidence: 'MILITARY_CONFIDENCE_HIGH' as MilitaryConfidence,
      isInteresting,
      note: '',
      enrichment: undefined,
    });
  }

  console.log(`[military-flights] ADSBX returned ${acs.length} aircraft (${flights.length} with positions)`);
  return flights.length > 0 ? flights : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Civilian traffic — sampled from ADSBX's "all aircraft in radius" endpoint
// over a small set of busy regions. Aircraft ADSBX itself tags military
// (dbFlags bit 1) are skipped here and left to the authoritative /v2/mil/ feed.
// Tagged note: "Civilian" so the detail sheet can distinguish them.
// ──────────────────────────────────────────────────────────────────────────

async function fetchADSBExchangeCivilianFlights(): Promise<ListMilitaryFlightsResponse['flights']> {
  const key = process.env.RAPIDAPI_KEY || process.env.ADSBX_API_KEY;
  if (!key) return [];

  const now = Date.now();
  // Track hexes seen across all regions so the same aircraft (e.g. near a
  // region boundary) isn't double-counted, and so military hexes are skipped.
  const seen = new Set<string>();

  const results = await Promise.allSettled(
    CIVILIAN_REGIONS.map(async (region) => {
      const resp = await fetch(adsbxRadiusUrl(region.lat, region.lon, region.dist), {
        headers: {
          'x-rapidapi-host': ADSBX_HOST,
          'x-rapidapi-key': key,
          Accept: 'application/json',
          'User-Agent': CHROME_UA,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`ADSBX radius HTTP ${resp.status}`);
      return (await resp.json()) as ADSBXResponse;
    }),
  );

  // One bucket per region, each capped at CIVILIAN_MAX_PER_REGION.
  const regionBuckets: ListMilitaryFlightsResponse['flights'][] = [];

  for (const r of results) {
    const bucket: ListMilitaryFlightsResponse['flights'] = [];
    regionBuckets.push(bucket);
    if (r.status !== 'fulfilled') {
      console.warn('[military-flights] civilian region failed:', (r.reason as Error)?.message);
      continue;
    }
    const acs = Array.isArray(r.value?.ac) ? r.value.ac : [];
    for (const ac of acs) {
      if (bucket.length >= CIVILIAN_MAX_PER_REGION) break;
      const hex = String(ac.hex || '').toLowerCase();
      if (!hex || seen.has(hex)) continue;

      // Leave ADSBX-flagged military aircraft to the authoritative /v2/mil/ feed.
      if (typeof ac.dbFlags === 'number' && (ac.dbFlags & 1) === 1) continue;

      const lat = typeof ac.lat === 'number' ? ac.lat : null;
      const lon = typeof ac.lon === 'number' ? ac.lon : null;
      if (lat == null || lon == null) continue;

      const callsign = String(ac.flight || '').trim();
      const registration = String(ac.r || '').trim();
      const typeCode = String(ac.t || '').trim().toUpperCase();

      const altRaw = ac.alt_baro;
      const onGround = altRaw === 'ground';
      const altitude = onGround ? 0 : (typeof altRaw === 'number' ? altRaw : 0);
      const speed = typeof ac.gs === 'number' ? Math.round(ac.gs) : 0;
      const heading = typeof ac.track === 'number' ? ac.track : 0;
      const verticalRate = typeof ac.baro_rate === 'number'
        ? Math.round(ac.baro_rate)
        : (typeof ac.geom_rate === 'number' ? Math.round(ac.geom_rate) : 0);
      const squawk = String(ac.squawk || '');
      const seenSec = typeof ac.seen === 'number' ? ac.seen : 0;
      const lastSeenAt = Math.floor((now - Math.round(seenSec * 1000)) / 1000);

      const { operator, country } = lookupHexOperator(hex);

      seen.add(hex);
      bucket.push({
        id: `adsbx-${hex}`,
        callsign: callsign || `CIV-${hex.substring(0, 4).toUpperCase()}`,
        hexCode: hex.toUpperCase(),
        registration,
        aircraftType: classifyAircraftType(typeCode, callsign),
        aircraftModel: typeCode,
        operator,
        operatorCountry: country,
        location: { latitude: lat, longitude: lon },
        altitude,
        heading,
        speed,
        verticalRate,
        onGround,
        squawk,
        origin: '',
        destination: '',
        lastSeenAt,
        firstSeenAt: 0,
        confidence: 'MILITARY_CONFIDENCE_LOW' as MilitaryConfidence,
        isInteresting: false,
        note: 'Civilian',
        enrichment: undefined,
      });
    }
  }

  // Round-robin interleave across regions so that when a client applies its own
  // pin cap, the truncation thins every region evenly instead of dropping whole
  // trailing regions — keeps the global picture balanced.
  const flights: ListMilitaryFlightsResponse['flights'] = [];
  const maxLen = regionBuckets.reduce((m, b) => Math.max(m, b.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of regionBuckets) {
      if (i < bucket.length) flights.push(bucket[i]!);
    }
  }

  console.log(`[military-flights] civilian layer: ${flights.length} aircraft from ${CIVILIAN_REGIONS.length} regions`);
  return flights;
}

// ──────────────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────────────

export async function listMilitaryFlights(
  ctx: ServerContext,
  req: ListMilitaryFlightsRequest,
): Promise<ListMilitaryFlightsResponse> {
  try {
    // Empty bbox → treat as global view (return everything from upstream).
    // iOS clients fetch the layer once and render globally; bbox-filtering is reserved for web map pans.
    const hasBounds = !!(req.neLat || req.neLon || req.swLat || req.swLon);
    const requestBounds = hasBounds ? normalizeBounds(req) : null;

    // Quantize bbox to a 1° grid so nearby map views share cache entries.
    // Precise coordinates caused near-zero hit rate since every pan/zoom created a unique key.
    const quantizedBB = hasBounds
      ? [
          quantize(req.swLat, BBOX_GRID_STEP),
          quantize(req.swLon, BBOX_GRID_STEP),
          quantize(req.neLat, BBOX_GRID_STEP),
          quantize(req.neLon, BBOX_GRID_STEP),
        ].join(':')
      : 'global';
    const cacheKey = `${REDIS_CACHE_KEY}:${quantizedBB}:${req.operator || ''}:${req.aircraftType || ''}:${req.pageSize || 0}`;

    const fullResult = await cachedFetchJson<ListMilitaryFlightsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        // ① Primary — ADSBExchange (RapidAPI). Authoritative military feed, rich metadata.
        // ①b — civilian traffic layered in for visual density (product request).
        //      Fetched in parallel; military hexes win on dedup so the
        //      authoritative feed is never overwritten by a civilian sample.
        const [adsbxFlights, civilianFlights] = await Promise.all([
          fetchADSBExchangeFlights(),
          fetchADSBExchangeCivilianFlights(),
        ]);
        if ((adsbxFlights && adsbxFlights.length > 0) || civilianFlights.length > 0) {
          const byHex = new Map<string, ListMilitaryFlightsResponse['flights'][number]>();
          for (const f of civilianFlights) byHex.set(f.hexCode.toUpperCase(), f);
          for (const f of adsbxFlights ?? []) byHex.set(f.hexCode.toUpperCase(), f);
          return { flights: Array.from(byHex.values()), clusters: [], pagination: undefined };
        }

        // ② Fallback — OpenSky relay. Hex/callsign-classified, free but coverage gaps.
        console.log('[military-flights] ADSBX unavailable, trying OpenSky relay');
        const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
        const baseUrl = isSidecar
          ? 'https://opensky-network.org/api/states/all'
          : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

        if (!baseUrl) return null;

        // Only constrain OpenSky to a bbox when the client provided one. Otherwise fetch globally.
        const params = new URLSearchParams();
        if (hasBounds) {
          const fetchBB = {
            lamin: quantize(req.swLat, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
            lamax: quantize(req.neLat, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
            lomin: quantize(req.swLon, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
            lomax: quantize(req.neLon, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
          };
          params.set('lamin', String(fetchBB.lamin));
          params.set('lamax', String(fetchBB.lamax));
          params.set('lomin', String(fetchBB.lomin));
          params.set('lomax', String(fetchBB.lomax));
        }

        const url = `${baseUrl!}${params.toString() ? '?' + params.toString() : ''}`;
        const resp = await fetch(url, {
          headers: getRelayRequestHeaders(),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!resp.ok) return null;

        const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
        if (!data.states) return null;

        const flights: ListMilitaryFlightsResponse['flights'] = [];
        for (const state of data.states) {
          const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
            string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
          ];
          if (lat == null || lon == null || onGround) continue;
          if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

          const category = detectAircraftType(callsign);
          const { operator, country } = lookupHexOperator(icao24);

          flights.push({
            id: icao24,
            callsign: (callsign || '').trim(),
            hexCode: icao24.toUpperCase(),
            registration: '',
            aircraftType: (CATEGORY_TO_ENUM[category] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
            aircraftModel: '',
            operator,
            operatorCountry: country,
            location: { latitude: lat, longitude: lon },
            altitude: altitude ?? 0,
            heading: heading ?? 0,
            speed: (velocity as number) ?? 0,
            verticalRate: 0,
            onGround: false,
            squawk: '',
            origin: '',
            destination: '',
            lastSeenAt: Math.floor(Date.now() / 1000),
            firstSeenAt: 0,
            confidence: 'MILITARY_CONFIDENCE_LOW',
            isInteresting: false,
            note: '',
            enrichment: undefined,
          });
        }

        return flights.length > 0 ? { flights, clusters: [], pagination: undefined } : null;
      },
    );

    if (!fullResult) {
      markNoCacheResponse(ctx.request);
      return { flights: [], clusters: [], pagination: undefined };
    }
    return {
      ...fullResult,
      flights: requestBounds ? filterFlightsToBounds(fullResult.flights, requestBounds) : fullResult.flights,
    };
  } catch {
    markNoCacheResponse(ctx.request);
    return { flights: [], clusters: [], pagination: undefined };
  }
}
