/**
 * Theater Posture API - Aggregates military aircraft by theater
 * Caches results in Upstash Redis for cross-user efficiency
 * TTL: 5 minutes (matches OpenSky refresh rate)
 */

import { Redis } from '@upstash/redis';

export const config = {
  runtime: 'edge',
};

const CACHE_TTL_SECONDS = 300; // 5 minutes
const STALE_CACHE_TTL_SECONDS = 3600; // 1 hour - serve stale data when API is down
const CACHE_KEY = 'theater-posture:v4';
const STALE_CACHE_KEY = 'theater-posture:stale:v4';

// Theater definitions (matches client-side POSTURE_THEATERS)
const POSTURE_THEATERS = [
  {
    id: 'iran-theater',
    name: 'Iran Theater',
    shortName: 'IRAN',
    targetNation: 'Iran',
    bounds: { north: 42, south: 20, east: 65, west: 30 },
    thresholds: { elevated: 50, critical: 100 },
    strikeIndicators: { minTankers: 10, minAwacs: 2, minFighters: 30 },
  },
  {
    id: 'taiwan-theater',
    name: 'Taiwan Strait',
    shortName: 'TAIWAN',
    targetNation: 'Taiwan',
    bounds: { north: 30, south: 18, east: 130, west: 115 },
    thresholds: { elevated: 30, critical: 60 },
    strikeIndicators: { minTankers: 5, minAwacs: 1, minFighters: 20 },
  },
  {
    id: 'baltic-theater',
    name: 'Baltic Theater',
    shortName: 'BALTIC',
    targetNation: null,
    bounds: { north: 65, south: 52, east: 32, west: 10 },
    thresholds: { elevated: 20, critical: 40 },
    strikeIndicators: { minTankers: 4, minAwacs: 1, minFighters: 15 },
  },
  {
    id: 'blacksea-theater',
    name: 'Black Sea',
    shortName: 'BLACK SEA',
    targetNation: null,
    bounds: { north: 48, south: 40, east: 42, west: 26 },
    thresholds: { elevated: 15, critical: 30 },
    strikeIndicators: { minTankers: 3, minAwacs: 1, minFighters: 10 },
  },
  {
    id: 'korea-theater',
    name: 'Korean Peninsula',
    shortName: 'KOREA',
    targetNation: 'North Korea',
    bounds: { north: 43, south: 33, east: 132, west: 124 },
    thresholds: { elevated: 20, critical: 50 },
    strikeIndicators: { minTankers: 4, minAwacs: 1, minFighters: 15 },
  },
  {
    id: 'south-china-sea',
    name: 'South China Sea',
    shortName: 'SCS',
    targetNation: null,
    bounds: { north: 25, south: 5, east: 121, west: 105 },
    thresholds: { elevated: 25, critical: 50 },
    strikeIndicators: { minTankers: 5, minAwacs: 1, minFighters: 20 },
  },
  {
    id: 'east-med-theater',
    name: 'Eastern Mediterranean',
    shortName: 'E.MED',
    targetNation: null,
    bounds: { north: 37, south: 33, east: 37, west: 25 },
    thresholds: { elevated: 15, critical: 30 },
    strikeIndicators: { minTankers: 3, minAwacs: 1, minFighters: 10 },
  },
  {
    id: 'israel-gaza-theater',
    name: 'Israel/Gaza',
    shortName: 'GAZA',
    targetNation: 'Gaza',
    bounds: { north: 33, south: 29, east: 36, west: 33 },
    thresholds: { elevated: 10, critical: 25 },
    strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 8 },
  },
  {
    id: 'yemen-redsea-theater',
    name: 'Yemen/Red Sea',
    shortName: 'RED SEA',
    targetNation: 'Yemen',
    bounds: { north: 22, south: 11, east: 54, west: 32 },
    thresholds: { elevated: 15, critical: 30 },
    strikeIndicators: { minTankers: 3, minAwacs: 1, minFighters: 10 },
  },
];

// Military callsign prefixes for identification
const MILITARY_PREFIXES = [
  // US
  'RCH', 'REACH', 'MOOSE', 'EVAC', 'DUSTOFF', // Transport/medevac
  'DUKE', 'HAVOC', 'KNIFE', 'WARHAWK', 'VIPER', // Fighters
  'SHELL', 'TEXACO', 'ARCO', // Tankers
  'SENTRY', 'AWACS', 'MAGIC', // AWACS
  'COBRA', 'PYTHON', 'RAPTOR', // Various
  // NATO
  'NATO', 'GAF', 'RRF', 'RAF', 'FAF', 'IAF',
  // Russia
  'RSD', 'RF',
  // China
  'CCA', 'CHN',
];

// Aircraft type detection from callsign patterns
function detectAircraftType(callsign) {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();

  // Tankers
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO)/.test(cs)) return 'tanker';
  if (/^(KC|STRAT)/.test(cs)) return 'tanker';

  // AWACS
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR)/.test(cs)) return 'awacs';
  if (/^(E3|E8|E6)/.test(cs)) return 'awacs';

  // Transport
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF)/.test(cs)) return 'transport';
  if (/^(C17|C5|C130|C40)/.test(cs)) return 'transport';

  // Reconnaissance
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO)/.test(cs)) return 'reconnaissance';
  if (/^(RC|U2|SR)/.test(cs)) return 'reconnaissance';

  // Drones/UAVs
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';

  // Bombers
  if (/^(DEATH|BONE|DOOM)/.test(cs)) return 'bomber';
  if (/^(B52|B1|B2)/.test(cs)) return 'bomber';

  // Default to fighter for other military
  return 'fighter';
}

// Check if callsign is military
function isMilitaryCallsign(callsign) {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();

  // Check prefixes
  for (const prefix of MILITARY_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }

  // Check patterns (military often use specific formats)
  if (/^[A-Z]{3,4}\d{2,4}$/.test(cs)) return true; // e.g., DUKE01, VIPER123
  if (/^[A-Z]{2,3}\d{3,4}$/.test(cs)) return true; // e.g., RCH123

  return false;
}

// Initialize Redis
let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      redis = new Redis({ url, token });
    } catch (err) {
      console.warn('[TheaterPosture] Redis init failed:', err.message);
      return null;
    }
  }
  return redis;
}

// Fetch military flights from OpenSky with timeout
async function fetchMilitaryFlights() {
  // Fetch global data with 20s timeout (Edge has 25s limit)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch('https://opensky-network.org/api/states/all', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 WorldMonitor/1.0',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenSky API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.states) return [];

    // Filter and transform to military flights
    const flights = [];
    for (const state of data.states) {
      const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state;

      // Skip if no position
      if (lat == null || lon == null) continue;

      // Skip if on ground
      if (onGround) continue;

      // Check if military
      if (!isMilitaryCallsign(callsign)) continue;

      flights.push({
        id: icao24,
        callsign: callsign?.trim() || '',
        lat,
        lon,
        altitude: altitude || 0,
        heading: heading || 0,
        speed: velocity || 0,
        aircraftType: detectAircraftType(callsign),
        operator: 'unknown',
      });
    }

    return flights;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('OpenSky API timeout - try again');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Calculate theater postures
function calculatePostures(flights) {
  const summaries = [];

  for (const theater of POSTURE_THEATERS) {
    // Filter flights within theater bounds
    const theaterFlights = flights.filter(f =>
      f.lat >= theater.bounds.south &&
      f.lat <= theater.bounds.north &&
      f.lon >= theater.bounds.west &&
      f.lon <= theater.bounds.east
    );

    // Count by type
    const byType = {
      fighters: theaterFlights.filter(f => f.aircraftType === 'fighter').length,
      tankers: theaterFlights.filter(f => f.aircraftType === 'tanker').length,
      awacs: theaterFlights.filter(f => f.aircraftType === 'awacs').length,
      reconnaissance: theaterFlights.filter(f => f.aircraftType === 'reconnaissance').length,
      transport: theaterFlights.filter(f => f.aircraftType === 'transport').length,
      bombers: theaterFlights.filter(f => f.aircraftType === 'bomber').length,
      drones: theaterFlights.filter(f => f.aircraftType === 'drone').length,
    };

    const total = Object.values(byType).reduce((a, b) => a + b, 0);

    // Determine posture level
    const postureLevel = total >= theater.thresholds.critical ? 'critical' :
                        total >= theater.thresholds.elevated ? 'elevated' : 'normal';

    // Check strike capability
    const strikeCapable =
      byType.tankers >= theater.strikeIndicators.minTankers &&
      byType.awacs >= theater.strikeIndicators.minAwacs &&
      byType.fighters >= theater.strikeIndicators.minFighters;

    // Build summary string
    const parts = [];
    if (byType.fighters > 0) parts.push(`${byType.fighters} fighters`);
    if (byType.tankers > 0) parts.push(`${byType.tankers} tankers`);
    if (byType.awacs > 0) parts.push(`${byType.awacs} AWACS`);
    if (byType.reconnaissance > 0) parts.push(`${byType.reconnaissance} recon`);
    const summary = parts.join(', ') || 'No military aircraft';

    // Build headline
    const headline = postureLevel === 'critical'
      ? `Critical military buildup - ${theater.name}`
      : postureLevel === 'elevated'
      ? `Elevated military activity - ${theater.name}`
      : `Normal activity - ${theater.name}`;

    // Build byOperator map for aircraft
    const byOperator = {};
    for (const f of theaterFlights) {
      const op = f.operator || 'unknown';
      byOperator[op] = (byOperator[op] || 0) + 1;
    }

    summaries.push({
      theaterId: theater.id,
      theaterName: theater.name,
      shortName: theater.shortName,
      targetNation: theater.targetNation,
      // Aircraft
      fighters: byType.fighters,
      tankers: byType.tankers,
      awacs: byType.awacs,
      reconnaissance: byType.reconnaissance,
      transport: byType.transport,
      bombers: byType.bombers,
      drones: byType.drones,
      totalAircraft: total,
      // Vessels (populated client-side)
      destroyers: 0,
      frigates: 0,
      carriers: 0,
      submarines: 0,
      patrol: 0,
      auxiliaryVessels: 0,
      totalVessels: 0,
      // By operator (aircraft + vessels added client-side)
      byOperator,
      // Metadata
      postureLevel,
      strikeCapable,
      trend: 'stable',
      changePercent: 0,
      summary,
      headline,
      centerLat: (theater.bounds.north + theater.bounds.south) / 2,
      centerLon: (theater.bounds.east + theater.bounds.west) / 2,
      bounds: theater.bounds,
    });
  }

  return summaries;
}

export default async function handler(req) {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Try to get from cache first
    const redisClient = getRedis();
    if (redisClient) {
      try {
        const cached = await redisClient.get(CACHE_KEY);
        if (cached) {
          console.log('[TheaterPosture] Cache hit');
          return Response.json({
            ...cached,
            cached: true,
          }, {
            headers: {
              ...corsHeaders,
              'Cache-Control': 'public, max-age=60',
            },
          });
        }
      } catch (err) {
        console.warn('[TheaterPosture] Cache read error:', err.message);
      }
    }

    // Fetch and calculate
    console.log('[TheaterPosture] Fetching fresh data...');
    const flights = await fetchMilitaryFlights();
    const postures = calculatePostures(flights);

    const result = {
      postures,
      totalFlights: flights.length,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    // Cache the result (both regular and stale backup)
    if (redisClient) {
      try {
        await Promise.all([
          redisClient.set(CACHE_KEY, result, { ex: CACHE_TTL_SECONDS }),
          redisClient.set(STALE_CACHE_KEY, result, { ex: STALE_CACHE_TTL_SECONDS }),
        ]);
        console.log('[TheaterPosture] Cached result');
      } catch (err) {
        console.warn('[TheaterPosture] Cache write error:', err.message);
      }
    }

    return Response.json(result, {
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (error) {
    console.error('[TheaterPosture] Error:', error);

    // Try to return stale cached data when API fails
    const redisClient = getRedis();
    if (redisClient) {
      try {
        const stale = await redisClient.get(STALE_CACHE_KEY);
        if (stale) {
          console.log('[TheaterPosture] Returning stale cached data due to API error');
          return Response.json({
            ...stale,
            cached: true,
            stale: true,
            error: 'Using cached data - live feed temporarily unavailable',
          }, {
            headers: {
              ...corsHeaders,
              'Cache-Control': 'public, max-age=30',
            },
          });
        }
      } catch (cacheErr) {
        console.warn('[TheaterPosture] Stale cache read error:', cacheErr.message);
      }
    }

    // No stale data available - return error
    return Response.json({
      error: error.message,
      postures: [],
      timestamp: new Date().toISOString(),
    }, {
      status: 500,
      headers: corsHeaders,
    });
  }
}
