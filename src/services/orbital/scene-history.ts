import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { LoadedArchiveImage } from './archive-image';
import type { ArchiveFailure, ArchiveId, ArchiveRequestOptions } from './archive-result';
import { searchStacArchive, type ImagingProfileId, type StacArchiveId } from './archive-stac';
import { cropBox, EUMETSAT_WMS_ENDPOINT, GIBS_WMS_ENDPOINT } from './crop-url';
import { assembleEvidence, type MatchedAcquisition } from './match';

const DAY_MS = 86_400_000;
/** How far back the compare dates look. */
export const HISTORY_DAYS = 60;
/** Cloud over the scene at or above which a look would mostly show cloud. */
export const CLEAR_LOOK_CLOUD_PCT = 30;
/** The compare picker prefers a scene at least this far from the one being viewed. */
export const COMPARE_MIN_GAP_DAYS = 30;

export type ImageGrid = 'north-up' | 'unreferenced';

const PLANETARY_COMPUTER_CROP_PATH = '/api/data/v1/item/bbox/';

/** Crops this lookup builds are all requested in a latitude-longitude grid, so north is up. */
export function imageGrid(url: string): ImageGrid {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'planetarycomputer.microsoft.com' && parsed.pathname.startsWith(PLANETARY_COMPUTER_CROP_PATH)) return 'north-up';
    const base = `${parsed.origin}${parsed.pathname}`;
    if ((base === GIBS_WMS_ENDPOINT || base === EUMETSAT_WMS_ENDPOINT) && parsed.searchParams.get('CRS') === 'EPSG:4326') return 'north-up';
  } catch {
    return 'unreferenced';
  }
  return 'unreferenced';
}

/** The archive whose items render a crop around the point, so frames line up. */
export const HISTORY_ARCHIVE: Record<ImagingProfileId, StacArchiveId> = {
  'sentinel-2': 'planetary-computer',
  landsat: 'planetary-computer',
  'sentinel-1': 'earth-search',
};

export type SceneHistory =
  | { status: 'ok'; scenes: MatchedAcquisition[] }
  | { status: 'failed'; failure: ArchiveFailure };

/** Every scene of one mission at the point over the prior 60 days, one per acquisition, newest first. */
export async function searchSceneHistory(
  point: GeoPoint,
  profileId: ImagingProfileId,
  nowMs: number,
  options: ArchiveRequestOptions = {},
): Promise<SceneHistory> {
  const archive = HISTORY_ARCHIVE[profileId];
  const result = await searchStacArchive(archive, { ...options, point, window: { startMs: nowMs - HISTORY_DAYS * DAY_MS, endMs: nowMs } });
  if (result.status === 'failed') return { status: 'failed', failure: result.failure };
  const items = result.items.filter((item) => item.profileId === profileId);
  const { acquisitions } = assembleEvidence({ lookup: { point, nowMs, passes: [] }, stac: [{ ...result, items }], box: cropBox(point) });
  return { status: 'ok', scenes: acquisitions.filter((scene) => scene.imageUrl) };
}

export interface DatedScene {
  key: string;
  timeMs: number;
  /** Scene-wide cloud, or null where cloud does not apply or is not reported. */
  cloudCoverPct: number | null;
  /** Radar sees through cloud. */
  cloudApplies: boolean;
  imageUrl: string | null;
}

export const isClearScene = (scene: DatedScene): boolean =>
  !scene.cloudApplies || (scene.cloudCoverPct !== null && scene.cloudCoverPct < CLEAR_LOOK_CLOUD_PCT);

const gapMs = (a: DatedScene, b: DatedScene) => Math.abs(a.timeMs - b.timeMs);

/** The nearest clear scene at least 30 days away, else the nearest other scene. */
export function defaultCompareScene<T extends DatedScene>(selected: DatedScene, candidates: readonly T[]): T | null {
  const others = candidates.filter((scene) => scene.key !== selected.key);
  const nearest = (pool: readonly T[]) => pool.reduce<T | null>((best, scene) => (!best || gapMs(scene, selected) < gapMs(best, selected) ? scene : best), null);
  return nearest(others.filter((scene) => isClearScene(scene) && gapMs(scene, selected) >= COMPARE_MIN_GAP_DAYS * DAY_MS)) ?? nearest(others);
}

/** Loads an archive image for painting; rejects when it fails. */
export type LoadImage = (archive: ArchiveId, url: string, signal: AbortSignal) => Promise<LoadedArchiveImage>;
