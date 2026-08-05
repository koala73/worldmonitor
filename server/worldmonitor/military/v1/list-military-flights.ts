import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
  MilitaryOperator,
  MilitaryConfidence,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS } from './_shared';
import { cachedFetchJson, getRawJson, readCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';

const REDIS_CACHE_KEY = 'military:flights:v1';
const REDIS_CACHE_TTL = 600; // 10 min — reduce upstream API pressure
const REDIS_STALE_KEY = 'military:flights:stale:v1';

/** Snap a coordinate to a grid step so nearby bbox values share cache entries. */
const quantize = (v: number, step: number) => Math.round(v / step) * step;
const BBOX_GRID_STEP = 1; // 1-degree grid (~111 km at equator)

interface RequestBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

// The scheduled military-flight snapshot is GLOBAL: scripts/seed-military-flights.mjs
// issues one bbox-less OpenSky /states/all per run (#6222), so every viewport is
// inside the producer's declared coverage.
//
// This must stay in lockstep with the producer's query shape. While the producer
// queried two regional bboxes, this listed exactly those two, and any viewport
// outside them fell through to per-viewer authenticated OpenSky recovery below —
// an unbounded credit fanout on top of the seeder's own spend. Narrowing the
// producer again without narrowing this would silently republish that fanout.
const LIVE_SEED_COVERAGE: readonly RequestBounds[] = [
  { south: -90, north: 90, west: -180, east: 180 },
];

function liveSeedCovers(bounds: RequestBounds): boolean {
  return LIVE_SEED_COVERAGE.some((region) =>
    region.south <= bounds.south
    && region.north >= bounds.north
    && region.west <= bounds.west
    && region.east >= bounds.east
  );
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
}

interface SeedPayload {
  flights?: SeedFlight[];
  fetchedAt?: number;
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
    id: icao,
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
  | { status: 'hit'; flights: ListMilitaryFlightsResponse['flights'] }
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
    const flights = read.status === 'hit'
      ? seedPayloadToProto(read.value as SeedPayload)
      : null;
    if (flights === null) {
      liveSeedNegStatus = 'miss';
      liveSeedNegUntil = now + LIVE_SEED_NEG_TTL_MS;
      return { status: 'miss' };
    }
    return { status: 'hit', flights };
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

// Test seam — exposed for unit tests that need to drive the suppression
// window without sleeping. Not exported from the module's public API.
export function _resetStaleNegativeCacheForTests(): void {
  liveSeedNegUntil = 0;
  liveSeedNegStatus = 'miss';
  liveSeedReadPromise = null;
  staleNegUntil = 0;
}

async function fetchStaleFallback(): Promise<ListMilitaryFlightsResponse['flights'] | null> {
  const now = Date.now();
  if (now < staleNegUntil) return null;
  try {
    const raw = (await getRawJson(REDIS_STALE_KEY)) as SeedPayload | null;
    const flights = seedPayloadToProto(raw);
    if (!flights || flights.length === 0) {
      staleNegUntil = now + STALE_NEG_TTL_MS;
      return null;
    }
    return flights;
  } catch {
    staleNegUntil = now + STALE_NEG_TTL_MS;
    return null;
  }
}

export async function listMilitaryFlights(
  ctx: ServerContext,
  req: ListMilitaryFlightsRequest,
): Promise<ListMilitaryFlightsResponse> {
  try {
    if (!req.neLat && !req.neLon && !req.swLat && !req.swLon) return emptyResponse();
    const requestBounds = normalizeBounds(req);

    // Quantize bbox to a 1° grid so nearby map views share cache entries.
    // Precise coordinates caused near-zero hit rate since every pan/zoom created a unique key.
    const quantizedBB = [
      quantize(req.swLat, BBOX_GRID_STEP),
      quantize(req.swLon, BBOX_GRID_STEP),
      quantize(req.neLat, BBOX_GRID_STEP),
      quantize(req.neLon, BBOX_GRID_STEP),
    ].join(':');
    // Key by the quantized bbox only. The cached value is the complete
    // expanded-cell snapshot, so page size and cursor must NOT fragment it —
    // every page/cursor for the same cell shares one upstream fetch and one
    // entry, and pagination is applied per-request after retrieval.
    const cacheKey = `${REDIS_CACHE_KEY}:${quantizedBB}:${req.operator || ''}:${req.aircraftType || ''}`;

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
        if (liveSeedCovers(requestBounds)) {
          const seeded = await fetchLiveSeedSnapshot();
          if (seeded.status === 'hit') {
            return { flights: seeded.flights, clusters: [], pagination: undefined };
          }
          if (seeded.status === 'error') {
            // A Redis command/read failure is not proof the snapshot is
            // missing. Throw before any provider call so cachedFetchJson's
            // bounded negative path prevents per-bbox OpenSky amplification.
            throw new Error('military live seed read failed');
          }
        }

        const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
        const relayBase = isSidecar ? null : getRelayBaseUrl();
        const baseUrl = isSidecar ? 'https://opensky-network.org/api/states/all' : relayBase ? relayBase + '/opensky' : null;

        if (!baseUrl) return null;

        const fetchBB = {
          lamin: quantize(req.swLat, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
          lamax: quantize(req.neLat, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
          lomin: quantize(req.swLon, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
          lomax: quantize(req.neLon, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
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
          const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
            string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
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

        return flights.length > 0 ? { flights, clusters: [], pagination: undefined } : null;
      },
    );

    if (!fullResult) {
      // Live fetch failed. The legacy /api/military-flights handler cascaded
      // military:flights:v1 → military:flights:stale:v1 before returning empty.
      // The seed cron (scripts/seed-military-flights.mjs) writes both keys
      // every run; stale has a 24h TTL versus 10min live, so it's the right
      // fallback when OpenSky / the relay hiccups.
      const staleFlights = await fetchStaleFallback();
      if (staleFlights && staleFlights.length > 0) {
        return paginateResponse(staleFlights, [], requestBounds, req);
      }
      markNoCacheResponse(ctx.request);
      return emptyResponse();
    }
    return paginateResponse(fullResult.flights, fullResult.clusters, requestBounds, req);
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
    // the two former producer regions. fetchStaleFallback swallows its own
    // errors and returns null, so it cannot re-throw into this handler.
    const staleFlights = await fetchStaleFallback();
    if (staleFlights && staleFlights.length > 0) {
      return paginateResponse(staleFlights, [], normalizeBounds(req), req);
    }
    markNoCacheResponse(ctx.request);
    return emptyResponse();
  }
}
