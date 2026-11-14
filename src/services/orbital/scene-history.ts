import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { ArchiveImageError, loadArchiveImage, type LoadedArchiveImage } from './archive-image';
import type { ArchiveFailure, ArchiveId, ArchiveRequestOptions } from './archive-result';
import { searchStacArchive, type ImagingProfileId, type StacArchiveId } from './archive-stac';
import { cropBox } from './crop-url';
import { assembleEvidence, type MatchedAcquisition } from './match';

const DAY_MS = 86_400_000;
/** How far back the compare dates look. */
export const HISTORY_DAYS = 60;
/** Cloud over the scene at or above which a look would mostly show cloud. */
export const CLEAR_LOOK_CLOUD_PCT = 30;
/** The compare picker prefers a scene at least this far from the one being viewed. */
export const COMPARE_MIN_GAP_DAYS = 30;

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

/** How long one archive image may take before it counts as failed. */
export const IMAGE_LOAD_TIMEOUT_MS = 30_000;

/** False when a decoded image is fully transparent: the archive's nodata, a crop that fell outside the scene's pixels. */
export function imageHasData(image: CanvasImageSource, canvas: HTMLCanvasElement = document.createElement('canvas')): boolean {
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return true;
  try {
    context.drawImage(image, 0, 0, 32, 32);
    const { data } = context.getImageData(0, 0, 32, 32);
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
    return false;
  } catch {
    return true;
  }
}

/** Loads an image and resolves once it has decoded. `requireData` loads it CORS-readable and rejects one with no pixels. */
export const loadImageElement = (url: string, signal: AbortSignal, options: { requireData?: boolean } = {}): Promise<void> => new Promise((resolve, reject) => {
  const image = new Image();
  if (options.requireData) image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  const finish = (error: Error | null) => {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    image.onload = null;
    image.onerror = null;
    if (error) {
      image.src = '';
      reject(error);
    } else {
      resolve();
    }
  };
  const abort = () => finish(new DOMException('Aborted', 'AbortError'));
  const deadline = setTimeout(() => finish(new Error('image load timed out')), IMAGE_LOAD_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  image.onload = () => {
    void image.decode().catch(() => undefined).then(() => finish(
      options.requireData && !imageHasData(image) ? new Error('image has no data at this spot') : null,
    ));
  };
  image.onerror = () => finish(new Error('image failed to load'));
  image.src = url;
});

/** Loads an archive image as a URL that carries no point, a `blob:` URL for a crop around it. */
export const loadPaintableImage: LoadImage = async (archive, url, signal) => {
  const result = await loadArchiveImage(archive, [url], { signal, timeoutMs: IMAGE_LOAD_TIMEOUT_MS });
  if (result.status === 'failed') throw new ArchiveImageError(result.failure);
  return result.image;
};
