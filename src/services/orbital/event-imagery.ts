/**
 * Before and after around a dated map event (#10713 unit 2). The archive window is the compare
 * history window (60 days) ending 30 days after the event, or now when that is sooner, so the
 * event sits inside the window with as much "after" as the archive can hold. The pair is the last
 * clear scene before the event and the first clear scene at or after it; Sentinel-2 is tried first
 * and Sentinel-1 radar, which sees through cloud and smoke, when the optical pair is incomplete.
 * Everything runs in the browser against the public archives, so the event's point never reaches
 * WorldMonitor.
 */
import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { ArchiveRequestOptions } from './archive-result';
import type { ImagingProfileId } from './archive-stac';
import type { MatchedAcquisition } from './match';
import { CLEAR_LOOK_CLOUD_PCT, imageGrid, searchSceneHistory } from './scene-history';

const DAY_MS = 86_400_000;
/** How far past the event the window reaches, when that is not in the future. */
export const EVENT_AFTER_DAYS = 30;
/** Optical first; radar when cloud or smoke leaves the optical pair incomplete. */
export const EVENT_PROFILES: readonly ImagingProfileId[] = ['sentinel-2', 'sentinel-1'];

export type EventPair =
  | { status: 'ok'; profileId: ImagingProfileId; windowEndMs: number; scenes: MatchedAcquisition[]; before: MatchedAcquisition; after: MatchedAcquisition }
  | { status: 'none'; missing: 'before' | 'after' }
  | { status: 'failed' };

/** The event time, never later than now: a feed's clock skew must not push the window into the future. */
export const clampEventMs = (eventMs: number, nowMs: number): number => Math.min(eventMs, nowMs);

/** The end of the compare history window for an event. */
export const eventWindowEndMs = (eventMs: number, nowMs: number): number =>
  Math.min(nowMs, clampEventMs(eventMs, nowMs) + EVENT_AFTER_DAYS * DAY_MS);

const usable = (scene: MatchedAcquisition): boolean =>
  scene.imageUrl !== null && imageGrid(scene.imageUrl) === 'north-up'
  && (scene.profileId === 'sentinel-1' || (scene.cloudCoverPct !== null && scene.cloudCoverPct < CLEAR_LOOK_CLOUD_PCT));

/** The last usable scene before the event and the first at or after it. */
export function pickEventPair(eventMs: number, scenes: readonly MatchedAcquisition[]): { before: MatchedAcquisition | null; after: MatchedAcquisition | null } {
  let before: MatchedAcquisition | null = null;
  let after: MatchedAcquisition | null = null;
  for (const scene of scenes) {
    if (!usable(scene)) continue;
    if (scene.startMs < eventMs) {
      if (!before || scene.startMs > before.startMs) before = scene;
    } else if (!after || scene.startMs < after.startMs) {
      after = scene;
    }
  }
  return { before, after };
}

export interface EventPairDependencies {
  searchHistory?: typeof searchSceneHistory;
}

/** Searches the window around the event for a before/after pair at the point. */
export async function findEventPair(
  point: GeoPoint,
  eventMs: number,
  nowMs: number,
  options: ArchiveRequestOptions = {},
  deps: EventPairDependencies = {},
): Promise<EventPair> {
  const search = deps.searchHistory ?? searchSceneHistory;
  const anchorMs = clampEventMs(eventMs, nowMs);
  const windowEndMs = eventWindowEndMs(eventMs, nowMs);
  let answered = false;
  let anyFailed = false;
  let anyAfter = false;
  for (const profileId of EVENT_PROFILES) {
    const history = await search(point, profileId, windowEndMs, options);
    if (options.signal?.aborted) return { status: 'failed' };
    if (history.status !== 'ok') {
      anyFailed = true;
      continue;
    }
    answered = true;
    const { before, after } = pickEventPair(anchorMs, history.scenes);
    if (before && after) return { status: 'ok', profileId, windowEndMs, scenes: history.scenes, before, after };
    anyAfter ||= after !== null;
  }
  // A missing side is only reported when every archive answered; otherwise a retry may still find the pair.
  // No scene since the event is the usual gap for a recent event, so it is named first.
  return answered && !anyFailed ? { status: 'none', missing: anyAfter ? 'before' : 'after' } : { status: 'failed' };
}
