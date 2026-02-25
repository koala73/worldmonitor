import type { MilitaryFlight, MilitaryFlightCluster, MilitaryAircraftType, MilitaryOperator } from '@/types';
import { createCircuitBreaker } from '@/utils';
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
  getAircraftDetailsBatch,
  analyzeAircraftDetails,
  checkWingbitsStatus,
} from './wingbits';
import { isFeatureAvailable } from './runtime-config';

// OpenSky API path — route through Vercel so Railway secret never reaches the browser.
const OPENSKY_PROXY_URL = '/api/opensky';
const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const DIRECT_OPENSKY_BASE_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/opensky'
  : '';
const isLocalhostRuntime = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes - match refresh interval
let flightCache: { data: MilitaryFlight[]; timestamp: number } | null = null;

// Track flight history for trails
const flightHistory = new Map<string, { positions: [number, number][]; lastUpdate: number }>();
const HISTORY_MAX_POINTS = 20;
const HISTORY_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Circuit breaker for API calls
const breaker = createCircuitBreaker<{ flights: MilitaryFlight[]; clusters: MilitaryFlightCluster[] }>({
  name: 'Military Flight Tracking',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000, // 5 minute cooldown
  cacheTtlMs: 5 * 60 * 1000, // 5 minute cache
});

// OpenSky API returns arrays in this order:
// [0] icao24, [1] callsign, [2] origin_country, [3] time_position, [4] last_contact,
// [5] longitude, [6] latitude, [7] baro_altitude, [8] on_ground, [9] velocity,
// [10] true_track, [11] vertical_rate, [12] sensors, [13] geo_altitude, [14] squawk,
// [15] spi, [16] position_source
type OpenSkyStateArray = [
  string,       // 0: icao24
  string | null,// 1: callsign
  string,       // 2: origin_country
  number | null,// 3: time_position
  number,       // 4: last_contact
  number | null,// 5: longitude
  number | null,// 6: latitude
  number | null,// 7: baro_altitude (meters)
  boolean,      // 8: on_ground
  number | null,// 9: velocity (m/s)
  number | null,// 10: true_track (degrees)
  number | null,// 11: vertical_rate (m/s)
  number[] | null, // 12: sensors
  number | null,// 13: geo_altitude
  string | null,// 14: squawk
  boolean,      // 15: spi
  number        // 16: position_source
];

interface OpenSkyResponse {
  time: number;
  states: OpenSkyStateArray[] | null;
}

/**
 * Determine aircraft type based on callsign, type code, or hex
 */
function determineAircraftInfo(
  callsign: string,
  icao24: string,
  originCountry?: string,
  typeCode?: string
): { type: MilitaryAircraftType; operator: MilitaryOperator; country: string; confidence: 'high' | 'medium' | 'low' } {
  // Check callsign first (highest confidence)
  const callsignMatch = identifyByCallsign(callsign, originCountry);
  if (callsignMatch) {
    return {
      type: callsignMatch.aircraftType || 'unknown',
      operator: callsignMatch.operator,
      country: getCountryFromOperator(callsignMatch.operator),
      confidence: 'high',
    };
  }

  // Check hex code range
  const hexMatch = isKnownMilitaryHex(icao24);
  if (hexMatch) {
    return {
      type: 'unknown',
      operator: hexMatch.operator,
      country: hexMatch.country,
      confidence: 'medium',
    };
  }

  // Check typecode as fallback
  if (typeCode) {
    const typeMatch = identifyByAircraftType(typeCode);
    if (typeMatch) {
      return {
        type: typeMatch.type,
        operator: 'other',
        country: 'Unknown',
        confidence: 'low',
      };
    }
  }

  // Default for unknown military
  return {
    type: 'unknown',
    operator: 'other',
    country: 'Unknown',
    confidence: 'low',
  };
}

function getCountryFromOperator(operator: MilitaryOperator): string {
  const countryMap: Record<MilitaryOperator, string> = {
    usaf: 'USA',
    usn: 'USA',
    usmc: 'USA',
    usa: 'USA',
    raf: 'UK',
    rn: 'UK',
    faf: 'France',
    gaf: 'Germany',
    plaaf: 'China',
    plan: 'China',
    vks: 'Russia',
    iaf: 'Israel',
    nato: 'NATO',
    other: 'Unknown',
  };
  return countryMap[operator];
}

/**
 * Check if a flight looks like a military aircraft
 */
function isMilitaryFlight(state: OpenSkyStateArray): boolean {
  const callsign = (state[1] || '').trim();
  const icao24 = state[0];
  const originCountry = state[2];

  // Check for known military callsigns (covers all patterns from config)
  if (callsign && identifyByCallsign(callsign, originCountry)) {
    return true;
  }

  // Check for military hex code ranges (expanded list)
  if (isKnownMilitaryHex(icao24)) {
    return true;
  }

  // Extended list of countries with recognizable military patterns
  const militaryCountries = [
    'United States', 'United Kingdom', 'France', 'Germany', 'Israel',
    'Turkey', 'Saudi Arabia', 'United Arab Emirates', 'Qatar', 'Kuwait',
    'Japan', 'South Korea', 'Australia', 'Canada', 'Italy', 'Spain',
    'Netherlands', 'Poland', 'Greece', 'Norway', 'Sweden', 'India',
    'Pakistan', 'Egypt', 'Singapore', 'Taiwan'
  ];

  if (militaryCountries.includes(originCountry)) {
    // Check for expanded military callsign patterns
    const militaryPattern = /^(RCH|REACH|DUKE|KING|GOLD|NAVY|ARMY|MARINE|NATO|RAF|GAF|FAF|IAF|THK|TUR|RSAF|UAF|JPN|JASDF|ROKAF|KAF|RAAF|CANFORCE|CFC|AME|PLF|HAF|EGY|PAF|FORTE|HAWK|REAPER|COBRA|RIVET|OLIVE|SNTRY|DRAGN|BONE|DEATH|DOOM|TRIDENT|ASCOT|CNV|HMX|DUSTOFF|EVAC|MOOSE|HERKY)/i.test(callsign);
    if (callsign && militaryPattern) {
      return true;
    }
  }

  return false;
}

/**
 * Parse OpenSky response into MilitaryFlight objects
 */
function parseOpenSkyResponse(data: OpenSkyResponse): MilitaryFlight[] {
  if (!data.states) return [];

  const flights: MilitaryFlight[] = [];
  const now = new Date();

  for (const state of data.states) {
    if (!isMilitaryFlight(state)) continue;

    const icao24 = state[0];
    const callsign = (state[1] || '').trim();
    const lat = state[6];
    const lon = state[5];

    if (lat === null || lon === null) continue;

    const info = determineAircraftInfo(callsign, icao24, state[2]);

    // Update flight history for trails
    const historyKey = icao24;
    let history = flightHistory.get(historyKey);
    if (!history) {
      history = { positions: [], lastUpdate: Date.now() };
      flightHistory.set(historyKey, history);
    }

    // Add position to history
    history.positions.push([lat, lon]);
    if (history.positions.length > HISTORY_MAX_POINTS) {
      history.positions.shift();
    }
    history.lastUpdate = Date.now();

    // Check if near interesting hotspot
    const nearbyHotspot = getNearbyHotspot(lat, lon);
    const isInteresting = nearbyHotspot?.priority === 'high' ||
      info.type === 'bomber' ||
      info.type === 'reconnaissance' ||
      info.type === 'awacs';

    const baroAlt = state[7];
    const velocity = state[9];
    const track = state[10];
    const vertRate = state[11];

    const flight: MilitaryFlight = {
      id: `opensky-${icao24}`,
      callsign: callsign || `UNKN-${icao24.substring(0, 4).toUpperCase()}`,
      hexCode: icao24.toUpperCase(),
      aircraftType: info.type,
      operator: info.operator,
      operatorCountry: info.country,
      lat,
      lon,
      altitude: baroAlt ? Math.round(baroAlt * 3.28084) : 0, // Convert m to ft
      heading: track || 0,
      speed: velocity ? Math.round(velocity * 1.94384) : 0, // Convert m/s to knots
      verticalRate: vertRate ? Math.round(vertRate * 196.85) : undefined, // Convert m/s to ft/min
      onGround: state[8],
      squawk: state[14] || undefined,
      lastSeen: now,
      track: history.positions.length > 1 ? [...history.positions] : undefined,
      confidence: info.confidence,
      isInteresting,
      note: nearbyHotspot ? `Near ${nearbyHotspot.name}` : undefined,
    };

    flights.push(flight);
  }

  return flights;
}

interface RegionResult {
  name: string;
  flights: MilitaryFlight[];
  ok: boolean;
}

async function fetchQueryRegion(region: QueryRegion): Promise<RegionResult> {
  const query = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
  const urls = [`${OPENSKY_PROXY_URL}?${query}`];
  if (isLocalhostRuntime && DIRECT_OPENSKY_BASE_URL) {
    urls.push(`${DIRECT_OPENSKY_BASE_URL}?${query}`);
  }

  try {
    for (const url of urls) {
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!response.ok) {
        if (response.status === 429) {
          console.warn(`[Military Flights] Rate limited for ${region.name}`);
        }
        continue;
      }
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

  const results = await Promise.all(
    MILITARY_QUERY_REGIONS.map(region => fetchQueryRegion(region))
  );

  for (const result of results) {
    let flights: MilitaryFlight[];

    if (result.ok) {
      allFailed = false;
      regionCache.set(result.name, { flights: result.flights, timestamp: Date.now() });
      flights = result.flights;
    } else {
      const stale = regionCache.get(result.name);
      if (stale && (Date.now() - stale.timestamp < STALE_MAX_AGE_MS)) {
        console.warn(`[Military Flights] ${result.name} failed, using stale data (${Math.round((Date.now() - stale.timestamp) / 1000)}s old)`);
        flights = stale.flights;
      } else {
        console.warn(`[Military Flights] ${result.name} failed, no usable stale data`);
        flights = [];
      }
    }

    for (const flight of flights) {
      if (!seenHexCodes.has(flight.hexCode)) {
        seenHexCodes.add(flight.hexCode);
        allFlights.push(flight);
      }
    }
  }

  if (allFailed && allFlights.length === 0) {
    throw new Error('All regions failed — upstream may be down');
  }

  console.log(`[Military Flights] Found ${allFlights.length} military aircraft from ${MILITARY_QUERY_REGIONS.length} regions`);
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
    console.log('[Military Flights] Wingbits not configured, skipping enrichment');
    return flights;
  }

  // Get hex codes for all flights
  const hexCodes = flights.map(f => f.hexCode.toLowerCase());

  // Batch fetch aircraft details
  const detailsMap = await getAircraftDetailsBatch(hexCodes);

  if (detailsMap.size === 0) {
    return flights;
  }

  console.log(`[Military Flights] Enriching ${detailsMap.size} of ${flights.length} aircraft with Wingbits data`);

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
      const distance = Math.sqrt(Math.pow(f.lat - hotspot.lat, 2) + Math.pow(f.lon - hotspot.lon, 2));
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
  setInterval(cleanupFlightHistory, HISTORY_CLEANUP_INTERVAL);
}

/**
 * Main function to fetch military flights
 */
export async function fetchMilitaryFlights(): Promise<{
  flights: MilitaryFlight[];
  clusters: MilitaryFlightCluster[];
}> {
  if (!isFeatureAvailable('openskyRelay')) {
    return { flights: [], clusters: [] };
  }

  return breaker.execute(async () => {
    // Check cache
    if (flightCache && Date.now() - flightCache.timestamp < CACHE_TTL) {
      const clusters = clusterFlights(flightCache.data);
      return { flights: flightCache.data, clusters };
    }

    // Fetch from OpenSky (regional queries for efficiency)
    let flights = await fetchFromOpenSky();

    if (flights.length === 0) {
      throw new Error('No flights returned — upstream may be down');
    }

    // Enrich with Wingbits aircraft details (owner, operator, type)
    flights = await enrichFlightsWithWingbits(flights);

    // Update cache
    flightCache = { data: flights, timestamp: Date.now() };

    // Generate clusters
    const clusters = clusterFlights(flights);

    console.log(`[Military Flights] Total: ${flights.length} flights, ${clusters.length} clusters`);
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
