import type { MilitaryFlight, MilitaryFlightCluster, MilitaryAircraftType, MilitaryOperator } from '@/types';
import { createCircuitBreaker } from '@/utils';
import {
  identifyByAircraftType,
  MILITARY_HOTSPOTS,
} from '@/config/military';
import {
  getAircraftDetailsBatch,
  analyzeAircraftDetails,
  checkWingbitsStatus,
} from './wingbits';
import { isFeatureAvailable } from './runtime-config';
import { getApiBaseUrl, isDesktopRuntime } from './runtime';
import {
  MilitaryServiceClient,
} from '@/generated/client/worldmonitor/military/v1/service_client';

const client = new MilitaryServiceClient(getApiBaseUrl());

// Cache configuration — 2 min for Redis (web), 15 min for direct RPC (desktop)
const CACHE_TTL = isDesktopRuntime() ? 15 * 60 * 1000 : 2 * 60 * 1000;
let flightCache: { data: MilitaryFlight[]; timestamp: number } | null = null;

// Track flight history for trails
const flightHistory = new Map<string, { positions: [number, number][]; lastUpdate: number }>();
const HISTORY_MAX_POINTS = 20;
const HISTORY_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
let historyCleanupIntervalId: ReturnType<typeof setInterval> | null = null;

// Circuit breaker for API calls
const breaker = createCircuitBreaker<{ flights: MilitaryFlight[]; clusters: MilitaryFlightCluster[] }>({
  name: 'Military Flight Tracking',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000, // 5 minute cooldown
  cacheTtlMs: 10 * 60 * 1000,
});

async function fetchFromRPC(): Promise<MilitaryFlight[]> {
  const resp = await client.listMilitaryFlights({
    neLat: 90, neLon: 180, swLat: -90, swLon: -180,
    pageSize: 1000,
    cursor: '',
    operator: 'MILITARY_OPERATOR_UNSPECIFIED' as any,
    aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED' as any,
  });

  if (!resp.flights || resp.flights.length === 0) {
    throw new Error('No flights returned from RPC');
  }

  const now = new Date();
  return resp.flights.map((f) => {
    const hexCode = f.hexCode || '';
    const historyKey = hexCode.toLowerCase();
    let history = flightHistory.get(historyKey);
    if (!history) {
      history = { positions: [], lastUpdate: Date.now() };
      flightHistory.set(historyKey, history);
    }
    if (f.location) {
      history.positions.push([f.location.latitude, f.location.longitude]);
    }
    if (history.positions.length > HISTORY_MAX_POINTS) {
      history.positions.shift();
    }
    history.lastUpdate = Date.now();

    // Map proto enums to frontend string types
    const typeMap: Record<string, MilitaryAircraftType> = {
      "MILITARY_AIRCRAFT_TYPE_FIGHTER": 'fighter',
      "MILITARY_AIRCRAFT_TYPE_BOMBER": 'bomber',
      "MILITARY_AIRCRAFT_TYPE_TRANSPORT": 'transport',
      "MILITARY_AIRCRAFT_TYPE_TANKER": 'tanker',
      "MILITARY_AIRCRAFT_TYPE_AWACS": 'awacs',
      "MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE": 'reconnaissance',
      "MILITARY_AIRCRAFT_TYPE_HELICOPTER": 'helicopter',
      "MILITARY_AIRCRAFT_TYPE_DRONE": 'drone',
      "MILITARY_AIRCRAFT_TYPE_PATROL": 'patrol',
      "MILITARY_AIRCRAFT_TYPE_SPECIAL_OPS": 'special_ops',
      "MILITARY_AIRCRAFT_TYPE_VIP": 'vip',
    };

    const operatorMap: Record<string, MilitaryOperator> = {
      "MILITARY_OPERATOR_USAF": 'usaf',
      "MILITARY_OPERATOR_USN": 'usn',
      "MILITARY_OPERATOR_USMC": 'usmc',
      "MILITARY_OPERATOR_USA": 'usa',
      "MILITARY_OPERATOR_RAF": 'raf',
      "MILITARY_OPERATOR_RN": 'rn',
      "MILITARY_OPERATOR_FAF": 'faf',
      "MILITARY_OPERATOR_GAF": 'gaf',
      "MILITARY_OPERATOR_PLAAF": 'plaaf',
      "MILITARY_OPERATOR_PLAN": 'plan',
      "MILITARY_OPERATOR_VKS": 'vks',
      "MILITARY_OPERATOR_IAF": 'iaf',
      "MILITARY_OPERATOR_NATO": 'nato',
    };

    return {
      id: f.id,
      callsign: f.callsign,
      hexCode: hexCode.toUpperCase(),
      aircraftType: (typeMap[f.aircraftType as string] || 'unknown') as MilitaryAircraftType,
      operator: (operatorMap[f.operator as string] || 'other') as MilitaryOperator,
      operatorCountry: f.operatorCountry,
      lat: f.location?.latitude ?? 0,
      lon: f.location?.longitude ?? 0,
      altitude: f.altitude,
      heading: f.heading,
      speed: f.speed,
      verticalRate: f.verticalRate,
      onGround: f.onGround,
      squawk: f.squawk,
      lastSeen: f.lastSeenAt ? new Date(f.lastSeenAt) : now,
      track: history.positions.length > 1 ? [...history.positions] : undefined,
      confidence: f.confidence === "MILITARY_CONFIDENCE_HIGH" ? 'high' : f.confidence === "MILITARY_CONFIDENCE_MEDIUM" ? 'medium' : 'low',
      isInteresting: f.isInteresting,
      note: f.note,
    } satisfies MilitaryFlight;
  });
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
  const hexCodes = Array.from(new Set(flights.map((f) => f.hexCode.toLowerCase()))).sort();

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
  // Toggle check
  if (!isFeatureAvailable('militaryFlights')) {
    return { flights: [], clusters: [] };
  }

  return breaker.execute(async () => {
    if (flightCache && Date.now() - flightCache.timestamp < CACHE_TTL) {
      const clusters = clusterFlights(flightCache.data);
      return { flights: flightCache.data, clusters };
    }

    let flights = await fetchFromRPC();

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
