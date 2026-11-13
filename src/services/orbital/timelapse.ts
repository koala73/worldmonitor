import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { ArchiveFailure, ArchiveRequestOptions } from './archive-result';
import { searchStacArchive, type ImagingProfileId, type StacArchiveId } from './archive-stac';
import { cropBox, planetaryComputerCropUrl } from './crop-url';
import { assembleEvidence, type MatchedAcquisition } from './match';

const DAY_MS = 86_400_000;
/** How far back the compare dates look. */
export const HISTORY_DAYS = 60;
/** Cloud over the scene at or above which a look would mostly show cloud. */
export const CLEAR_LOOK_CLOUD_PCT = 30;
/** The compare picker prefers a scene at least this far from the one being viewed. */
export const COMPARE_MIN_GAP_DAYS = 30;
export const MIN_TIMELAPSE_FRAMES = 4;

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

export type LoadImage = (url: string, signal: AbortSignal) => Promise<void>;

export const loadImageElement: LoadImage = (url, signal) => new Promise((resolve, reject) => {
  const image = new Image();
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  const stop = () => {
    image.src = '';
    reject(new DOMException('Aborted', 'AbortError'));
  };
  signal.addEventListener('abort', stop, { once: true });
  image.onload = () => {
    image.decode().catch(() => undefined).then(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    });
  };
  image.onerror = () => {
    signal.removeEventListener('abort', stop);
    reject(new Error('frame failed to load'));
  };
  image.src = url;
});

/** Loads every frame before playback; a frame that fails is dropped and the rest keep their order. */
export async function preloadFrames<T extends { imageUrl: string | null }>(
  frames: readonly T[],
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void = () => {},
  loadImage: LoadImage = loadImageElement,
): Promise<T[]> {
  let settled = 0;
  const outcomes = await Promise.all(frames.map(async (frame) => {
    try {
      await loadImage(frame.imageUrl!, signal);
      return true;
    } catch {
      return false;
    } finally {
      settled++;
      if (!signal.aborted) onProgress(settled, frames.length);
    }
  }));
  return frames.filter((_, i) => outcomes[i]);
}

/** The first year Sentinel-2 imaged anywhere. */
export const FIRST_LOOK_YEAR = 2015;
/** Each year searches a different quarter, so the run of looks crosses every season. */
const SEASON_START_MONTH = [9, 0, 3, 6];
const SEASON_MONTHS = 3;

export interface YearlyLook extends DatedScene {
  year: number;
  /** "S2A", "S2B", "S2C". */
  platformCode: string;
  platform: string;
}

export interface YearlyLooks {
  looks: YearlyLook[];
  failures: ArchiveFailure[];
}

export function seasonWindow(year: number): { startMs: number; endMs: number } {
  const month = SEASON_START_MONTH[(year - FIRST_LOOK_YEAR) % SEASON_START_MONTH.length]!;
  return { startMs: Date.UTC(year, month, 1), endMs: Date.UTC(year, month + SEASON_MONTHS, 1) - 1 };
}

/** One clear Sentinel-2 look per year since 2015, the lowest-cloud scene of that year's season; a year with none is left out. */
export async function searchYearlyLooks(point: GeoPoint, nowMs: number, options: ArchiveRequestOptions = {}): Promise<YearlyLooks> {
  const box = cropBox(point);
  const years = Array.from({ length: new Date(nowMs).getUTCFullYear() - FIRST_LOOK_YEAR + 1 }, (_, i) => FIRST_LOOK_YEAR + i);
  const results = await Promise.all(years.map(async (year) => {
    const season = seasonWindow(year);
    if (season.startMs > nowMs) return null;
    return { year, result: await searchStacArchive('planetary-computer', { ...options, point, window: { startMs: season.startMs, endMs: Math.min(season.endMs, nowMs) } }) };
  }));
  const looks: YearlyLook[] = [];
  const failures: ArchiveFailure[] = [];
  for (const entry of results) {
    if (!entry) continue;
    if (entry.result.status === 'failed') {
      failures.push(entry.result.failure);
      continue;
    }
    const clearest = entry.result.items
      .filter((item) => item.profileId === 'sentinel-2' && item.cloudCoverPct !== null && item.cloudCoverPct < CLEAR_LOOK_CLOUD_PCT)
      .sort((a, b) => a.cloudCoverPct! - b.cloudCoverPct!)
      .map((item) => ({ item, imageUrl: planetaryComputerCropUrl(item.collection, item.itemId, box) }))
      .find((candidate) => candidate.imageUrl);
    if (!clearest) continue;
    const { item, imageUrl } = clearest;
    looks.push({
      key: `${item.collection}:${item.itemId}`,
      year: entry.year,
      timeMs: item.startMs,
      cloudCoverPct: item.cloudCoverPct,
      cloudApplies: true,
      imageUrl,
      platform: item.platform,
      platformCode: `S2${item.platform.slice(-1).toUpperCase()}`,
    });
  }
  return { looks: looks.sort((a, b) => a.timeMs - b.timeMs), failures };
}
