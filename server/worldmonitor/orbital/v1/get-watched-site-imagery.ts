/**
 * RPC: getWatchedSiteImagery -- the free map-popup read (KTD16). It is keyed by a
 * watched site's registry id, never by a point, so a user's own point never
 * reaches the server. It returns only what the free tier gets on map objects:
 * the newest image, its date and the next pass. The change flag, coverage and
 * pass history stay off this path.
 */
import type {
  GetWatchedSiteImageryRequest,
  GetWatchedSiteImageryResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ORBITAL_SITE_KEY_PREFIX } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { ORBITAL_ROLLUP_MAX_AGE_MS, ORBITAL_SITES_SCHEMA } from './get-country-imagery-evidence';

/** Registry ids are "<origin list>:<entry id>" (shared/watched-sites.ts). */
// The registry's id alphabet; one base id keeps a non-breaking space from its source name.
export const WATCHED_SITE_ID = /^(hotspot|conflict-zone|military-base|nuclear-facility|port|chokepoint):[a-z0-9_\u00a0]{1,96}$/;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A record is served only when it is the site's, in the current schema and fresh enough. */
export function toWatchedSiteImagery(siteId: string, record: unknown, nowMs: number): GetWatchedSiteImageryResponse {
  const empty: GetWatchedSiteImageryResponse = { siteId, name: '', lat: 0, lon: 0, evaluatedAt: 0, stale: true };
  if (!isRecord(record) || record.schema !== ORBITAL_SITES_SCHEMA || record.siteId !== siteId) return empty;
  const base = { siteId, name: str(record.name), lat: num(record.lat), lon: num(record.lon), evaluatedAt: num(record.evaluatedAt) };
  if (nowMs - base.evaluatedAt > ORBITAL_ROLLUP_MAX_AGE_MS) return { ...base, stale: true };
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

export async function getWatchedSiteImagery(
  ctx: ServerContext,
  req: GetWatchedSiteImageryRequest,
): Promise<GetWatchedSiteImageryResponse> {
  const siteId = req.siteId ?? '';
  if (!WATCHED_SITE_ID.test(siteId)) {
    throw new ValidationError([{ field: 'site_id', description: 'site_id must be a watched-site registry id such as "port:jebel_ali"' }]);
  }
  const record = await getCachedJson(`${ORBITAL_SITE_KEY_PREFIX}${siteId}`, true);
  const response = toWatchedSiteImagery(siteId, record, Date.now());
  return response.stale ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
