/**
 * RPC: listUcdpEvents -- Port from api/ucdp-events.js
 *
 * Queries the UCDP GED API with automatic version discovery and paginated
 * backward fetch over a trailing 1-year window.  Supports optional country
 * filtering.  Returns empty array on upstream failure (graceful degradation).
 */

import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
  UcdpViolenceType,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 12;
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const CACHE_KEY = 'ucdp:gedevents:sebuf:v1';
const CACHE_TTL_FULL = 6 * 60 * 60;        // 6 hours for complete results
const CACHE_TTL_PARTIAL = 10 * 60;          // 10 minutes for partial results (M-16 port)

// In-memory fallback cache with per-entry TTL
let fallbackCache: { data: UcdpViolenceEvent[] | null; timestamp: number; ttlMs: number } = {
  data: null,
  timestamp: 0,
  ttlMs: CACHE_TTL_FULL * 1000,
};

const VIOLENCE_TYPE_MAP: Record<number, UcdpViolenceType> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

function parseDateMs(value: unknown): number {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function getMaxDateMs(events: any[]): number {
  let maxMs = NaN;
  for (const event of events) {
    const ms = parseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) {
      maxMs = ms;
    }
  }
  return maxMs;
}

function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}

// Negative cache: prevent hammering UCDP when it's down
let lastFailureTimestamp = 0;
const NEGATIVE_CACHE_MS = 60 * 1000; // 60 seconds backoff after failure

// Discovered version cache: avoid re-probing every request
let discoveredVersion: string | null = null;
let discoveredVersionTimestamp = 0;
const VERSION_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function fetchGedPage(version: string, page: number): Promise<any> {
  const response = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    throw new Error(`UCDP GED API error (${version}, page ${page}): ${response.status}`);
  }
  return response.json();
}

async function discoverGedVersion(): Promise<{ version: string; page0: any }> {
  // Use cached version if still valid
  if (discoveredVersion && (Date.now() - discoveredVersionTimestamp) < VERSION_CACHE_MS) {
    const page0 = await fetchGedPage(discoveredVersion, 0);
    if (Array.isArray(page0?.Result)) {
      return { version: discoveredVersion, page0 };
    }
    discoveredVersion = null; // Cached version no longer works
  }

  // Probe all candidates in parallel instead of sequentially
  const candidates = buildVersionCandidates();
  const results = await Promise.allSettled(
    candidates.map(async (version) => {
      const page0 = await fetchGedPage(version, 0);
      if (!Array.isArray(page0?.Result)) throw new Error('No results');
      return { version, page0 };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      discoveredVersion = result.value.version;
      discoveredVersionTimestamp = Date.now();
      return result.value;
    }
  }

  throw new Error('No valid UCDP GED version found');
}

async function fetchUcdpGedEvents(req: ListUcdpEventsRequest): Promise<UcdpViolenceEvent[]> {
  // Negative cache: skip fetch if UCDP failed recently
  if (lastFailureTimestamp && (Date.now() - lastFailureTimestamp) < NEGATIVE_CACHE_MS) {
    if (fallbackCache.data) return fallbackCache.data;
    return [];
  }

  try {
    const { version, page0 } = await discoverGedVersion();
    const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
    const newestPage = totalPages - 1;

    // Fetch pages in parallel (ported from main branch improvement #198)
    const FAILED = Symbol('failed');
    const pagesToFetch: Promise<any>[] = [];
    for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
      const page = newestPage - offset;
      if (page === 0) {
        pagesToFetch.push(Promise.resolve(page0));
      } else {
        pagesToFetch.push(fetchGedPage(version, page).catch(() => FAILED));
      }
    }

    const pageResults = await Promise.all(pagesToFetch);

    const allEvents: any[] = [];
    let latestDatasetMs = NaN;
    let failedPages = 0;

    for (const rawData of pageResults) {
      if (rawData === FAILED) { failedPages++; continue; }
      const events: any[] = Array.isArray(rawData?.Result) ? rawData.Result : [];
      allEvents.push(...events);

      const pageMaxMs = getMaxDateMs(events);
      if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
        latestDatasetMs = pageMaxMs;
      }
    }

    const isPartial = failedPages > 0;

    // Filter events within trailing window
    const filtered = allEvents.filter((event) => {
      if (!Number.isFinite(latestDatasetMs)) return true;
      const eventMs = parseDateMs(event?.date_start);
      if (!Number.isFinite(eventMs)) return false;
      return eventMs >= (latestDatasetMs - TRAILING_WINDOW_MS);
    });

    // Map to proto UcdpViolenceEvent
    let mapped = filtered.map((e: any): UcdpViolenceEvent => ({
      id: String(e.id || ''),
      dateStart: Date.parse(e.date_start) || 0,
      dateEnd: Date.parse(e.date_end) || 0,
      location: {
        latitude: Number(e.latitude) || 0,
        longitude: Number(e.longitude) || 0,
      },
      country: e.country || '',
      sideA: (e.side_a || '').substring(0, 200),
      sideB: (e.side_b || '').substring(0, 200),
      deathsBest: Number(e.best) || 0,
      deathsLow: Number(e.low) || 0,
      deathsHigh: Number(e.high) || 0,
      violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
      sourceOriginal: (e.source_original || '').substring(0, 300),
    }));

    // Filter by country if requested
    if (req.country) {
      mapped = mapped.filter((e) => e.country === req.country);
    }

    // Sort by dateStart descending (newest first)
    mapped.sort((a, b) => b.dateStart - a.dateStart);

    // Success: clear negative cache
    lastFailureTimestamp = 0;

    // Cache with TTL based on completeness (ported from main #198)
    // Only cache non-empty results to avoid serving stale empty data for hours
    const ttl = isPartial ? CACHE_TTL_PARTIAL : CACHE_TTL_FULL;
    if (mapped.length > 0) {
      await setCachedJson(CACHE_KEY, mapped, ttl).catch(() => {});
      fallbackCache = { data: mapped, timestamp: Date.now(), ttlMs: ttl * 1000 };
    }

    return mapped;
  } catch {
    lastFailureTimestamp = Date.now();
    if (fallbackCache.data) return fallbackCache.data;
    return [];
  }
}

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  // Check Redis cache first
  const cached = await getCachedJson(CACHE_KEY) as UcdpViolenceEvent[] | null;
  if (cached && Array.isArray(cached) && cached.length > 0) {
    let events = cached;
    if (req.country) events = events.filter((e) => e.country === req.country);
    return { events, pagination: undefined };
  }

  // Check in-memory fallback cache
  if (fallbackCache.data && (Date.now() - fallbackCache.timestamp) < fallbackCache.ttlMs) {
    let events = fallbackCache.data;
    if (req.country) events = events.filter((e) => e.country === req.country);
    return { events, pagination: undefined };
  }

  try {
    const events = await fetchUcdpGedEvents(req);
    return { events, pagination: undefined };
  } catch {
    // Last resort: stale fallback data
    if (fallbackCache.data) {
      let events = fallbackCache.data;
      if (req.country) events = events.filter((e) => e.country === req.country);
      return { events, pagination: undefined };
    }
    return { events: [], pagination: undefined };
  }
}
