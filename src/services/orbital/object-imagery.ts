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
import type { GetWatchedSiteImageryResponse, WaterExtent } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import { OrbitalServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import type { ArchiveId } from './archive-result';
import { searchStacArchive } from './archive-stac';
import { cropBox, planetaryComputerCropUrl } from './crop-url';
import { assembleEvidence } from './match';
import { loadOrbitalCatalog } from './catalog';
import { createOrbitalPassClient, type OrbitalPassClient, type PointPassLookup } from './pass-client';
import { BoundedCache, shareWork, type SharedWork } from './request-cache';

export type ImageryTarget =
  | { kind: 'site'; origin: WatchedSiteOrigin; point: GeoPoint }
  /**
   * `ownNextPass`: the popup already names the object's next measurement, so the row leaves its next pass out.
   * `optical`: only an optical scene counts as the latest image (a reservoir's radar reading has its own row).
   */
  | { kind: 'point'; point: GeoPoint; ownNextPass?: true; optical?: true };

export interface ObjectImage {
  datetime: string;
  profileId: string;
  archive: ArchiveId;
  /** May carry the point: paint through `loadArchiveImage`, never straight into `img.src`. */
  candidates: string[];
}

export interface ObjectPass { satellite: string; profileId: string; timeMs: number }

export interface ObjectImagery {
  latest: ObjectImage | null;
  /** True when `latest` is null because an archive did not answer, not because it has no image. */
  imageSearchFailed?: boolean;
  nextPass: ObjectPass | null;
  /** Set on an early answer whose image is ready while the next pass is still computing. */
  nextPassPending?: true;
}

/** Called with the image as soon as it is known, while the next pass is still computing. */
export type OnImageReady = (early: ObjectImagery) => void;

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
  const url = image ? planetaryComputerCropUrl(image, cropBox({ lat: response.lat, lon: response.lon })) : null;
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
/** The next-pass stat needs only the future part of a pass lookup. */
export const NEXT_PASS_HOURS = 72;
const HOUR_MS = 3_600_000;
/** How long "no pass within the window" stands before the window has slid enough to look again. */
const NO_PASS_FRESH_MS = HOUR_MS;

// The client is shared, and a new lookup cancels the running one, so a closed popup must not start one.
const lookupPasses = async (point: GeoPoint, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  return (passClient ??= createOrbitalPassClient()).lookup({ point, pastDays: 0, futureHours: NEXT_PASS_HOURS }, { signal });
};

function nextPassOf(passes: PointPassLookup['passes'], nowMs: number): ObjectPass | null {
  const next = passes.filter((p) => p.inFootprint && p.timeMs > nowMs).sort((a, b) => a.timeMs - b.timeMs)[0];
  return next ? { satellite: next.name, profileId: next.profileId, timeMs: next.timeMs } : null;
}

interface NextPassAnswer { pass: ObjectPass | null; revision: string }
const catalogRevision = (catalog: { fetchedAt: number; inventoryVersion: string }) => `${catalog.inventoryVersion}@${catalog.fetchedAt}`;
const nextPasses = new BoundedCache<SharedWork<NextPassAnswer>>(32);
/** Forgets every remembered next pass. */
export function forgetNextPasses(): void {
  for (const [key] of nextPasses.live(Number.NEGATIVE_INFINITY)) nextPasses.delete(key);
}
const aborted = () => { throw new DOMException('Aborted', 'AbortError'); };

/**
 * The next in-footprint pass over a point, from the local pass worker. Kept in
 * browser memory by point and catalog revision until that pass happens, and
 * shared by popups that ask at the same time.
 */
async function nextPassAt(point: GeoPoint, signal?: AbortSignal): Promise<ObjectPass | null> {
  signal?.throwIfAborted();
  const key = `${point.lat},${point.lon}`;
  const cached = nextPasses.get(key, Date.now());
  if (cached && !cached.abandoned) {
    const answer = await cached.join(signal, aborted);
    const current = await loadOrbitalCatalog().then(catalogRevision, () => answer.revision);
    signal?.throwIfAborted();
    if (current === answer.revision && (!answer.pass || answer.pass.timeMs > Date.now())) return answer.pass;
    nextPasses.delete(key, cached);
    const installed = nextPasses.get(key, Date.now());
    if (installed && !installed.abandoned) return (await installed.join(signal, aborted)).pass;
  }
  const work = shareWork(async (shared) => {
    const lookup = await lookupPasses(point, shared);
    return { pass: nextPassOf(lookup.passes, Date.now()), revision: catalogRevision(lookup.catalog) };
  });
  nextPasses.set(key, work, Date.now() + NEXT_PASS_HOURS * HOUR_MS);
  work.done.then(
    (answer) => { if (nextPasses.get(key, Date.now()) === work) nextPasses.set(key, work, answer.pass?.timeMs ?? Date.now() + NO_PASS_FRESH_MS); },
    () => nextPasses.delete(key, work),
  );
  return (await work.join(signal, aborted)).pass;
}

/**
 * How far back a popup looks for its latest image. It reaches past the popup's
 * 14-day stale mark, so an old image shows as old rather than as no image.
 */
export const LATEST_IMAGE_DAYS = 30;
const RADAR_PROFILE_ID = 'sentinel-1';
const DAY_MS = 86_400_000;

type LatestImage = Pick<ObjectImagery, 'latest' | 'imageSearchFailed'>;

/** The newest scene at the point; a failed archive reads as unavailable, not as no image. */
async function latestImageAt(point: GeoPoint, signal?: AbortSignal, optical = false): Promise<LatestImage> {
  const nowMs = Date.now();
  const window = { startMs: nowMs - LATEST_IMAGE_DAYS * DAY_MS, endMs: nowMs };
  const stac = await Promise.all((['earth-search', 'planetary-computer'] as const).map((archive) => searchStacArchive(archive, { point, window, signal })));
  signal?.throwIfAborted();
  // The image of an acquisition does not depend on its pass, so no pass lookup is needed here.
  const evidence = assembleEvidence({ lookup: { point, nowMs, passes: [] }, stac });
  const newest = evidence.acquisitions.find((a) => a.imageUrl && !(optical && a.profileId === RADAR_PROFILE_ID));
  return {
    latest: newest?.imageUrl
      ? { datetime: new Date(newest.startMs).toISOString(), profileId: newest.profileId, archive: archiveOf(newest.imageUrl), candidates: [newest.imageUrl] }
      : null,
    imageSearchFailed: !newest && evidence.failures.length > 0,
  };
}

const isAbort = (error: unknown, signal?: AbortSignal) => signal?.aborted || (error instanceof Error && error.name === 'AbortError');

/** Waits for the next pass after the image is known, handing the image over early when the pass is slower. */
async function withNextPass(image: LatestImage, pass: Promise<ObjectPass | null>, onImageReady: OnImageReady | undefined, signal?: AbortSignal): Promise<ObjectImagery> {
  let passDone = false;
  const settledPass = pass.then(
    (nextPass) => { passDone = true; return nextPass; },
    (error: unknown) => { passDone = true; if (isAbort(error, signal)) throw error; return null; },
  );
  await Promise.resolve();
  if (!passDone) onImageReady?.({ ...image, nextPass: null, nextPassPending: true });
  const nextPass = await settledPass;
  return { ...image, nextPass: nextPass && nextPass.timeMs > Date.now() ? nextPass : null };
}

/**
 * Answered entirely in the browser: the point goes to the pass worker and the
 * public archives only. `wantNextPass: false` starts no pass job at all.
 */
export async function lookupPointImagery(point: GeoPoint, signal?: AbortSignal, options: { wantNextPass?: boolean; onImageReady?: OnImageReady; optical?: boolean } = {}): Promise<ObjectImagery> {
  signal?.throwIfAborted();
  const optical = options.optical === true;
  if (options.wantNextPass === false) return { ...(await latestImageAt(point, signal, optical)), nextPass: null };
  const pass = nextPassAt(point, signal);
  pass.catch(() => {});
  return withNextPass(await latestImageAt(point, signal, optical), pass, options.onImageReady, signal);
}

/** A strategic reservoir's newest radar water-extent reading, read by its watched-site id; null when it has none. */
export async function loadReservoirWaterExtent(reservoirId: string, signal?: AbortSignal): Promise<WaterExtent | null> {
  const siteId = await resolveWatchedSiteId({ list: 'reservoir', id: reservoirId });
  if (!siteId) return null;
  const record = await getOrbitalClient().getWatchedSiteImagery({ siteId }, { signal });
  if (record.waterExtentUnavailable) throw new Error('radar water-extent summary unavailable');
  return record.waterExtent ?? null;
}

export async function loadObjectImagery(target: ImageryTarget, signal?: AbortSignal, onImageReady?: OnImageReady): Promise<ObjectImagery> {
  if (target.kind === 'site') {
    const siteId = await resolveWatchedSiteId(target.origin);
    if (siteId) {
      const record = await getOrbitalClient().getWatchedSiteImagery({ siteId }, { signal }).catch(() => null);
      const imagery = record ? fromSiteRecord(record, Date.now()) : null;
      // A CDN-cached record can name a pass that has since happened; the pass worker finds the next one locally.
      if (imagery && !imagery.nextPass) {
        if (signal?.aborted) return imagery;
        // Only this popup closing is an abort: a newer lookup superseding this one on the shared client keeps the record image.
        return withNextPass(imagery, nextPassAt(target.point, signal), onImageReady, signal).catch((error: unknown) => {
          if (signal?.aborted) throw error;
          return imagery;
        });
      }
      if (imagery) return imagery;
    }
  }
  const point = target.kind === 'point' ? target : null;
  return lookupPointImagery(target.point, signal, { wantNextPass: !point?.ownNextPass, onImageReady, optical: point?.optical === true });
}
