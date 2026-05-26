import type { MilitaryFlight, MilitaryFlightCluster, MilitaryAircraftType, MilitaryOperator } from '@/types';
import { createCircuitBreaker, toUniqueSortedLowercase } from '@/utils';
import {
  identifyByCallsign,
  identifyByAircraftType,
  isKnownMilitaryHex,
  getNearbyHotspot,
  MILITARY_HOTSPOTS,
  MILITARY_QUERY_REGIONS,
} from '@/config/military';
import type { QueryRegion } from '@/config/military';
import {
  MilitaryServiceClient,
  type MilitaryFlight as ProtoMilitaryFlight,
  type MilitaryAircraftType as ProtoMilitaryAircraftType,
  type MilitaryOperator as ProtoMilitaryOperator,
} from '@/generated/client/worldmonitor/military/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  getAircraftDetailsBatch,
  analyzeAircraftDetails,
  checkWingbitsStatus,
} from './wingbits';
import { isFeatureAvailable } from './runtime-config';
import { isDesktopRuntime, toApiUrl } from './runtime';

const militaryClient = new MilitaryServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});

const AIRCRAFT_TYPE_REVERSE: Partial<Record<ProtoMilitaryAircraftType, MilitaryAircraftType>> = {
  MILITARY_AIRCRAFT_TYPE_FIGHTER: 'fighter',
  MILITARY_AIRCRAFT_TYPE_BOMBER: 'bomber',
  MILITARY_AIRCRAFT_TYPE_TRANSPORT: 'transport',
  MILITARY_AIRCRAFT_TYPE_TANKER: 'tanker',
  MILITARY_AIRCRAFT_TYPE_AWACS: 'awacs',
  MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE: 'reconnaissance',
  MILITARY_AIRCRAFT_TYPE_HELICOPTER: 'helicopter',
  MILITARY_AIRCRAFT_TYPE_DRONE: 'drone',
  MILITARY_AIRCRAFT_TYPE_PATROL: 'patrol',
  MILITARY_AIRCRAFT_TYPE_SPECIAL_OPS: 'special_ops',
  MILITARY_AIRCRAFT_TYPE_VIP: 'vip',
};

const OPERATOR_REVERSE: Partial<Record<ProtoMilitaryOperator, MilitaryOperator>> = {
  MILITARY_OPERATOR_USAF: 'usaf',
  MILITARY_OPERATOR_USN: 'usn',
  MILITARY_OPERATOR_USMC: 'usmc',
  MILITARY_OPERATOR_USA: 'usa',
  MILITARY_OPERATOR_RAF: 'raf',
  MILITARY_OPERATOR_RN: 'rn',
  MILITARY_OPERATOR_FAF: 'faf',
  MILITARY_OPERATOR_GAF: 'gaf',
  MILITARY_OPERATOR_PLAAF: 'plaaf',
  MILITARY_OPERATOR_PLAN: 'plan',
  MILITARY_OPERATOR_VKS: 'vks',
  MILITARY_OPERATOR_IAF: 'iaf',
  MILITARY_OPERATOR_NATO: 'nato',
};

const CONFIDENCE_REVERSE: Record<string, 'high' | 'medium' | 'low'> = {
  MILITARY_CONFIDENCE_HIGH: 'high',
  MILITARY_CONFIDENCE_MEDIUM: 'medium',
  MILITARY_CONFIDENCE_LOW: 'low',
};

// Desktop: direct OpenSky proxy path (relay or Vercel)
const OPENSKY_PROXY_URL = toApiUrl('/api/opensky');
const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const DIRECT_OPENSKY_BASE_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/opensky'
  : '';
const isLocalhostRuntime = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);

// Cache configuration — 2 min for Redis (web), 15 min for direct OpenSky (desktop)
const CACHE_TTL = isDesktopRuntime() ? 15 * 60 * 1000 : 2 * 60 * 1000;
let flightCache: { data: MilitaryFlight[]; timestamp: number } | null = null;

// Track flight history for trails
const flightHistory = new Map<string, { positions: [number, number][]; lastUpdate: number }>();
const HISTORY_MAX_POINTS = 20;
const HISTORY_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
let historyCleanupIntervalId: ReturnType<typeof setInterval> | null = null;

function upsertFlightHistory(historyKey: string, lat: number, lon: number): [number, number][] {
  let history = flightHistory.get(historyKey);
  const now = Date.now();

  if (!history) {
    history = { positions: [], lastUpdate: now };
    flightHistory.set(historyKey, history);
  }

  history.positions.push([lat, lon]);
  if (history.positions.length > HISTORY_MAX_POINTS) {
    history.positions.shift();
  }
  history.lastUpdate = now;

  return history.positions;
}

// Circuit breaker for API calls
const breaker = createCircuitBreaker<{ flights: MilitaryFlight[]; clusters: MilitaryFlightCluster[] }>({
  name: 'Military Flight Tracking',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000, // 5 minute cooldown
  cacheTtlMs: 10 * 60 * 1000,
  persistCache: true,
  revivePersistedData: (data) => ({
    ...data,
    flights: data.flights.map((f: MilitaryFlight) => ({
      ...f,
      lastSeen: f.lastSeen instanceof Date ? f.lastSeen : new Date(f.lastSeen as unknown as string),
    })),
  }),
});

function mapProtoFlight(pf: ProtoMilitaryFlight, nowDate: Date): MilitaryFlight | null {
  const lat = pf.location?.latitude;
  const lon = pf.location?.longitude;
  if (lat == null || lon == null) return null;

  const positions = upsertFlightHistory(pf.hexCode.toLowerCase(), lat, lon);

  return {
    id: pf.id,
    callsign: pf.callsign,
    hexCode: pf.hexCode,
    registration: pf.registration || undefined,
    aircraftType: AIRCRAFT_TYPE_REVERSE[pf.aircraftType] || 'unknown',
    aircraftModel: pf.aircraftModel || undefined,
    operator: OPERATOR_REVERSE[pf.operator] || 'other',
    operatorCountry: pf.operatorCountry,
    lat,
    lon,
    altitude: pf.altitude,
    heading: pf.heading,
    speed: pf.speed,
    verticalRate: pf.verticalRate || undefined,
    onGround: pf.onGround,
    squawk: pf.squawk || undefined,
    origin: pf.origin || undefined,
    destination: pf.destination || undefined,
    lastSeen: pf.lastSeenAt ? new Date(pf.lastSeenAt) : nowDate,
    firstSeen: pf.firstSeenAt ? new Date(pf.firstSeenAt) : undefined,
    track: positions.length > 1 ? [...positions] : undefined,
    confidence: CONFIDENCE_REVERSE[pf.confidence] || 'low',
    isInteresting: pf.isInteresting || undefined,
    note: pf.note || undefined,
    enriched: pf.enrichment ? {
      manufacturer: pf.enrichment.manufacturer || undefined,
      owner: pf.enrichment.owner || undefined,
      operatorName: pf.enrichment.operatorName || undefined,
      typeCode: pf.enrichment.typeCode || undefined,
      builtYear: pf.enrichment.builtYear || undefined,
      confirmedMilitary: pf.enrichment.confirmedMilitary,
      militaryBranch: pf.enrichment.militaryBranch || undefined,
    } : undefined,
  };
}

async function fetchViaProto(): Promise<MilitaryFlight[]> {
  // Iterate the same PACIFIC/WESTERN regions the server-side seed cron uses
  // so dashboard coverage matches the analytic pipeline. The proto handler
  // caches per-bbox, so parallel region calls warm independent cache keys.
  const results = await Promise.all(
    MILITARY_QUERY_REGIONS.map(async (region) => {
      try {
        const resp = await militaryClient.listMilitaryFlights({
          pageSize: 0,
          cursor: '',
          neLat: region.lamax,
          neLon: region.lomax,
          swLat: region.lamin,
          swLon: region.lomin,
          operator: '' as ProtoMilitaryOperator,
          aircraftType: '' as ProtoMilitaryAircraftType,
        });
        return resp.flights ?? [];
      } catch {
        return [];
      }
    }),
  );

  const now = new Date();
  const seen = new Set<string>();
  const flights: MilitaryFlight[] = [];

  for (const regionFlights of results) {
    for (const pf of regionFlights) {
      if (seen.has(pf.hexCode)) continue;
      seen.add(pf.hexCode);
      const mapped = mapProtoFlight(pf, now);
      if (mapped) flights.push(mapped);
    }
  }

  if (flights.length === 0) {
    throw new Error('No flights returned — upstream may be down');
  }

  return flights;
}

// ─── Desktop-only: OpenSky direct path ────────────────────────

type OpenSkyStateArray = [
  string, string | null, string, number | null, number,
  number | null, number | null, number | null, boolean,
  number | null, number | null, number | null, number[] | null,
  number | null, string | null, boolean, number
];

interface OpenSkyResponse {
  time: number;
  states: OpenSkyStateArray[] | null;
}

function determineAircraftInfo(
  callsign: string, icao24: string, originCountry?: string,
): { type: MilitaryAircraftType; operator: MilitaryOperator; country: string; confidence: 'high' | 'medium' | 'low' } {
  const csMatch = identifyByCallsign(callsign, originCountry);
  if (csMatch) {
    const countryMap: Record<MilitaryOperator, string> = {
      usaf: 'USA', usn: 'USA', usmc: 'USA', usa: 'USA',
      raf: 'UK', rn: 'UK', faf: 'France', gaf: 'Germany',
      plaaf: 'China', plan: 'China', vks: 'Russia',
      iaf: 'Israel', nato: 'NATO', other: 'Unknown',
    };
    return { type: csMatch.aircraftType || 'unknown', operator: csMatch.operator, country: countryMap[csMatch.operator], confidence: 'high' };
  }
  const hexMatch = isKnownMilitaryHex(icao24);
  if (hexMatch) return { type: 'unknown', operator: hexMatch.operator, country: hexMatch.country, confidence: 'medium' };
  return { type: 'unknown', operator: 'other', country: 'Unknown', confidence: 'low' };
}

function isMilitaryFlight(state: OpenSkyStateArray): boolean {
  const callsign = (state[1] || '').trim();
  if (callsign && identifyByCallsign(callsign, state[2])) return true;
  if (isKnownMilitaryHex(state[0])) return true;
  return false;
}

function parseOpenSkyResponse(data: OpenSkyResponse): MilitaryFlight[] {
  if (!data.states) return [];
  const flights: MilitaryFlight[] = [];
  const now = new Date();
  for (const state of data.states) {
    if (!isMilitaryFlight(state)) continue;
    const icao24 = state[0];
    const callsign = (state[1] || '').trim();
    const lat = state[6]; const lon = state[5];
    if (lat === null || lon === null) continue;
    const info = determineAircraftInfo(callsign, icao24, state[2]);
    const positions = upsertFlightHistory(icao24, lat, lon);
    const nearbyHotspot = getNearbyHotspot(lat, lon);
    const baroAlt = state[7]; const velocity = state[9]; const track = state[10]; const vertRate = state[11];
    flights.push({
      id: `opensky-${icao24}`,
      callsign: callsign || `UNKN-${icao24.substring(0, 4).toUpperCase()}`,
      hexCode: icao24.toUpperCase(),
      aircraftType: info.type, operator: info.operator, operatorCountry: info.country,
      lat, lon,
      altitude: baroAlt != null ? Math.round(baroAlt * 3.28084) : 0,
      heading: track != null ? track : 0,
      speed: velocity != null ? Math.round(velocity * 1.94384) : 0,
      verticalRate: vertRate != null ? Math.round(vertRate * 196.85) : undefined,
      onGround: state[8], squawk: state[14] || undefined,
      lastSeen: now,
      track: positions.length > 1 ? [...positions] : undefined,
      confidence: info.confidence,
      isInteresting: nearbyHotspot?.priority === 'high' || info.type === 'bomber' || info.type === 'reconnaissance' || info.type === 'awacs',
      note: nearbyHotspot ? `Near ${nearbyHotspot.name}` : undefined,
    });
  }
  return flights;
}

interface RegionResult { name: string; flights: MilitaryFlight[]; ok: boolean }

async function fetchQueryRegion(region: QueryRegion): Promise<RegionResult> {
  const query = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
  const urls = [`${OPENSKY_PROXY_URL}?${query}`];
  if (isLocalhostRuntime && DIRECT_OPENSKY_BASE_URL) urls.push(`${DIRECT_OPENSKY_BASE_URL}?${query}`);
  try {
    for (const url of urls) {
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!response.ok) continue;
      const data: OpenSkyResponse = await response.json();
      return { name: region.name, flights: parseOpenSkyResponse(data), ok: true };
    }
    return { name: region.name, flights: [], ok: false };
  } catch {
    return { name: region.name, flights: [], ok: false };
  }
}

const STALE_MAX_AGE_MS = 10 * 60 * 1000;
const regionCache = new Map<string, { flights: MilitaryFlight[]; timestamp: number }>();

async function fetchFromOpenSky(): Promise<MilitaryFlight[]> {
  const allFlights: MilitaryFlight[] = [];
  const seenHexCodes = new Set<string>();
  let allFailed = true;
  const results = await Promise.all(MILITARY_QUERY_REGIONS.map(region => fetchQueryRegion(region)));
  for (const result of results) {
    let flights: MilitaryFlight[];
    if (result.ok) {
      allFailed = false;
      regionCache.set(result.name, { flights: result.flights, timestamp: Date.now() });
      flights = result.flights;
    } else {
      const stale = regionCache.get(result.name);
      if (stale && (Date.now() - stale.timestamp < STALE_MAX_AGE_MS)) { flights = stale.flights; }
      else { flights = []; }
    }
    for (const flight of flights) {
      if (!seenHexCodes.has(flight.hexCode)) { seenHexCodes.add(flight.hexCode); allFlights.push(flight); }
    }
  }
  if (allFailed && allFlights.length === 0) throw new Error('All regions failed — upstream may be down');
  return allFlights;
}

/**
 * Enrich flights with Wingbits aircraft details
 * Updates confidence and adds owner/operator info
 */
async function enrichFlightsWithWingbits(flights: MilitaryFlight[]): Promise<MilitaryFlight[]> {
  // Check if Wingbits is configured
  const isConfigured = await checkWingbitsStatus();
  if (!isConfigured) {
    return flights;
  }

  // Use deterministic ordering to improve cache locality across refreshes.
  const hexCodes = toUniqueSortedLowercase(flights.map((f) => f.hexCode));

  // Batch fetch aircraft details
  const detailsMap = await getAircraftDetailsBatch(hexCodes);

  if (detailsMap.size === 0) {
    return flights;
  }

  // Enrich each flight
  return flights.map(flight => {
    const details = detailsMap.get(flight.hexCode.toLowerCase());
    if (!details) return flight;

    const analysis = analyzeAircraftDetails(details);

    // Update flight with enrichment data
    const enrichedFlight = { ...flight };

    // Add enrichment info
    enrichedFlight.enriched = {
      manufacturer: analysis.manufacturer || undefined,
      owner: analysis.owner || undefined,
      operatorName: analysis.operator || undefined,
      typeCode: analysis.typecode || undefined,
      builtYear: analysis.builtYear || undefined,
      confirmedMilitary: analysis.isMilitary,
      militaryBranch: analysis.militaryBranch || undefined,
    };

    // Add registration if not already set
    if (!enrichedFlight.registration && analysis.registration) {
      enrichedFlight.registration = analysis.registration;
    }

    // Add model if available
    if (!enrichedFlight.aircraftModel && analysis.model) {
      enrichedFlight.aircraftModel = analysis.model;
    }

    // Use typecode to refine type if still unknown
    const wingbitsTypeCode = analysis.typecode || details.typecode;
    if (wingbitsTypeCode && enrichedFlight.aircraftType === 'unknown') {
      const typeMatch = identifyByAircraftType(wingbitsTypeCode);
      if (typeMatch) {
        enrichedFlight.aircraftType = typeMatch.type;
        if (enrichedFlight.confidence === 'low') {
          enrichedFlight.confidence = 'medium';
        }
      }
    }

    // Upgrade confidence if Wingbits confirms military
    if (analysis.isMilitary) {
      if (analysis.confidence === 'confirmed') {
        enrichedFlight.confidence = 'high';
      } else if (analysis.confidence === 'likely' && enrichedFlight.confidence === 'low') {
        enrichedFlight.confidence = 'medium';
      }

      // Mark as interesting if confirmed military with known branch
      if (analysis.militaryBranch) {
        enrichedFlight.isInteresting = true;
        if (!enrichedFlight.note) {
          enrichedFlight.note = `${analysis.militaryBranch}${analysis.owner ? ` - ${analysis.owner}` : ''}`;
        }
      }
    }

    return enrichedFlight;
  });
}

/**
 * Cluster nearby flights for map display
 */
function clusterFlights(flights: MilitaryFlight[]): MilitaryFlightCluster[] {
  const clusters: MilitaryFlightCluster[] = [];
  const processed = new Set<string>();

  // Check each hotspot for clusters
  for (const hotspot of MILITARY_HOTSPOTS) {
    const nearbyFlights = flights.filter((f) => {
      if (processed.has(f.id)) return false;
      const distance = Math.sqrt((f.lat - hotspot.lat) ** 2 + (f.lon - hotspot.lon) ** 2);
      return distance <= hotspot.radius;
    });

    if (nearbyFlights.length >= 2) {
      // Mark as processed
      nearbyFlights.forEach((f) => processed.add(f.id));

      // Calculate cluster center
      const avgLat = nearbyFlights.reduce((sum, f) => sum + f.lat, 0) / nearbyFlights.length;
      const avgLon = nearbyFlights.reduce((sum, f) => sum + f.lon, 0) / nearbyFlights.length;

      // Determine dominant operator
      const operatorCounts = new Map<MilitaryOperator, number>();
      for (const f of nearbyFlights) {
        operatorCounts.set(f.operator, (operatorCounts.get(f.operator) || 0) + 1);
      }
      let dominantOperator: MilitaryOperator | undefined;
      let maxCount = 0;
      for (const [op, count] of operatorCounts) {
        if (count > maxCount) {
          maxCount = count;
          dominantOperator = op;
        }
      }

      // Determine activity type
      const hasTransport = nearbyFlights.some((f) => f.aircraftType === 'transport' || f.aircraftType === 'tanker');
      const hasFighters = nearbyFlights.some((f) => f.aircraftType === 'fighter');
      const hasRecon = nearbyFlights.some((f) => f.aircraftType === 'reconnaissance' || f.aircraftType === 'awacs');

      let activityType: 'exercise' | 'patrol' | 'transport' | 'unknown' = 'unknown';
      if (hasFighters && hasRecon) activityType = 'exercise';
      else if (hasFighters || hasRecon) activityType = 'patrol';
      else if (hasTransport) activityType = 'transport';

      clusters.push({
        id: `cluster-${hotspot.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: hotspot.name,
        lat: avgLat,
        lon: avgLon,
        flightCount: nearbyFlights.length,
        flights: nearbyFlights,
        dominantOperator,
        activityType,
      });
    }
  }

  return clusters;
}

/**
 * Clean up old flight history entries
 */
function cleanupFlightHistory(): void {
  const cutoff = Date.now() - HISTORY_CLEANUP_INTERVAL;
  for (const [key, history] of flightHistory) {
    if (history.lastUpdate < cutoff) {
      flightHistory.delete(key);
    }
  }
}

// Set up periodic cleanup
if (typeof window !== 'undefined') {
  historyCleanupIntervalId = setInterval(cleanupFlightHistory, HISTORY_CLEANUP_INTERVAL);
}

/** Stop the periodic flight-history cleanup (for teardown / testing). */
export function stopFlightHistoryCleanup(): void {
  if (historyCleanupIntervalId) {
    clearInterval(historyCleanupIntervalId);
    historyCleanupIntervalId = null;
  }
}

/**
 * Main function to fetch military flights
 */
export async function fetchMilitaryFlights(): Promise<{
  flights: MilitaryFlight[];
  clusters: MilitaryFlightCluster[];
}> {
  const desktop = isDesktopRuntime();
  if (desktop && !isFeatureAvailable('openskyRelay')) return { flights: [], clusters: [] };
  if (!desktop && !isFeatureAvailable('militaryFlights')) return { flights: [], clusters: [] };

  return breaker.execute(async () => {
    if (flightCache && Date.now() - flightCache.timestamp < CACHE_TTL) {
      const clusters = clusterFlights(flightCache.data);
      return { flights: flightCache.data, clusters };
    }

    let flights = desktop ? await fetchFromOpenSky() : await fetchViaProto();

    if (flights.length === 0) {
      throw new Error('No flights returned — upstream may be down');
    }

    // Enrich with Wingbits aircraft details (owner, operator, type)
    flights = await enrichFlightsWithWingbits(flights);

    // Update cache
    flightCache = { data: flights, timestamp: Date.now() };

    // Generate clusters
    const clusters = clusterFlights(flights);

    return { flights, clusters };
  }, { flights: [], clusters: [] });
}

/**
 * Get status of military flights tracking
 */
export function getMilitaryFlightsStatus(): string {
  return breaker.getStatus();
}

/**
 * Get flight by hex code
 */
export function getFlightByHex(hexCode: string): MilitaryFlight | undefined {
  if (!flightCache) return undefined;
  return flightCache.data.find((f) => f.hexCode === hexCode.toUpperCase());
}

/**
 * Get flights by operator
 */
export function getFlightsByOperator(operator: MilitaryOperator): MilitaryFlight[] {
  if (!flightCache) return [];
  return flightCache.data.filter((f) => f.operator === operator);
}

/**
 * Get interesting flights (near hotspots, special types)
 */
export function getInterestingFlights(): MilitaryFlight[] {
  if (!flightCache) return [];
  return flightCache.data.filter((f) => f.isInteresting);
}
