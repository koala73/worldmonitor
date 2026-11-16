import type { ArchiveFailure } from './archive-result';

/**
 * How long after acquisition a missing Sentinel-1 crop reads as not ready yet rather than failed.
 * Earth Search can list a new Sentinel-1 scene a few hours before Planetary Computer, which every crop is cut from, serves it.
 */
export const SENTINEL_1_PROCESSING_WINDOW_MS = 24 * 3_600_000;

/** Whether a crop failure is a recent Sentinel-1 scene that Planetary Computer answers 404 for; any other failure stays a failure. */
export function isSceneStillProcessing(failure: ArchiveFailure | null | undefined, scene: { profileId: string; acquiredMs: number }, nowMs: number): boolean {
  return scene.profileId === 'sentinel-1'
    && failure?.archive === 'planetary-computer' && failure.reason === 'http-status' && failure.httpStatus === 404
    && Number.isFinite(scene.acquiredMs) && nowMs - scene.acquiredMs < SENTINEL_1_PROCESSING_WINDOW_MS;
}
