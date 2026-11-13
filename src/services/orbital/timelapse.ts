import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { ArchiveFailure, ArchiveRequestOptions } from './archive-result';
import { searchStacArchive, type ImagingProfileId, type StacArchiveId } from './archive-stac';
import { cropBox } from './crop-url';
import { assembleEvidence, type MatchedAcquisition } from './match';

const DAY_MS = 86_400_000;
/** How far back the date strip and the time-lapse look. */
export const HISTORY_DAYS = 60;
/** Scene-wide cloud below which a scene counts as clear enough to compare or animate. */
export const LOW_CLOUD_PCT = 20;
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

export const isLowCloud = (scene: DatedScene): boolean =>
  !scene.cloudApplies || (scene.cloudCoverPct !== null && scene.cloudCoverPct < LOW_CLOUD_PCT);

const gapMs = (a: DatedScene, b: DatedScene) => Math.abs(a.timeMs - b.timeMs);

/** The nearest low-cloud scene at least 30 days away, else the nearest other scene. */
export function defaultCompareScene<T extends DatedScene>(selected: DatedScene, candidates: readonly T[]): T | null {
  const others = candidates.filter((scene) => scene.key !== selected.key);
  const nearest = (pool: readonly T[]) => pool.reduce<T | null>((best, scene) => (!best || gapMs(scene, selected) < gapMs(best, selected) ? scene : best), null);
  return nearest(others.filter((scene) => isLowCloud(scene) && gapMs(scene, selected) >= COMPARE_MIN_GAP_DAYS * DAY_MS)) ?? nearest(others);
}

/** Low-cloud scenes with an image from the prior 60 days, oldest first. */
export function timelapseFrames<T extends DatedScene>(scenes: readonly T[], nowMs: number): T[] {
  return scenes
    .filter((scene) => scene.imageUrl && isLowCloud(scene) && scene.timeMs <= nowMs && scene.timeMs >= nowMs - HISTORY_DAYS * DAY_MS)
    .sort((a, b) => a.timeMs - b.timeMs);
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
    signal.removeEventListener('abort', stop);
    resolve();
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
