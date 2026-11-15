/**
 * RPC: getWatchedSiteImagery -- the free map-popup read (KTD16). It is keyed by a
 * watched site's registry id, never by a point, so a user's own point never
 * reaches the server. It returns only what the free tier gets on map objects:
 * the newest image, its date and the next pass. The change flag, coverage and
 * pass history stay off this path. A reservoir site also gets its newest radar
 * water-extent reading, for the water card (#10714).
 */
import type {
  GetWatchedSiteImageryRequest,
  GetWatchedSiteImageryResponse,
  ServerContext,
  WaterExtent,
  WaterReading,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ORBITAL_SITE_KEY_PREFIX, ORBITAL_WATER_EXTENT_LATEST_KEY } from '../../../_shared/cache-keys';
import { getCachedJson, readCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { ROLLUP_MAX_AGE_MS, SITES_SCHEMA } from '../../../../shared/orbital/country-rollup.js';

/** Registry ids are "<origin list>:<entry id>" (shared/watched-sites.ts). */
// The registry's id alphabet; one base id keeps a non-breaking space from its source name.
export const WATCHED_SITE_ID = /^(hotspot|conflict-zone|military-base|nuclear-facility|port|chokepoint|reservoir):[a-z0-9_\u00a0-]{1,96}$/;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A record is served only when it is the site's, in the current schema and fresh enough. */
export function toWatchedSiteImagery(siteId: string, record: unknown, nowMs: number): GetWatchedSiteImageryResponse {
  const empty: GetWatchedSiteImageryResponse = { siteId, name: '', lat: 0, lon: 0, evaluatedAt: 0, stale: true };
  if (!isRecord(record) || record.schema !== SITES_SCHEMA || record.siteId !== siteId) return empty;
  const base = { siteId, name: str(record.name), lat: num(record.lat), lon: num(record.lon), evaluatedAt: num(record.evaluatedAt) };
  if (nowMs - base.evaluatedAt > ROLLUP_MAX_AGE_MS) return { ...base, stale: true };
  const observation = isRecord(record.lastObservation) ? record.lastObservation : null;
  const next = Array.isArray(record.nextWindows)
    ? record.nextWindows.filter(isRecord).find((window) => Date.parse(str(window.time)) > nowMs) ?? null
    : null;
  const cloud = observation?.cloudCover;
  return {
    ...base,
    stale: false,
    ...(observation && str(observation.itemId) && {
      latestImage: {
        itemId: str(observation.itemId),
        collection: str(observation.collection),
        profileId: str(observation.profileId),
        datetime: str(observation.datetime),
        ...(typeof cloud === 'number' && Number.isFinite(cloud) && { cloudCoverPct: cloud }),
      },
    }),
    ...(next && { nextPass: { satellite: str(next.name), profileId: str(next.profileId), time: str(next.time) } }),
  };
}

const RESERVOIR_SITE = /^reservoir:/;

function toWaterReading(value: unknown): WaterReading | null {
  if (!isRecord(value)) return null;
  const timeMs = Date.parse(str(value.time));
  const waterPercent = value.waterPercent;
  if (!Number.isFinite(timeMs) || typeof waterPercent !== 'number' || !Number.isFinite(waterPercent)) return null;
  return { timeMs, waterPercent, waterKm2: num(value.waterKm2), platform: str(value.platform), relativeOrbit: Math.trunc(num(value.relativeOrbit)) };
}

/** The site's entry in the water-extent summary; null when it has no reading. */
export function toWaterExtent(siteId: string, summary: unknown): WaterExtent | null {
  if (!isRecord(summary) || !isRecord(summary.reservoirs)) return null;
  const entry = summary.reservoirs[siteId];
  if (!isRecord(entry)) return null;
  const latest = toWaterReading(entry.latest);
  if (!latest) return null;
  const previous = toWaterReading(entry.sameOrbitPrevious);
  const comparable = previous && latest.relativeOrbit > 0 && previous.relativeOrbit === latest.relativeOrbit
    && previous.timeMs < latest.timeMs;
  return { latest, ...(comparable && { sameOrbitPrevious: previous }), boxKm2: num(entry.areaKm2) };
}

export async function getWatchedSiteImagery(
  ctx: ServerContext,
  req: GetWatchedSiteImageryRequest,
): Promise<GetWatchedSiteImageryResponse> {
  const siteId = req.siteId ?? '';
  if (!WATCHED_SITE_ID.test(siteId)) {
    throw new ValidationError([{ field: 'site_id', description: 'site_id must be a watched-site registry id such as "port:jebel_ali"' }]);
  }
  const [record, summary] = await Promise.all([
    getCachedJson(`${ORBITAL_SITE_KEY_PREFIX}${siteId}`, true),
    RESERVOIR_SITE.test(siteId) ? readCachedJson(ORBITAL_WATER_EXTENT_LATEST_KEY, true) : null,
  ]);
  const summaryFailed = summary?.status === 'error';
  const waterExtent = summary?.status === 'hit' ? toWaterExtent(siteId, summary.value) : null;
  const response = {
    ...toWatchedSiteImagery(siteId, record, Date.now()),
    ...(waterExtent && { waterExtent }),
    ...(summaryFailed && { waterExtentUnavailable: true }),
  };
  return response.stale || summaryFailed ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
