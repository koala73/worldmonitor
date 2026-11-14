/**
 * The imagery row of a map object's popup: its newest image and next pass.
 *
 * A watched site (registry base, port, nuclear site, chokepoint or conflict zone)
 * is read from its seeded record by site id, so no point is sent to WorldMonitor.
 * Anything else (reservoirs, conflict events, fires), and a site the seeder has
 * not evaluated, is answered in the browser: passes from the local pass worker,
 * scenes straight from the public archives at the object's own map position.
 * Image URLs carry that position, so they are only ever painted through
 * `loadArchiveImage`.
 */
import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { WatchedSiteOrigin } from '../../../shared/watched-sites';
import type { GetWatchedSiteImageryResponse } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import { OrbitalServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import type { ArchiveId } from './archive-result';
import { searchStacArchive } from './archive-stac';
import { cropBox, planetaryComputerCropUrl } from './crop-url';
import { assembleEvidence } from './match';
import { createOrbitalPassClient, type OrbitalPassClient } from './pass-client';

export type ImageryTarget =
  | { kind: 'site'; origin: WatchedSiteOrigin; point: GeoPoint }
  | { kind: 'point'; point: GeoPoint };

export interface ObjectImage {
  datetime: string;
  profileId: string;
  archive: ArchiveId;
  /** May carry the point: paint through `loadArchiveImage`, never straight into `img.src`. */
  candidates: string[];
}

export interface ObjectImagery {
  latest: ObjectImage | null;
  nextPass: { satellite: string; profileId: string; timeMs: number } | null;
}

const getOrbitalClient = createLazyClient(() => new OrbitalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

let siteIds: Promise<Map<string, string>> | null = null;
const originKey = (origin: WatchedSiteOrigin) => `${origin.list}:${origin.id}`;

/** The registry id of the site an object belongs to; merged objects map to the site that absorbed them. */
export function resolveWatchedSiteId(origin: WatchedSiteOrigin): Promise<string | null> {
  siteIds ??= import('../../../shared/watched-sites').then(({ composeWatchedSites }) => {
    const ids = new Map<string, string>();
    for (const site of composeWatchedSites()) for (const o of site.origins) ids.set(originKey(o), site.id);
    return ids;
  });
  siteIds.catch(() => { siteIds = null; });
  return siteIds.then((ids) => ids.get(originKey(origin)) ?? null);
}

export function fromSiteRecord(response: GetWatchedSiteImageryResponse, nowMs: number): ObjectImagery | null {
  if (response.stale) return null;
  const image = response.latestImage;
  const url = image ? planetaryComputerCropUrl(image.collection, image.itemId, cropBox({ lat: response.lat, lon: response.lon })) : null;
  const passMs = response.nextPass ? Date.parse(response.nextPass.time) : NaN;
  return {
    latest: image && url ? { datetime: image.datetime, profileId: image.profileId, archive: 'planetary-computer', candidates: [url] } : null,
    nextPass: response.nextPass && passMs > nowMs
      ? { satellite: response.nextPass.satellite, profileId: response.nextPass.profileId, timeMs: passMs }
      : null,
  };
}

const archiveOf = (url: string): ArchiveId =>
  new URL(url).hostname === 'planetarycomputer.microsoft.com' ? 'planetary-computer' : 'earth-search';

let passClient: OrbitalPassClient | null = null;

/** Answered entirely in the browser: the point goes to the pass worker and the public archives only. */
export async function lookupPointImagery(point: GeoPoint, signal?: AbortSignal): Promise<ObjectImagery> {
  passClient ??= createOrbitalPassClient();
  const lookup = await passClient.lookup({ point }, { signal });
  const window = { startMs: lookup.window.startMs, endMs: Math.min(lookup.window.endMs, lookup.nowMs) };
  const stac = await Promise.all((['earth-search', 'planetary-computer'] as const)
    .map((archive) => searchStacArchive(archive, { point, window, signal })));
  const evidence = assembleEvidence({ lookup, stac });
  const newest = evidence.acquisitions.find((a) => a.imageUrl);
  const next = lookup.passes.filter((p) => p.timeMs > lookup.nowMs).sort((a, b) => a.timeMs - b.timeMs)[0];
  return {
    latest: newest?.imageUrl
      ? { datetime: new Date(newest.endMs).toISOString(), profileId: newest.profileId, archive: archiveOf(newest.imageUrl), candidates: [newest.imageUrl] }
      : null,
    nextPass: next ? { satellite: next.name, profileId: next.profileId, timeMs: next.timeMs } : null,
  };
}

export async function loadObjectImagery(target: ImageryTarget, signal?: AbortSignal): Promise<ObjectImagery> {
  if (target.kind === 'site') {
    const siteId = await resolveWatchedSiteId(target.origin);
    if (siteId) {
      const record = await getOrbitalClient().getWatchedSiteImagery({ siteId }, { signal }).catch(() => null);
      const imagery = record ? fromSiteRecord(record, Date.now()) : null;
      if (imagery) return imagery;
    }
  }
  return lookupPointImagery(target.point, signal);
}
