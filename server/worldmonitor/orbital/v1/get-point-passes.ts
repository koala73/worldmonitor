/**
 * RPC: getPointPasses -- the subscription form of the point lookup. It runs
 * the browser lookup's own pass job and archive matching on the edge, so a
 * pass gets the same tier here as in the app for the same catalog and
 * archive answers. Points are rounded to 0.01 degrees before anything is
 * computed or cached.
 */
import type {
  ArchiveSourceFailure,
  GetPointPassesRequest,
  GetPointPassesResponse,
  ImageAcquisition,
  PointPass,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import type { GeoPoint } from '../../../../shared/orbital/pass-geometry.js';
import type { ArchiveRequestOptions, FetchLike } from '../../../../src/services/orbital/archive-result';
import { searchStacArchive, type StacArchiveId } from '../../../../src/services/orbital/archive-stac';
import { toOrbitalCatalog } from '../../../../src/services/orbital/catalog-shape';
import { assembleEvidence, type MatchedAcquisition } from '../../../../src/services/orbital/match';
import { runPassJob, type PointPass as ComputedPass } from '../../../../src/services/orbital/pass-job';
import { ORBITAL_CATALOG_KEY } from '../../../_shared/cache-keys';
import { getCachedJson, readCachedJson, setCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { toCatalogResponse } from './list-imaging-satellites';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The browser lookup's default window: the last 7 days and the next 72 hours. */
export const POINT_PASS_PAST_DAYS = 7;
export const POINT_PASS_FUTURE_HOURS = 72;
const CACHE_TTL_SECONDS = 600;
const ARCHIVE_TIMEOUT_MS = 12_000;
const USER_AGENT = 'WorldMonitor/1.0 (https://www.worldmonitor.app)';
const STAC_ARCHIVES: readonly StacArchiveId[] = ['earth-search', 'planetary-computer'];

export const roundToCell = (degrees: number) => Math.round(degrees * 100) / 100 + 0;

function coordinate(params: URLSearchParams, name: 'lat' | 'lon', limit: number): number {
  const raw = params.get(name);
  // Absent is an error, never the equator or prime meridian. The generated client omits a zero
  // coordinate, so a caller must send both coordinates itself (the MCP tool does).
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new ValidationError([{ field: name, description: `${name} must be a number from -${limit} to ${limit}` }]);
  }
  return value;
}

export function parsePoint(request: Request): GeoPoint {
  const params = new URL(request.url).searchParams;
  return { lat: roundToCell(coordinate(params, 'lat', 90)), lon: roundToCell(coordinate(params, 'lon', 180)) };
}

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor + 0;
};
const passKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

function toApiPass(pass: ComputedPass, acquisitionKey: string): PointPass {
  return {
    noradId: pass.noradId,
    name: pass.name,
    profileId: pass.profileId,
    category: pass.category,
    timeMs: pass.timeMs,
    opportunity: pass.opportunity,
    groundDistanceKm: round(pass.groundDistanceKm, 1),
    side: pass.side,
    elevationDeg: round(pass.elevationDeg, 1),
    incidenceDeg: round(pass.incidenceDeg, 1),
    sunElevationDeg: round(pass.sunElevationDeg, 1),
    edgeOfSwath: pass.edgeOfSwath,
    coverage: pass.coverage,
    tier: pass.tier.kind,
    tierNote: pass.tier.kind === 'passed-overhead' ? pass.tier.note ?? '' : '',
    orbitAgeDays: round(pass.orbitAgeDays, 2),
    acquisitionKey,
  };
}

function toApiAcquisition(acquisition: MatchedAcquisition): ImageAcquisition {
  return {
    key: acquisition.key,
    profileId: acquisition.profileId,
    platform: acquisition.platform,
    orbit: acquisition.orbit ?? 0,
    startMs: acquisition.startMs,
    endMs: acquisition.endMs,
    itemIds: [...new Set(acquisition.items.map((item) => item.itemId))],
    archives: [...new Set(acquisition.items.map((item) => item.archive))],
    ...(acquisition.cloudCoverPct === null ? {} : { cloudCoverPct: acquisition.cloudCoverPct }),
    resolutionM: acquisition.resolutionM,
    imageUrl: acquisition.imageUrl ?? '',
    passNoradId: acquisition.pass?.noradId ?? 0,
    passTimeMs: acquisition.pass?.timeMs ?? 0,
  };
}

/** Passes and matched images for an already rounded point, from a stored catalog value and live archive searches. */
export async function computePointPasses(
  point: GeoPoint,
  storedCatalog: unknown,
  nowMs: number,
  archive: ArchiveRequestOptions,
): Promise<GetPointPassesResponse> {
  const catalogResponse = toCatalogResponse(storedCatalog, nowMs);
  const catalog = toOrbitalCatalog(catalogResponse);
  const window = { startMs: nowMs - POINT_PASS_PAST_DAYS * DAY_MS, endMs: nowMs + POINT_PASS_FUTURE_HOURS * HOUR_MS };
  const job = await runPassJob({ point, window, nowMs, satellites: catalog.satellites });
  const archiveWindow = { startMs: window.startMs, endMs: Math.min(window.endMs, nowMs) };
  const stac = await Promise.all(STAC_ARCHIVES.map((id) => searchStacArchive(id, { ...archive, point, window: archiveWindow })));
  const evidence = assembleEvidence({ lookup: { point, nowMs, passes: job?.passes ?? [] }, stac });

  const acquisitionByPass = new Map<string, string>();
  for (const acquisition of [...evidence.acquisitions].sort((a, b) => a.startMs - b.startMs)) {
    if (acquisition.pass && !acquisitionByPass.has(passKey(acquisition.pass))) acquisitionByPass.set(passKey(acquisition.pass), acquisition.key);
  }
  const inFootprint = evidence.passes.filter((pass) => pass.inFootprint);
  const failedSources: ArchiveSourceFailure[] = evidence.failures.map((failure) => ({
    archive: failure.archive,
    reason: failure.reason,
    httpStatus: failure.httpStatus ?? 0,
  }));
  return {
    point,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    computedAt: nowMs,
    inventoryVersion: catalogResponse.inventoryVersion,
    catalogFetchedAt: catalogResponse.fetchedAt,
    stale: catalogResponse.stale,
    passes: inFootprint.map((pass) => toApiPass(pass, acquisitionByPass.get(passKey(pass)) ?? '')),
    outOfFootprintPasses: evidence.passes.length - inFootprint.length,
    acquisitions: evidence.acquisitions.map(toApiAcquisition),
    archiveStatus: evidence.status,
    failedSources,
    unansweredProfiles: evidence.unansweredProfiles,
  };
}

const archiveFetch: FetchLike = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  return globalThis.fetch(input, { ...init, headers });
};

export const pointPassesCacheKey = (point: GeoPoint) => `orbital:point-passes:v1:${point.lat.toFixed(2)}:${point.lon.toFixed(2)}`;

export async function getPointPasses(ctx: ServerContext, _req: GetPointPassesRequest): Promise<GetPointPassesResponse> {
  const point = parsePoint(ctx.request);
  const key = pointPassesCacheKey(point);
  const cached = await getCachedJson(key) as GetPointPassesResponse | null;
  if (cached) return cached;

  const read = await readCachedJson(ORBITAL_CATALOG_KEY, true);
  if (read.status === 'error') console.warn(`[orbital-point-passes] ${ORBITAL_CATALOG_KEY} read failed`);
  const response = await computePointPasses(point, read.status === 'hit' ? read.value : null, Date.now(), {
    fetch: archiveFetch,
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  });
  // A partial or stale answer must not outlive the archive or catalog outage that caused it.
  if (response.stale || response.archiveStatus !== 'complete') return markNoStoreFallbackResponse(ctx.request, response);
  await setCachedJson(key, response, CACHE_TTL_SECONDS);
  return response;
}
