import type {
  ServerContext,
  GetVesselSnapshotRequest,
  GetVesselSnapshotResponse,
  VesselSnapshot,
  AisDensityZone,
  AisDisruption,
  AisDisruptionType,
  AisDisruptionSeverity,
  SnapshotCandidateReport,
} from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';

// ========================================================================
// Helpers
// ========================================================================

const DISRUPTION_TYPE_MAP: Record<string, AisDisruptionType> = {
  gap_spike: 'AIS_DISRUPTION_TYPE_GAP_SPIKE',
  chokepoint_congestion: 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION',
};

const SEVERITY_MAP: Record<string, AisDisruptionSeverity> = {
  low: 'AIS_DISRUPTION_SEVERITY_LOW',
  elevated: 'AIS_DISRUPTION_SEVERITY_ELEVATED',
  high: 'AIS_DISRUPTION_SEVERITY_HIGH',
};

// In-process cache TTLs.
//
// The base snapshot (no candidates, no tankers, no bbox) is the high-traffic
// path consumed by the AIS-density layer + military-detection consumers. It
// re-uses the existing 5-minute cache because density / disruptions only
// change once per relay cycle.
//
// Tanker (live-tanker map layer) and bbox-filtered responses MUST refresh
// every 60s to honor the live-tanker freshness contract — anything longer
// shows stale vessel positions and collapses distinct bboxes onto one
// payload, defeating the bbox parameter entirely.
const SNAPSHOT_CACHE_TTL_BASE_MS = 300_000; // 5 min for non-bbox / non-tanker reads
const SNAPSHOT_CACHE_TTL_LIVE_MS = 60_000;  // 60 s for live tanker / bbox reads

// 1° bbox quantization for cache-key reuse: a user panning a few decimal
// degrees should hit the same cache slot as another user nearby. Done
// server-side so the gateway 'live' tier sees identical query strings and
// the CDN absorbs the request before it reaches this handler.
function quantize(v: number): number {
  return Math.floor(v);
}

interface SnapshotCacheSlot {
  snapshot: VesselSnapshot | undefined;
  timestamp: number;
  inFlight: Promise<VesselSnapshot | undefined> | null;
}

// Cache keyed by request shape: candidates, tankers, and quantized bbox.
// Replaces the prior `with|without` keying which would silently serve
// stale tanker data and collapse distinct bboxes.
//
// LRU-bounded: each distinct (includeCandidates, includeTankers, quantizedBbox)
// triple creates a slot. With 1° quantization and a misbehaving client, the
// keyspace is ~64,000 (180×360); without a cap the Map would grow unbounded
// across the lifetime of the serverless instance. Realistic load is ~12 slots
// (6 chokepoints × 2 flag combos), so a 128-slot cap leaves >10x headroom for
// edge panning while making OOM impossible.
const SNAPSHOT_CACHE_MAX_SLOTS = 128;
const cache = new Map<string, SnapshotCacheSlot>();

function touchSlot(key: string, slot: SnapshotCacheSlot): void {
  // Move to end of insertion order so it's most-recently-used. Map iteration
  // order = insertion order, so the first entry is the LRU candidate.
  cache.delete(key);
  cache.set(key, slot);
}

function evictIfNeeded(): void {
  if (cache.size < SNAPSHOT_CACHE_MAX_SLOTS) return;
  // Walk insertion order; evict the first slot that has no in-flight fetch.
  // An in-flight slot is still in use by an awaiting caller — evicting it
  // would orphan the promise.
  for (const [k, s] of cache) {
    if (s.inFlight === null) {
      cache.delete(k);
      return;
    }
  }
  // All slots in flight — nothing to evict. Caller still inserts; we
  // accept temporary growth past the cap until in-flight settles.
}

function cacheKeyFor(
  includeCandidates: boolean,
  includeTankers: boolean,
  bbox: { swLat: number; swLon: number; neLat: number; neLon: number } | null,
): string {
  const c = includeCandidates ? '1' : '0';
  const t = includeTankers ? '1' : '0';
  if (!bbox) return `${c}${t}|null`;
  const sl = quantize(bbox.swLat);
  const so = quantize(bbox.swLon);
  const nl = quantize(bbox.neLat);
  const no = quantize(bbox.neLon);
  return `${c}${t}|${sl},${so},${nl},${no}`;
}

function ttlFor(includeTankers: boolean, bbox: unknown): number {
  return includeTankers || bbox ? SNAPSHOT_CACHE_TTL_LIVE_MS : SNAPSHOT_CACHE_TTL_BASE_MS;
}

async function fetchVesselSnapshot(
  includeCandidates: boolean,
  includeTankers: boolean,
  bbox: { swLat: number; swLon: number; neLat: number; neLon: number } | null,
): Promise<VesselSnapshot | undefined> {
  const key = cacheKeyFor(includeCandidates, includeTankers, bbox);
  let slot = cache.get(key);
  if (!slot) {
    evictIfNeeded();
    slot = { snapshot: undefined, timestamp: 0, inFlight: null };
    cache.set(key, slot);
  }
  const now = Date.now();
  const ttl = ttlFor(includeTankers, bbox);
  if (slot.snapshot && (now - slot.timestamp) < ttl) {
    touchSlot(key, slot);
    return slot.snapshot;
  }

  if (slot.inFlight) {
    touchSlot(key, slot);
    return slot.inFlight;
  }

  slot.inFlight = fetchVesselSnapshotFromRelay(includeCandidates, includeTankers, bbox);
  try {
    const result = await slot.inFlight;
    if (result) {
      slot.snapshot = result;
      slot.timestamp = Date.now();
      touchSlot(key, slot);
    }
    return result ?? slot.snapshot; // serve stale on relay failure
  } finally {
    slot.inFlight = null;
  }
}

function toCandidateReport(raw: any): SnapshotCandidateReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const mmsi = String(raw.mmsi ?? '');
  if (!mmsi) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    mmsi,
    name: String(raw.name ?? ''),
    lat,
    lon,
    shipType: Number.isFinite(Number(raw.shipType)) ? Number(raw.shipType) : 0,
    heading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : 0,
    speed: Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : 0,
    course: Number.isFinite(Number(raw.course)) ? Number(raw.course) : 0,
    timestamp: Number.isFinite(Number(raw.timestamp)) ? Number(raw.timestamp) : Date.now(),
  };
}

async function fetchVesselSnapshotFromRelay(
  includeCandidates: boolean,
  includeTankers: boolean,
  bbox: { swLat: number; swLon: number; neLat: number; neLon: number } | null,
): Promise<VesselSnapshot | undefined> {
  try {
    const relayBaseUrl = getRelayBaseUrl();
    if (!relayBaseUrl) return undefined;

    const params = new URLSearchParams();
    params.set('candidates', includeCandidates ? 'true' : 'false');
    if (includeTankers) params.set('tankers', 'true');
    if (bbox) {
      // Quantized bbox: prevents the relay from caching one URL per
      // floating-point pixel as users pan. Same quantization as the
      // handler-side cache key so they stay consistent.
      const sl = quantize(bbox.swLat);
      const so = quantize(bbox.swLon);
      const nl = quantize(bbox.neLat);
      const no = quantize(bbox.neLon);
      params.set('bbox', `${sl},${so},${nl},${no}`);
    }

    const response = await fetch(
      `${relayBaseUrl}/ais/snapshot?${params.toString()}`,
      {
        headers: getRelayHeaders(),
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) return undefined;

    const data = await response.json();
    if (!data || !Array.isArray(data.disruptions) || !Array.isArray(data.density)) {
      return undefined;
    }

    const densityZones: AisDensityZone[] = data.density.map((z: any): AisDensityZone => ({
      id: String(z.id || ''),
      name: String(z.name || ''),
      location: {
        latitude: Number(z.lat) || 0,
        longitude: Number(z.lon) || 0,
      },
      intensity: Number(z.intensity) || 0,
      deltaPct: Number(z.deltaPct) || 0,
      shipsPerDay: Number(z.shipsPerDay) || 0,
      note: String(z.note || ''),
    }));

    const disruptions: AisDisruption[] = data.disruptions.map((d: any): AisDisruption => ({
      id: String(d.id || ''),
      name: String(d.name || ''),
      type: DISRUPTION_TYPE_MAP[d.type] || 'AIS_DISRUPTION_TYPE_UNSPECIFIED',
      location: {
        latitude: Number(d.lat) || 0,
        longitude: Number(d.lon) || 0,
      },
      severity: SEVERITY_MAP[d.severity] || 'AIS_DISRUPTION_SEVERITY_UNSPECIFIED',
      changePct: Number(d.changePct) || 0,
      windowHours: Number(d.windowHours) || 0,
      darkShips: Number(d.darkShips) || 0,
      vesselCount: Number(d.vesselCount) || 0,
      region: String(d.region || ''),
      description: String(d.description || ''),
    }));

    const rawStatus = (data.status && typeof data.status === 'object') ? data.status : {};
    const candidateReports = (includeCandidates && Array.isArray(data.candidateReports))
      ? data.candidateReports.map(toCandidateReport).filter((r: SnapshotCandidateReport | null): r is SnapshotCandidateReport => r !== null)
      : [];
    const tankerReports = (includeTankers && Array.isArray(data.tankerReports))
      ? data.tankerReports.map(toCandidateReport).filter((r: SnapshotCandidateReport | null): r is SnapshotCandidateReport => r !== null)
      : [];

    return {
      snapshotAt: Date.now(),
      densityZones,
      disruptions,
      sequence: Number.isFinite(Number(data.sequence)) ? Number(data.sequence) : 0,
      status: {
        connected: Boolean(rawStatus.connected),
        vessels: Number.isFinite(Number(rawStatus.vessels)) ? Number(rawStatus.vessels) : 0,
        messages: Number.isFinite(Number(rawStatus.messages)) ? Number(rawStatus.messages) : 0,
      },
      candidateReports,
      tankerReports,
    };
  } catch {
    return undefined;
  }
}

// ========================================================================
// RPC handler
// ========================================================================

// Bbox-size guard: reject requests where either dimension exceeds 10°. This
// prevents a malicious or buggy client from requesting a global box and
// pulling every tanker through one query.
const MAX_BBOX_DEGREES = 10;

/**
 * 400-class bbox validation error. Carries `statusCode = 400` so
 * server/error-mapper.ts surfaces it as HTTP 400 (the mapper branches
 * on `'statusCode' in error`; a plain Error would fall through to
 * "unhandled error" → 500). Used for both the size guard and the
 * lat/lon range guard.
 *
 * Range checks matter because the relay silently DROPS a malformed
 * bbox param and serves a global capped tanker subset — making the
 * layer appear to "work" with stale data instead of failing loudly.
 */
export class BboxValidationError extends Error {
  readonly statusCode = 400;
  constructor(reason: string) {
    super(`bbox invalid: ${reason}`);
    this.name = 'BboxValidationError';
  }
}

// Backwards-compatible alias for tests that imported BboxTooLargeError.
// Prefer BboxValidationError for new code.
export const BboxTooLargeError = BboxValidationError;

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

function extractAndValidateBbox(req: GetVesselSnapshotRequest): { swLat: number; swLon: number; neLat: number; neLon: number } | null {
  const sw = { lat: Number(req.swLat), lon: Number(req.swLon) };
  const ne = { lat: Number(req.neLat), lon: Number(req.neLon) };
  // All zeroes (the default for unset proto doubles) → no bbox.
  if (sw.lat === 0 && sw.lon === 0 && ne.lat === 0 && ne.lon === 0) {
    return null;
  }
  if (!isValidLatLon(sw.lat, sw.lon)) {
    throw new BboxValidationError('sw corner outside lat/lon domain (-90..90 / -180..180)');
  }
  if (!isValidLatLon(ne.lat, ne.lon)) {
    throw new BboxValidationError('ne corner outside lat/lon domain (-90..90 / -180..180)');
  }
  if (sw.lat > ne.lat || sw.lon > ne.lon) {
    throw new BboxValidationError('sw corner must be south-west of ne corner');
  }
  if (ne.lat - sw.lat > MAX_BBOX_DEGREES || ne.lon - sw.lon > MAX_BBOX_DEGREES) {
    throw new BboxValidationError(`each dimension must be ≤ ${MAX_BBOX_DEGREES} degrees`);
  }
  return { swLat: sw.lat, swLon: sw.lon, neLat: ne.lat, neLon: ne.lon };
}

export async function getVesselSnapshot(
  _ctx: ServerContext,
  req: GetVesselSnapshotRequest,
): Promise<GetVesselSnapshotResponse> {
  try {
    const bbox = extractAndValidateBbox(req);
    const snapshot = await fetchVesselSnapshot(
      Boolean(req.includeCandidates),
      Boolean(req.includeTankers),
      bbox,
    );
    return { snapshot };
  } catch (err) {
    // BboxValidationError carries statusCode=400; rethrowing lets the
    // gateway error-mapper surface it as HTTP 400 with the reason string.
    if (err instanceof BboxValidationError) throw err;
    return { snapshot: undefined };
  }
}
