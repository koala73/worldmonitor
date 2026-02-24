/**
 * Wingbits Aircraft Enrichment Service
 * Provides detailed aircraft information (owner, operator, type) for military classification
 *
 * Uses MilitaryServiceClient RPCs (GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus)
 * instead of the legacy /api/wingbits proxy.
 */

import { createCircuitBreaker } from '@/utils';
import { dataFreshness } from './data-freshness';
import { isFeatureAvailable } from './runtime-config';
import {
  MilitaryServiceClient,
  type AircraftDetails,
} from '@/generated/client/worldmonitor/military/v1/service_client';

export interface WingbitsAircraftDetails {
  icao24: string;
  registration: string | null;
  manufacturerIcao: string | null;
  manufacturerName: string | null;
  model: string | null;
  typecode: string | null;
  serialNumber: string | null;
  icaoAircraftType: string | null;
  operator: string | null;
  operatorCallsign: string | null;
  operatorIcao: string | null;
  owner: string | null;
  built: string | null;
  engines: string | null;
  categoryDescription: string | null;
}

export interface EnrichedAircraftInfo {
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  typecode: string | null;
  owner: string | null;
  operator: string | null;
  operatorIcao: string | null;
  builtYear: string | null;
  isMilitary: boolean;
  militaryBranch: string | null;
  confidence: 'confirmed' | 'likely' | 'possible' | 'civilian';
}

// ---- Sebuf client ----

const client = new MilitaryServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

// Client-side cache for aircraft details
const localCache = new Map<string, { data: WingbitsAircraftDetails; timestamp: number }>();
const LOCAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour client-side
const MAX_LOCAL_CACHE_ENTRIES = 2000;
const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastCacheSweep = 0;

function sweepLocalCache(now = Date.now()): void {
  if (now - lastCacheSweep < CACHE_SWEEP_INTERVAL_MS && localCache.size <= MAX_LOCAL_CACHE_ENTRIES) {
    return;
  }

  lastCacheSweep = now;

  for (const [key, value] of localCache.entries()) {
    if (now - value.timestamp >= LOCAL_CACHE_TTL) {
      localCache.delete(key);
    }
  }

  if (localCache.size <= MAX_LOCAL_CACHE_ENTRIES) return;

  const oldestFirst = Array.from(localCache.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp);
  const toDelete = oldestFirst.slice(0, localCache.size - MAX_LOCAL_CACHE_ENTRIES);
  for (const [key] of toDelete) {
    localCache.delete(key);
  }
}

function getFromLocalCache(key: string): WingbitsAircraftDetails | null {
  const now = Date.now();
  sweepLocalCache(now);
  const cached = localCache.get(key);
  if (!cached) return null;
  if (now - cached.timestamp >= LOCAL_CACHE_TTL) {
    localCache.delete(key);
    return null;
  }
  return cached.data;
}

function setLocalCache(key: string, data: WingbitsAircraftDetails): void {
  sweepLocalCache();
  localCache.set(key, { data, timestamp: Date.now() });
  if (localCache.size > MAX_LOCAL_CACHE_ENTRIES) {
    sweepLocalCache();
  }
}

// Track if Wingbits is configured
let wingbitsConfigured: boolean | null = null;

// Circuit breaker for API calls
const breaker = createCircuitBreaker<WingbitsAircraftDetails | null>({
  name: 'Wingbits Enrichment',
  maxFailures: 5,
  cooldownMs: 5 * 60 * 1000,
});

// Military keywords for classification
const MILITARY_OPERATORS = [
  'air force', 'navy', 'army', 'marine', 'military', 'defense', 'defence',
  'usaf', 'raf', 'luftwaffe', 'aeronautica', 'fuerza aerea',
  'coast guard', 'national guard', 'air national guard',
  'nato', 'norad',
];

const MILITARY_OWNERS = [
  'united states air force', 'united states navy', 'united states army',
  'us air force', 'us navy', 'us army', 'us marine corps',
  'department of defense', 'department of the air force', 'department of the navy',
  'ministry of defence', 'ministry of defense',
  'royal air force', 'royal navy',
  'bundeswehr', 'german air force', 'german navy',
  'french air force', 'armee de lair',
  'israel defense forces', 'israeli air force',
  'nato', 'northrop grumman', 'lockheed martin', 'general atomics', 'raytheon',
  'boeing defense', 'bae systems',
];

const MILITARY_AIRCRAFT_TYPES = [
  'C17', 'C5', 'C130', 'C135', 'KC135', 'KC10', 'KC46', 'E3', 'E8', 'E6',
  'B52', 'B1', 'B2', 'F15', 'F16', 'F18', 'F22', 'F35', 'A10',
  'P8', 'P3', 'EP3', 'RC135', 'U2', 'RQ4', 'MQ9', 'MQ1',
  'V22', 'CH47', 'UH60', 'AH64', 'HH60',
  'EUFI', 'TYPHOON', 'RAFALE', 'TORNADO', 'GRIPEN',
];

// ---- Proto-to-legacy type mapping ----

/** Map proto AircraftDetails (non-nullable strings) to WingbitsAircraftDetails (nullable strings) */
function toWingbitsDetails(d: AircraftDetails): WingbitsAircraftDetails {
  return {
    icao24: d.icao24,
    registration: d.registration || null,
    manufacturerIcao: d.manufacturerIcao || null,
    manufacturerName: d.manufacturerName || null,
    model: d.model || null,
    typecode: d.typecode || null,
    serialNumber: d.serialNumber || null,
    icaoAircraftType: d.icaoAircraftType || null,
    operator: d.operator || null,
    operatorCallsign: d.operatorCallsign || null,
    operatorIcao: d.operatorIcao || null,
    owner: d.owner || null,
    built: d.built || null,
    engines: d.engines || null,
    categoryDescription: d.categoryDescription || null,
  };
}

/**
 * Check if Wingbits API is configured
 */
export async function checkWingbitsStatus(): Promise<boolean> {
  if (!isFeatureAvailable('wingbitsEnrichment')) return false;
  if (wingbitsConfigured !== null) return wingbitsConfigured;

  try {
    const resp = await client.getWingbitsStatus({});
    wingbitsConfigured = resp.configured;
    dataFreshness.setEnabled('wingbits', wingbitsConfigured);
    console.log(`[Wingbits] Status: ${wingbitsConfigured ? 'configured' : 'not configured'}`);
    return wingbitsConfigured;
  } catch {
    wingbitsConfigured = false;
    dataFreshness.setEnabled('wingbits', false);
    return false;
  }
}

/**
 * Fetch aircraft details from Wingbits
 */
export async function getAircraftDetails(icao24: string): Promise<WingbitsAircraftDetails | null> {
  if (!isFeatureAvailable('wingbitsEnrichment')) return null;
  const key = icao24.toLowerCase();

  // Check local cache first
  const cached = getFromLocalCache(key);
  if (cached) return cached;

  return breaker.execute(async () => {
    // Check if configured
    if (wingbitsConfigured === false) return null;

    const resp = await client.getAircraftDetails({ icao24: key });

    if (resp.configured === false) {
      wingbitsConfigured = false;
      throw new Error('Wingbits not configured');
    }

    if (!resp.details) {
      // Cache negative result
      setLocalCache(key, { icao24: key } as WingbitsAircraftDetails);
      return null;
    }

    const details = toWingbitsDetails(resp.details);
    setLocalCache(key, details);
    return details;
  }, null);
}

/**
 * Batch fetch aircraft details
 */
export async function getAircraftDetailsBatch(icao24List: string[]): Promise<Map<string, WingbitsAircraftDetails>> {
  if (!isFeatureAvailable('wingbitsEnrichment')) return new Map();
  const results = new Map<string, WingbitsAircraftDetails>();
  const toFetch: string[] = [];

  // Check local cache first
  for (const icao24 of icao24List) {
    const key = icao24.toLowerCase();
    const cached = getFromLocalCache(key);
    if (cached) {
      if (cached.registration) { // Only include valid results
        results.set(key, cached);
      }
    } else {
      toFetch.push(key);
    }
  }

  if (toFetch.length === 0 || wingbitsConfigured === false) {
    return results;
  }

  try {
    const resp = await client.getAircraftDetailsBatch({ icao24s: toFetch });

    if (resp.configured === false) {
      wingbitsConfigured = false;
      return results;
    }

    // Process results
    for (const [icao24, protoDetails] of Object.entries(resp.results)) {
      const details = toWingbitsDetails(protoDetails);
      setLocalCache(icao24, details);
      if (details.registration) {
        results.set(icao24, details);
      }
    }

    console.log(`[Wingbits] Batch: ${results.size} enriched, ${resp.fetched || 0} fetched`);
    if (results.size > 0) {
      dataFreshness.recordUpdate('wingbits', results.size);
    }
  } catch (error) {
    console.warn('[Wingbits] Batch fetch failed:', error);
    dataFreshness.recordError('wingbits', error instanceof Error ? error.message : 'Unknown error');
  }

  return results;
}

/**
 * Analyze aircraft details to determine if military
 */
export function analyzeAircraftDetails(details: WingbitsAircraftDetails): EnrichedAircraftInfo {
  const result: EnrichedAircraftInfo = {
    registration: details.registration,
    manufacturer: details.manufacturerName,
    model: details.model,
    typecode: details.typecode,
    owner: details.owner,
    operator: details.operator,
    operatorIcao: details.operatorIcao,
    builtYear: details.built?.substring(0, 4) || null,
    isMilitary: false,
    militaryBranch: null,
    confidence: 'civilian',
  };

  const ownerLower = (details.owner || '').toLowerCase();
  const operatorLower = (details.operator || '').toLowerCase();
  const typecode = (details.typecode || '').toUpperCase();
  const operatorIcao = (details.operatorIcao || '').toUpperCase();

  // Check for military operators
  for (const keyword of MILITARY_OPERATORS) {
    if (operatorLower.includes(keyword)) {
      result.isMilitary = true;
      result.militaryBranch = extractMilitaryBranch(operatorLower);
      result.confidence = 'confirmed';
      return result;
    }
  }

  // Check for military owners
  for (const keyword of MILITARY_OWNERS) {
    if (ownerLower.includes(keyword)) {
      result.isMilitary = true;
      result.militaryBranch = extractMilitaryBranch(ownerLower);
      result.confidence = 'confirmed';
      return result;
    }
  }

  // Check operator ICAO codes
  const militaryOperatorIcaos = ['AIO', 'RRR', 'RFR', 'GAF', 'RCH', 'CNV', 'DOD'];
  if (militaryOperatorIcaos.includes(operatorIcao)) {
    result.isMilitary = true;
    result.confidence = 'likely';
    return result;
  }

  // Check aircraft type codes
  for (const milType of MILITARY_AIRCRAFT_TYPES) {
    if (typecode.includes(milType)) {
      result.isMilitary = true;
      result.confidence = 'likely';
      return result;
    }
  }

  // Defense contractors often operate military aircraft
  const defenseContractors = ['northrop', 'lockheed', 'general atomics', 'raytheon', 'boeing defense', 'l3harris'];
  for (const contractor of defenseContractors) {
    if (ownerLower.includes(contractor) || operatorLower.includes(contractor)) {
      result.isMilitary = true;
      result.confidence = 'possible';
      return result;
    }
  }

  return result;
}

function extractMilitaryBranch(text: string): string | null {
  if (text.includes('air force') || text.includes('usaf') || text.includes('raf')) return 'Air Force';
  if (text.includes('navy') || text.includes('naval')) return 'Navy';
  if (text.includes('army')) return 'Army';
  if (text.includes('marine')) return 'Marines';
  if (text.includes('coast guard')) return 'Coast Guard';
  if (text.includes('national guard')) return 'National Guard';
  if (text.includes('nato')) return 'NATO';
  return null;
}

/**
 * Enrich a single aircraft and determine military status
 */
export async function enrichAircraft(icao24: string): Promise<EnrichedAircraftInfo | null> {
  const details = await getAircraftDetails(icao24);
  if (!details || !details.registration) return null;
  return analyzeAircraftDetails(details);
}

/**
 * Get Wingbits service status
 */
export function getWingbitsStatus(): { configured: boolean | null; cacheSize: number } {
  return {
    configured: wingbitsConfigured,
    cacheSize: localCache.size,
  };
}

/**
 * Clear local cache (useful for testing)
 */
export function clearWingbitsCache(): void {
  localCache.clear();
  lastCacheSweep = 0;
}
