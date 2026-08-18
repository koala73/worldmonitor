import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
  MilitaryOperator,
  MilitaryConfidence,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS } from './_shared';
import { hasFiniteRequestBounds, normalizeBounds, type RequestBounds } from './_bounds';
import { cachedFetchJson, getRawJson, readCachedJson, setCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import {
  hasRedistributableProviderAttribution,
  requiresRedistributableProviders,
} from '../../../_shared/provider-redistribution';

const REDIS_CACHE_KEY = 'military:flights:v1';
const REDIS_CACHE_TTL = 600; // 10 min — reduce upstream API pressure
const REDIS_STALE_KEY = 'military:flights:stale:v1';
const STABLE_STALE_CACHE_KEY = 'military:flights:stable-stale:v1';
const STALE_SNAPSHOT_CACHE_TTL = 120; // Bind a bounded cursor traversal to one snapshot.
const STALE_SNAPSHOT_NEG_TTL = 30;

/** Snap a coordinate to a grid step so nearby bbox values share cache entries. */
const quantize = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const BBOX_GRID_STEP = 1; // 1-degree grid (~111 km at equator)

// Coverage is a property of the SNAPSHOT, not of the producer's query shape.
//
// scripts/seed-military-flights.mjs normally receives a bbox-less global
// military snapshot from adsb.lol. Wingbits and optional point-query gap-fill
// are regional. OpenSky remains only handler-level recovery when no authoritative
// seed covers the viewport. Treating a regional cycle as global would create
// authoritative empty viewports.
//
// The producer therefore stamps its real coverage into the payload and this reads
// it. A payload without the field predates that change and is treated as regional,
// which is the conservative reading during rollout.
const GLOBAL_COVERAGE: readonly RequestBounds[] = [
  { south: -90, north: 90, west: -180, east: 180 },
];

// The producer's Wingbits query regions — mirrors QUERY_REGIONS in the seeder.
const REGIONAL_COVERAGE: readonly RequestBounds[] = [
  { south: 10, north: 46, west: 107, east: 143 },
  { south: 13, north: 85, west: -10, east: 57 },
];

function seedCovers(coverage: SeedCoverage, bounds: RequestBounds): boolean {
  const regions = coverage === 'global' ? GLOBAL_COVERAGE : REGIONAL_COVERAGE;
  return regions.some((region) =>
    region.south <= bounds.south
    && region.north >= bounds.north
    && region.west <= bounds.west
    && region.east >= bounds.east
  );
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

// Pagination is bounded on every request: page_size documents a 1-100 range,
// and 0 / omitted / malformed / out-of-range inputs fall back to the default
// so the public endpoint never streams an unbounded response. The cursor is an
// opaque decimal offset into the exact-bbox-filtered result; empty or malformed
// cursors start at the first page. Internal callers that need the full dataset
// follow next_cursor (see src/services/military-flights.ts:fetchViaProto).
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

function resolvePageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

function resolveOffset(cursor: string | undefined): number {
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) return 0;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function emptyResponse(): ListMilitaryFlightsResponse {
  return { flights: [], clusters: [], pagination: { nextCursor: '', totalCount: 0 } };
}

function buildCacheKey(req: ListMilitaryFlightsRequest): string {
  const quantizedBB = [
    quantize(req.swLat, BBOX_GRID_STEP),
    quantize(req.swLon, BBOX_GRID_STEP),
    quantize(req.neLat, BBOX_GRID_STEP),
    quantize(req.neLon, BBOX_GRID_STEP),
  ].join(':');
  return `${REDIS_CACHE_KEY}:${quantizedBB}:${req.operator || ''}:${req.aircraftType || ''}`;
}

// Filter the cached quantized-cell snapshot to the exact request bbox, THEN
// page it. Ordering must not depend on page size or cursor, so the shared
// snapshot's stable order is preserved and only sliced here.
function paginateResponse(
  flights: ListMilitaryFlightsResponse['flights'],
  clusters: ListMilitaryFlightsResponse['clusters'],
  bounds: RequestBounds,
  req: ListMilitaryFlightsRequest,
): ListMilitaryFlightsResponse {
  const filtered = filterFlightsToBounds(flights, bounds);
  const pageSize = resolvePageSize(req.pageSize);
  const offset = resolveOffset(req.cursor);
  const page = filtered.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < filtered.length ? String(nextOffset) : '';
  return {
    flights: page,
    clusters: clusters ?? [],
    pagination: { nextCursor, totalCount: filtered.length },
  };
}

function paginateResponseForCaller(
  ctx: ServerContext,
  flights: ListMilitaryFlightsResponse['flights'],
  clusters: ListMilitaryFlightsResponse['clusters'],
  bounds: RequestBounds,
  req: ListMilitaryFlightsRequest,
): ListMilitaryFlightsResponse {
  if (!requiresRedistributableProviders(ctx.request)) {
    return paginateResponse(flights, clusters, bounds, req);
  }

  const redistributableFlights = flights.filter((flight) =>
    hasRedistributableProviderAttribution(flight.source));
  const redistributableClusters = (clusters ?? [])
    .map((cluster) => {
      const clusterFlights = (cluster.flights ?? []).filter((flight) =>
        hasRedistributableProviderAttribution(flight.source));
      return { ...cluster, flights: clusterFlights, flightCount: clusterFlights.length };
    })
    .filter((cluster) => cluster.flightCount > 0);
  return paginateResponse(redistributableFlights, redistributableClusters, bounds, req);
}

const AIRCRAFT_TYPE_MAP: Record<string, string> = {
  tanker: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  awacs: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  transport: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  reconnaissance: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
  drone: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  bomber: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  fighter: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  helicopter: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  vip: 'MILITARY_AIRCRAFT_TYPE_VIP',
  special_ops: 'MILITARY_AIRCRAFT_TYPE_SPECIAL_OPS',
};

const OPERATOR_MAP: Record<string, string> = {
  usaf: 'MILITARY_OPERATOR_USAF',
  raf: 'MILITARY_OPERATOR_RAF',
  faf: 'MILITARY_OPERATOR_FAF',
  gaf: 'MILITARY_OPERATOR_GAF',
  iaf: 'MILITARY_OPERATOR_IAF',
  nato: 'MILITARY_OPERATOR_NATO',
  other: 'MILITARY_OPERATOR_OTHER',
};

const CONFIDENCE_MAP: Record<string, string> = {
  high: 'MILITARY_CONFIDENCE_HIGH',
  medium: 'MILITARY_CONFIDENCE_MEDIUM',
  low: 'MILITARY_CONFIDENCE_LOW',
};

interface SeedFlight {
  id?: string;
  callsign?: string;
  hexCode?: string;
  registration?: string;
  aircraftType?: string;
  aircraftModel?: string;
  operator?: string;
  operatorCountry?: string;
  lat?: number | null;
  lon?: number | null;
  altitude?: number;
  heading?: number;
  speed?: number;
  verticalRate?: number;
  onGround?: boolean;
  squawk?: string;
  origin?: string;
  destination?: string;
  lastSeenMs?: number;
  firstSeenMs?: number;
  confidence?: string;
  isInteresting?: boolean;
  note?: string;
  sourceMeta?: { source?: string };
}

/** What geography a published snapshot actually covers — see seedCovers above. */
type SeedCoverage = 'global' | 'regional';

interface SeedPayload {
  flights?: SeedFlight[];
  fetchedAt?: number;
  coverage?: SeedCoverage;
}

/**
 * Convert the seed cron's app-shape flight (flat lat/lon, lowercase enums,
 * lastSeenMs) into the proto shape (nested GeoCoordinates, enum strings,
 * lastSeenAt). Mirrors the inverse of src/services/military-flights.ts:mapProtoFlight.
 * hexCode is canonicalized to uppercase per the invariant documented on
 * MilitaryFlight.hex_code in military_flight.proto.
 */
function seedToProto(f: SeedFlight): ListMilitaryFlightsResponse['flights'][number] | null {
  if (f.lat == null || f.lon == null) return null;
  const icao = (f.hexCode || f.id || '').toUpperCase();
  if (!icao) return null;
  return {
    id: (f.id || icao).trim(),
    callsign: (f.callsign || '').trim(),
    hexCode: icao,
    registration: f.registration || '',
    aircraftType: (AIRCRAFT_TYPE_MAP[f.aircraftType || ''] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
    aircraftModel: f.aircraftModel || '',
    operator: (OPERATOR_MAP[f.operator || ''] || 'MILITARY_OPERATOR_OTHER') as MilitaryOperator,
    operatorCountry: f.operatorCountry || '',
    location: { latitude: f.lat, longitude: f.lon },
    altitude: f.altitude ?? 0,
    heading: f.heading ?? 0,
    speed: f.speed ?? 0,
    verticalRate: f.verticalRate ?? 0,
    onGround: f.onGround ?? false,
    squawk: f.squawk || '',
    origin: f.origin || '',
    destination: f.destination || '',
    lastSeenAt: f.lastSeenMs ?? Date.now(),
    firstSeenAt: f.firstSeenMs ?? 0,
    confidence: (CONFIDENCE_MAP[f.confidence || ''] || 'MILITARY_CONFIDENCE_LOW') as MilitaryConfidence,
    isInteresting: f.isInteresting ?? false,
    note: f.note || '',
    enrichment: undefined,
    source: f.sourceMeta?.source || '',
  };
}

function seedPayloadToProto(raw: SeedPayload | null): ListMilitaryFlightsResponse['flights'] | null {
  if (!raw || !Array.isArray(raw.flights)) return null;
  if (raw.flights.length === 0) return [];
  const flights = raw.flights
    .map(seedToProto)
    .filter((flight): flight is NonNullable<typeof flight> => flight != null);
  return flights.length > 0 ? flights : null;
}

const LIVE_SEED_NEG_TTL_MS = 30_000;
let liveSeedNegUntil = 0;
let liveSeedNegStatus: 'miss' | 'error' = 'miss';
type LiveSeedRead =
  | { status: 'hit'; flights: ListMilitaryFlightsResponse['flights']; coverage: SeedCoverage }
  | { status: 'miss' | 'error' };
let liveSeedReadPromise: Promise<LiveSeedRead> | null = null;

async function fetchLiveSeedSnapshot(): Promise<LiveSeedRead> {
  const now = Date.now();
  if (now < liveSeedNegUntil) return { status: liveSeedNegStatus };
  if (liveSeedReadPromise) return liveSeedReadPromise;

  liveSeedReadPromise = (async () => {
    const read = await readCachedJson(REDIS_CACHE_KEY, true);
    if (read.status === 'error') {
      liveSeedNegStatus = 'error';
      liveSeedNegUntil = now + LIVE_SEED_NEG_TTL_MS;
      return { status: 'error' };
    }
    const payload = read.status === 'hit' ? (read.value as SeedPayload) : null;
    const flights = payload ? seedPayloadToProto(payload) : null;
    if (flights === null) {
      liveSeedNegStatus = 'miss';
      liveSeedNegUntil = now + LIVE_SEED_NEG_TTL_MS;
      return { status: 'miss' };
    }
    // An absent field predates the producer stamping coverage; regional is the
    // conservative reading, and it is what the payload actually covered then.
    const coverage: SeedCoverage = payload?.coverage === 'global' ? 'global' : 'regional';
    return { status: 'hit', flights, coverage };
  })();
  try {
    return await liveSeedReadPromise;
  } finally {
    liveSeedReadPromise = null;
  }
}

// Negative cache for the stale Redis read — mirrors the legacy
// /api/military-flights handler's NEG_TTL=30_000ms. When the live fetch fails
// AND the stale key is also empty/unparseable, suppress further Redis reads
// of REDIS_STALE_KEY for STALE_NEG_TTL_MS so we don't hammer Redis once per
// request during sustained relay+seed outages. Per-isolate (Vercel Edge state),
// which is fine — each warm isolate gets its own 30s suppression window.
const STALE_NEG_TTL_MS = 30_000;
let staleNegUntil = 0;

type StaleSnapshotCacheEntry =
  | { status: 'hit'; result: ListMilitaryFlightsResponse; coverage: SeedCoverage }
  | { status: 'miss' };

let staleSnapshotLocalCache: { entry: StaleSnapshotCacheEntry; expiresAt: number } | null = null;
let staleSnapshotInflight: Promise<StaleSnapshotCacheEntry> | null = null;

// Test seam — exposed for unit tests that need to drive the suppression
// window without sleeping. Not exported from the module's public API.
export function _resetStaleNegativeCacheForTests(): void {
  liveSeedNegUntil = 0;
  liveSeedNegStatus = 'miss';
  liveSeedReadPromise = null;
  staleNegUntil = 0;
  staleSnapshotLocalCache = null;
  staleSnapshotInflight = null;
}

interface StaleSeedSnapshot {
  flights: ListMilitaryFlightsResponse['flights'];
  coverage: SeedCoverage;
}

async function fetchStaleFallback(): Promise<StaleSeedSnapshot | null> {
  const now = Date.now();
  if (now < staleNegUntil) return null;
  try {
    const raw = (await getRawJson(REDIS_STALE_KEY)) as SeedPayload | null;
    const flights = seedPayloadToProto(raw);
    if (!flights || flights.length === 0) {
      staleNegUntil = now + STALE_NEG_TTL_MS;
      return null;
    }
    return {
      flights,
      coverage: raw?.coverage === 'global' ? 'global' : 'regional',
    };
  } catch {
    staleNegUntil = now + STALE_NEG_TTL_MS;
    return null;
  }
}

function parseStaleSnapshotCacheEntry(value: unknown): StaleSnapshotCacheEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<StaleSnapshotCacheEntry>;
  if (entry.status === 'miss') return { status: 'miss' };
  if (
    entry.status !== 'hit'
    || !entry.result
    || !Array.isArray(entry.result.flights)
    || (entry.coverage !== 'global' && entry.coverage !== 'regional')
  ) return null;
  return { status: 'hit', result: entry.result, coverage: entry.coverage };
}

function staleResultForBounds(
  entry: StaleSnapshotCacheEntry,
  requestBounds: RequestBounds,
): ListMilitaryFlightsResponse | null {
  if (entry.status !== 'hit') return null;
  if (seedCovers(entry.coverage, requestBounds)) return entry.result;

  // The dashboard deliberately asks for the full legal world. If only a
  // regional last-good snapshot survived, serving its in-bounds rows is more
  // useful than blanking every region. Narrow requests outside that declared
  // coverage still fail closed, so an uncovered viewport is never presented as
  // an authoritative empty result.
  const isGlobalRequest = requestBounds.south === -90
    && requestBounds.north === 90
    && requestBounds.west === -180
    && requestBounds.east === 180;
  return isGlobalRequest ? entry.result : null;
}

// Stale is a mutable root key, while pagination uses numeric offsets. Cache the
// unpaginated snapshot plus its declared coverage under one fixed key so a
// seeder write cannot make later cursor pages slice a different ordering. The
// root snapshot is bbox/filter independent; using derived public-input keys here
// would duplicate full snapshots and make isolate state unbounded. Every cache
// hit still rechecks exact request bounds against coverage. Misses use the legacy
// 30s suppression window; snapshots live for two minutes, comfortably past the
// bounded traversal without extending the 24h root snapshot itself.
async function fetchStableStaleSnapshot(
  requestBounds: RequestBounds,
): Promise<ListMilitaryFlightsResponse | null> {
  const now = Date.now();
  const local = staleSnapshotLocalCache;
  if (local && local.expiresAt > now) {
    return staleResultForBounds(local.entry, requestBounds);
  }
  staleSnapshotLocalCache = null;

  const existing = staleSnapshotInflight;
  if (existing) {
    const entry = await existing;
    return staleResultForBounds(entry, requestBounds);
  }

  const promise = (async (): Promise<StaleSnapshotCacheEntry> => {
    const cached = await readCachedJson(STABLE_STALE_CACHE_KEY);
    if (cached.status === 'hit') {
      const entry = parseStaleSnapshotCacheEntry(cached.value);
      if (entry) {
        const ttl = entry.status === 'hit' ? STALE_SNAPSHOT_CACHE_TTL : STALE_SNAPSHOT_NEG_TTL;
        staleSnapshotLocalCache = { entry, expiresAt: Date.now() + ttl * 1_000 };
        return entry;
      }
    }

    const stale = await fetchStaleFallback();
    const entry: StaleSnapshotCacheEntry = stale
      ? {
        status: 'hit',
        result: { flights: stale.flights, clusters: [], pagination: undefined },
        coverage: stale.coverage,
      }
      : { status: 'miss' };
    const ttl = entry.status === 'hit' ? STALE_SNAPSHOT_CACHE_TTL : STALE_SNAPSHOT_NEG_TTL;
    staleSnapshotLocalCache = { entry, expiresAt: Date.now() + ttl * 1_000 };
    await setCachedJson(STABLE_STALE_CACHE_KEY, entry, ttl);
    return entry;
  })().finally(() => {
    staleSnapshotInflight = null;
  });

  staleSnapshotInflight = promise;
  const entry = await promise;
  return staleResultForBounds(entry, requestBounds);
}

export async function listMilitaryFlights(
  ctx: ServerContext,
  req: ListMilitaryFlightsRequest,
): Promise<ListMilitaryFlightsResponse> {
  const redistributableOnly = requiresRedistributableProviders(ctx.request);
  try {
    if (!req.neLat && !req.neLon && !req.swLat && !req.swLon) return emptyResponse();
    // #6249: a NaN/Infinity corner cannot be normalized into a meaningful
    // bbox; answer empty instead of letting it reach the relay as garbage.
    if (!hasFiniteRequestBounds(req)) return emptyResponse();
    const requestBounds = normalizeBounds(req);

    // Quantize bbox to a 1° grid so nearby map views share cache entries.
    // Precise coordinates caused near-zero hit rate since every pan/zoom created a unique key.
    // Key by the quantized bbox only. The cached value is the complete
    // expanded-cell snapshot, so page size and cursor must NOT fragment it —
    // every page/cursor for the same cell shares one upstream fetch and one
    // entry, and pagination is applied per-request after retrieval.
    const cacheKey = `${buildCacheKey(req)}${redistributableOnly ? ':redistributable' : ''}`;

    const fullResult = await cachedFetchJson<ListMilitaryFlightsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        // The scheduled seeder is the single routine authenticated OpenSky
        // writer. Cache its unpaginated regional snapshot under the existing
        // bbox key so every cursor reads one stable version. Requests outside
        // the producer's declared coverage continue to request-specific
        // recovery instead of receiving a falsely authoritative empty result.
        // The producer deliberately preserves its last-good snapshot during an
        // upstream outage. Keep serving that snapshot (with each flight's old
        // lastSeenAt intact) while seed health reports the stale fetchedAt;
        // reopening per-viewer OpenSky recovery here recreates the credit fanout.
        // Read first, THEN judge coverage: what the snapshot covers is a property
        // of the payload (the producer stamps it), not of this module's constants.
        const seeded = await fetchLiveSeedSnapshot();
        if (seeded.status === 'error') {
          // A Redis command/read failure is not proof the snapshot is
          // missing. Throw before any provider call so cachedFetchJson's
          // bounded negative path prevents per-bbox OpenSky amplification.
          // The outer catch consults the 24h stale key before giving up.
          throw new Error('military live seed read failed');
        }
        if (seeded.status === 'hit' && seedCovers(seeded.coverage, requestBounds)) {
          return { flights: seeded.flights, clusters: [], pagination: undefined };
        }
        // A miss, or a hit whose coverage does not contain this request (a
        // regional snapshot asked about the Americas), falls through to
        // request-specific recovery rather than returning a falsely
        // authoritative empty.

        if (redistributableOnly) return null;

        const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
        const relayBase = isSidecar ? null : getRelayBaseUrl();
        const baseUrl = isSidecar ? 'https://opensky-network.org/api/states/all' : relayBase ? relayBase + '/opensky' : null;

        if (!baseUrl) return null;

        const fetchBB = {
          lamin: clamp(quantize(req.swLat, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2, -90, 90),
          lamax: clamp(quantize(req.neLat, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2, -90, 90),
          lomin: clamp(quantize(req.swLon, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2, -180, 180),
          lomax: clamp(quantize(req.neLon, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2, -180, 180),
        };
        const params = new URLSearchParams();
        params.set('lamin', String(fetchBB.lamin));
        params.set('lamax', String(fetchBB.lamax));
        params.set('lomin', String(fetchBB.lomin));
        params.set('lomax', String(fetchBB.lomax));

        const url = `${baseUrl!}${params.toString() ? '?' + params.toString() : ''}`;
        const resp = await fetch(url, {
          headers: getRelayHeaders(),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!resp.ok) return null;

        const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
        if (!data.states) return null;

        const flights: ListMilitaryFlightsResponse['flights'] = [];
        for (const state of data.states) {
          const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading, verticalRate] = state as [
            string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean,
            number | null, number | null, number | null,
          ];
          if (lat == null || lon == null || onGround) continue;
          if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

          const aircraftType = detectAircraftType(callsign);
          // Canonicalize hex_code to uppercase — the seed cron
          // (scripts/seed-military-flights.mjs) writes uppercase, and
          // src/services/military-flights.ts getFlightByHex uppercases the
          // lookup input. Preserving OpenSky's lowercase here would break
          // every hex lookup silently.
          const hex = icao24.toUpperCase();

          flights.push({
            id: hex,
            callsign: (callsign || '').trim(),
            hexCode: hex,
            registration: '',
            aircraftType: (AIRCRAFT_TYPE_MAP[aircraftType] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
            aircraftModel: '',
            operator: 'MILITARY_OPERATOR_OTHER',
            operatorCountry: '',
            location: { latitude: lat, longitude: lon },
            altitude: altitude != null ? Math.round(altitude * 3.28084) : 0,
            heading: heading ?? 0,
            speed: velocity != null ? Math.round(velocity * 1.94384) : 0,
            verticalRate: verticalRate != null ? Math.round(verticalRate * 196.85) : 0,
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
            source: 'opensky',
          });
        }

        return flights.length > 0 ? { flights, clusters: [], pagination: undefined } : null;
      },
    );

    if (!fullResult) {
      // Live fetch failed. The legacy /api/military-flights handler cascaded
      // military:flights:v1 → military:flights:stale:v1 before returning empty.
      // The seed cron (scripts/seed-military-flights.mjs) writes both keys
      // every run; stale has a 24h TTL versus 10min live, so it's the right
      // fallback when OpenSky / the relay hiccups.
      const staleResult = await fetchStableStaleSnapshot(requestBounds);
      if (staleResult) {
        return paginateResponseForCaller(ctx, staleResult.flights, staleResult.clusters, requestBounds, req);
      }
      markNoCacheResponse(ctx.request);
      return emptyResponse();
    }
    return paginateResponseForCaller(ctx, fullResult.flights, fullResult.clusters, requestBounds, req);
  } catch {
    // Reaching here means the live path was abandoned before any provider call —
    // most often the deliberate 'live seed read failed' throw above, which exists
    // to keep a Redis blip from opening per-bbox OpenSky amplification.
    //
    // That throw skipped the `if (!fullResult)` stale branch below, so the 24h
    // stale key was never consulted. Reading it is another Redis GET, not a
    // provider call, so it spends no OpenSky credit and is precisely what that
    // key exists for. This matters much more since #6222 widened
    // LIVE_SEED_COVERAGE to global: every viewport now routes through the
    // live-seed read, so skipping stale here blanks the entire map rather than
    // the two former producer regions. The accepted stale snapshot is cached
    // unpaginated so every cursor in the bounded traversal slices one version.
    const requestBounds = normalizeBounds(req);
    const staleResult = await fetchStableStaleSnapshot(requestBounds);
    if (staleResult) {
      return paginateResponseForCaller(ctx, staleResult.flights, staleResult.clusters, requestBounds, req);
    }
    markNoCacheResponse(ctx.request);
    return emptyResponse();
  }
}
