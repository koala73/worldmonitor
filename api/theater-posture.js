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
const STALE_CACHE_TTL_SECONDS = 86400; // 24 hours - serve stale data when API is down
const BACKUP_CACHE_TTL_SECONDS = 604800; // 7 days - last resort backup
const CACHE_KEY = 'theater-posture:v4';
const STALE_CACHE_KEY = 'theater-posture:stale:v4';
const BACKUP_CACHE_KEY = 'theater-posture:backup:v4';

// Theater definitions (matches client-side POSTURE_THEATERS)
const POSTURE_THEATERS = [
  {
    id: 'iran-theater',
    name: 'Iran Theater',
    shortName: 'IRAN',
    targetNation: 'Iran',
    bounds: { north: 42, south: 20, east: 65, west: 30 },
    thresholds: { elevated: 8, critical: 20 },
    strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 },
  },
  {
    id: 'taiwan-theater',
    name: 'Taiwan Strait',
    shortName: 'TAIWAN',
    targetNation: 'Taiwan',
    bounds: { north: 30, south: 18, east: 130, west: 115 },
    thresholds: { elevated: 6, critical: 15 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 },
  },
  {
    id: 'baltic-theater',
    name: 'Baltic Theater',
    shortName: 'BALTIC',
    targetNation: null,
    bounds: { north: 65, south: 52, east: 32, west: 10 },
    thresholds: { elevated: 5, critical: 12 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'blacksea-theater',
    name: 'Black Sea',
    shortName: 'BLACK SEA',
    targetNation: null,
    bounds: { north: 48, south: 40, east: 42, west: 26 },
    thresholds: { elevated: 4, critical: 10 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'korea-theater',
    name: 'Korean Peninsula',
    shortName: 'KOREA',
    targetNation: 'North Korea',
    bounds: { north: 43, south: 33, east: 132, west: 124 },
    thresholds: { elevated: 5, critical: 12 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'south-china-sea',
    name: 'South China Sea',
    shortName: 'SCS',
    targetNation: null,
    bounds: { north: 25, south: 5, east: 121, west: 105 },
    thresholds: { elevated: 6, critical: 15 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 },
  },
  {
    id: 'east-med-theater',
    name: 'Eastern Mediterranean',
    shortName: 'E.MED',
    targetNation: null,
    bounds: { north: 37, south: 33, east: 37, west: 25 },
    thresholds: { elevated: 4, critical: 10 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'israel-gaza-theater',
    name: 'Israel/Gaza',
    shortName: 'GAZA',
    targetNation: 'Gaza',
    bounds: { north: 33, south: 29, east: 36, west: 33 },
    thresholds: { elevated: 3, critical: 8 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'yemen-redsea-theater',
    name: 'Yemen/Red Sea',
    shortName: 'RED SEA',
    targetNation: 'Yemen',
    bounds: { north: 22, south: 11, east: 54, west: 32 },
    thresholds: { elevated: 4, critical: 10 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
];

// Military hex database from ADS-B Exchange (updated daily at adsbexchange.com)
// Contains ~20k verified military aircraft hex IDs
import { MILITARY_HEX_LIST } from './data/military-hex-db.js';

// Create Set for O(1) lookup
const MILITARY_HEX_SET = new Set(MILITARY_HEX_LIST.map(h => h.toLowerCase()));
console.log(`[TheaterPosture] Loaded ${MILITARY_HEX_SET.size} military hex IDs from ADS-B Exchange`);

// Check if ICAO hex is in military database
function isMilitaryHex(hexId) {
  if (!hexId) return false;
  // Handle both string and number, remove ~ prefix if present
  const cleanHex = String(hexId).replace(/^~/, '').toLowerCase();
  return MILITARY_HEX_SET.has(cleanHex);
}

// Military callsign prefixes for identification
const MILITARY_PREFIXES = [
  // US Military
  'RCH', 'REACH', 'MOOSE', 'EVAC', 'DUSTOFF', 'PEDRO', // Transport/medevac
  'DUKE', 'HAVOC', 'KNIFE', 'WARHAWK', 'VIPER', 'RAGE', 'FURY', // Fighters
  'SHELL', 'TEXACO', 'ARCO', 'ESSO', 'PETRO', // Tankers
  'SENTRY', 'AWACS', 'MAGIC', 'DISCO', 'DARKSTAR', // AWACS/ISR
  'COBRA', 'PYTHON', 'RAPTOR', 'EAGLE', 'HAWK', 'TALON', // Various
  'BOXER', 'OMNI', 'TOPCAT', 'SKULL', 'REAPER', 'HUNTER', // More callsigns
  'ARMY', 'NAVY', 'USAF', 'USMC', 'USCG', // Service prefixes
  'AE', 'CNV', 'PAT', 'SAM', 'EXEC', // Special missions
  'OPS', 'CTF', 'TF', // Operations/Task Force
  // NATO
  'NATO', 'GAF', 'RRF', 'RAF', 'FAF', 'IAF', 'RNLAF', 'BAF', 'DAF', 'HAF', 'PAF',
  'SWORD', 'LANCE', 'ARROW', 'SPARTAN', // NATO tactical
  // Middle East (avoid UAE - conflicts with Emirates airline)
  'RSAF', 'EMIRI', 'UAEAF', 'KAF', 'QAF', 'BAHAF', 'OMAAF', // Gulf states
  'IRIAF', 'IRG', 'IRGC', // Iran (IAF already in NATO section covers Israel)
  'TAF', 'TUAF', // Turkey
  // Russia
  'RSD', 'RF', 'RFF', 'VKS',
  // China (NOTE: CCA is Air China airline, not military)
  'CHN', 'PLAAF', 'PLA',
];

// Airline ICAO codes to exclude from military detection (Set for O(1) lookup)
const AIRLINE_CODES = new Set([
  // Middle East
  'SVA', 'QTR', 'THY', 'UAE', 'ETD', 'GFA', 'MEA', 'RJA', 'KAC', 'ELY',
  'IAW', 'IRA', 'MSR', 'SYR', 'PGT', 'AXB', 'FDB', 'KNE', 'FAD', 'ADY', 'OMA',
  'ABQ', 'ABY', 'NIA', 'FJA', 'SWR', 'HZA', 'OMS', 'EGF', 'NOS', 'SXD',
  // Europe
  'BAW', 'AFR', 'DLH', 'KLM', 'AUA', 'SAS', 'FIN', 'LOT', 'AZA', 'TAP', 'IBE',
  'VLG', 'RYR', 'EZY', 'WZZ', 'NOZ', 'BEL', 'AEE', 'ROT',
  // Asia
  'AIC', 'CPA', 'SIA', 'MAS', 'THA', 'VNM', 'JAL', 'ANA', 'KAL', 'AAR', 'EVA',
  'CAL', 'CCA', 'CES', 'CSN', 'HDA', 'CHH', 'CXA', 'GIA', 'PAL', 'SLK',
  // Americas
  'AAL', 'DAL', 'UAL', 'SWA', 'JBU', 'FFT', 'ASA', 'NKS', 'WJA', 'ACA',
  // Cargo
  'FDX', 'UPS', 'GTI', 'ABW', 'CLX', 'MPH',
  // Generic
  'AIR', 'SKY', 'JET',
]);

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

  // Default to unknown for unrecognized military aircraft
  return 'unknown';
}

// Check if callsign is military
function isMilitaryCallsign(callsign) {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();

  // Check prefixes
  for (const prefix of MILITARY_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }

  // Check patterns - tactical callsigns (word + small number)
  // DUKE01, VIPER12, RAGE1 but NOT airline codes like PGT5873, IAW9011
  if (/^[A-Z]{4,}\d{1,3}$/.test(cs)) return true;

  // Short tactical: 3 letters + 1-2 digits (but exclude common airlines)
  // This catches OPS4, CTF01, TF12 but blocks SVA12, QTR76, etc.
  if (/^[A-Z]{3}\d{1,2}$/.test(cs)) {
    const prefix = cs.slice(0, 3);
    if (!AIRLINE_CODES.has(prefix)) return true;
  }

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

// Fetch military flights from OpenSky via Railway relay (avoids rate limits)
async function fetchMilitaryFlights() {
  // Use Railway relay to avoid OpenSky rate limits
  // VITE_* vars aren't available server-side, so check WS_RELAY_URL or use known production URL
  const relayUrl = process.env.WS_RELAY_URL || 'https://worldmonitor-production-ws.up.railway.app';
  const baseUrl = relayUrl + '/opensky';

  // Fetch global data with 20s timeout (Edge has 25s limit)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    console.log('[TheaterPosture] Fetching from:', baseUrl);
    const response = await fetch(baseUrl, {
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

      // Check if military (by callsign OR hex range)
      const isMilitary = isMilitaryCallsign(callsign) || isMilitaryHex(icao24);
      if (!isMilitary) continue;

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
        militaryHex: isMilitaryHex(icao24),
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

// Fetch military flights from Wingbits (fallback when OpenSky fails)
async function fetchMilitaryFlightsFromWingbits() {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) {
    console.log('[TheaterPosture] Wingbits not configured, skipping fallback');
    return null;
  }

  console.log('[TheaterPosture] Trying Wingbits fallback...');

  // Build batch request for all theaters
  const areas = POSTURE_THEATERS.map(theater => ({
    alias: theater.id,
    by: 'box',
    la: (theater.bounds.north + theater.bounds.south) / 2,
    lo: (theater.bounds.east + theater.bounds.west) / 2,
    w: Math.abs(theater.bounds.east - theater.bounds.west) * 60, // degrees to nm
    h: Math.abs(theater.bounds.north - theater.bounds.south) * 60,
    unit: 'nm',
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://customer-api.wingbits.com/v1/flights', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(areas),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn('[TheaterPosture] Wingbits API error:', response.status);
      return null;
    }

    const data = await response.json();
    console.log('[TheaterPosture] Wingbits returned', data.length, 'theater results');

    // Transform Wingbits data to our format
    // Wingbits uses short field names: h=icao24, f=flight, la=lat, lo=lon, ab=alt, th=heading, gs=speed
    const flights = [];
    const seenIds = new Set();

    for (const areaResult of data) {
      // Batch response: each area result has flights in various possible formats
      const areaFlights = areaResult.flights || areaResult.data || areaResult || [];
      const flightList = Array.isArray(areaFlights) ? areaFlights : [];

      for (const f of flightList) {
        // Get icao24 - Wingbits uses 'h' for hex ID
        const icao24 = f.h || f.icao24 || f.id;
        if (!icao24) continue;

        // Skip duplicates (aircraft may appear in multiple theaters)
        if (seenIds.has(icao24)) continue;
        seenIds.add(icao24);

        // Get callsign - Wingbits uses 'f' for flight
        const callsign = f.f || f.callsign || f.flight || '';

        // Skip if not military (by callsign OR hex range)
        const isMilitary = isMilitaryCallsign(callsign) || isMilitaryHex(icao24);
        if (!isMilitary) continue;

        flights.push({
          id: icao24,
          callsign: callsign.trim(),
          lat: f.la || f.latitude || f.lat,
          lon: f.lo || f.longitude || f.lon || f.lng,
          altitude: f.ab || f.altitude || f.alt || 0,
          heading: f.th || f.heading || f.track || 0,
          speed: f.gs || f.groundSpeed || f.speed || f.velocity || 0,
          aircraftType: detectAircraftType(callsign),
          operator: f.operator || 'unknown',
          source: 'wingbits',
          militaryHex: isMilitaryHex(icao24),
        });
      }
    }

    console.log('[TheaterPosture] Wingbits: found', flights.length, 'military flights');
    return flights;
  } catch (err) {
    console.error('[TheaterPosture] Wingbits fetch error:', err.message);
    return null;
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
      unknown: theaterFlights.filter(f => f.aircraftType === 'unknown').length,
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
    if (byType.bombers > 0) parts.push(`${byType.bombers} bombers`);
    if (byType.transport > 0) parts.push(`${byType.transport} transport`);
    if (byType.drones > 0) parts.push(`${byType.drones} drones`);
    if (byType.unknown > 0) parts.push(`${byType.unknown} other`);
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
      unknown: byType.unknown,
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

    // Fetch and calculate - try OpenSky first, then Wingbits fallback
    console.log('[TheaterPosture] Fetching fresh data...');
    let flights;
    let source = 'opensky';

    try {
      flights = await fetchMilitaryFlights();
    } catch (openskyError) {
      console.warn('[TheaterPosture] OpenSky failed:', openskyError.message);
      console.log('[TheaterPosture] Trying Wingbits fallback...');

      flights = await fetchMilitaryFlightsFromWingbits();
      if (flights && flights.length > 0) {
        source = 'wingbits';
        console.log('[TheaterPosture] Wingbits fallback succeeded:', flights.length, 'flights');
      } else {
        // Both failed, re-throw OpenSky error to trigger cache fallback
        throw openskyError;
      }
    }

    const postures = calculatePostures(flights);

    const result = {
      postures,
      totalFlights: flights.length,
      timestamp: new Date().toISOString(),
      cached: false,
      source, // 'opensky' or 'wingbits'
    };

    // Cache the result (regular, stale, and long-term backup)
    if (redisClient) {
      try {
        await Promise.all([
          redisClient.set(CACHE_KEY, result, { ex: CACHE_TTL_SECONDS }),
          redisClient.set(STALE_CACHE_KEY, result, { ex: STALE_CACHE_TTL_SECONDS }),
          redisClient.set(BACKUP_CACHE_KEY, result, { ex: BACKUP_CACHE_TTL_SECONDS }),
        ]);
        console.log('[TheaterPosture] Cached result (5min/24h/7d)');
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
    console.warn('[TheaterPosture] Error:', error.message);

    // Try to return cached data when API fails (stale first, then backup)
    const staleRedisClient = getRedis();
    if (staleRedisClient) {
      // Try stale cache (24h TTL)
      try {
        const stale = await staleRedisClient.get(STALE_CACHE_KEY);
        if (stale) {
          console.log('[TheaterPosture] Returning stale cached data (24h) due to API error');
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

      // Try backup cache (7d TTL) as last resort
      try {
        const backup = await staleRedisClient.get(BACKUP_CACHE_KEY);
        if (backup) {
          console.log('[TheaterPosture] Returning backup cached data (7d) due to API error');
          return Response.json({
            ...backup,
            cached: true,
            stale: true,
            error: 'Using backup data - live feed temporarily unavailable',
          }, {
            headers: {
              ...corsHeaders,
              'Cache-Control': 'public, max-age=30',
            },
          });
        }
      } catch (cacheErr) {
        console.warn('[TheaterPosture] Backup cache read error:', cacheErr.message);
      }
    }

    // No cached data available - return error
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
