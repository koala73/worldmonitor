// When a tab may reload itself to pick up a deploy that did not change the
// client compatibility marker (src/bootstrap/client-compat.ts).
//
// Production deploys land dozens of times a day. Reloading every open tab for
// each one interrupted reading, reset scroll and stopped live video. A deploy
// old tabs can keep working against is applied only when all of these hold:
//
//   - the tab is hidden, so nobody is looking at it;
//   - nothing in it is playing with sound, so nobody is listening to it;
//   - the page has been open for SOFT_RELOAD_MIN_PAGE_AGE_MS, which caps a tab
//     at one such reload per window however many deploys land.
//
// A deploy that changes the marker bypasses all of this and reloads as before.

/** Minimum page age before a non-breaking update may reload the tab. */
export const SOFT_RELOAD_MIN_PAGE_AGE_MS = 4 * 60 * 60_000;

/** Why a non-breaking update is not being applied right now. */
export type SoftReloadHold = 'visible' | 'audible-media' | 'recently-loaded';

const audibleSources = new Set<string>();

/**
 * Report whether `source` is playing media with sound. A reload cannot restore
 * sound (browsers block unmuted autoplay), so an audible tab is never reloaded
 * for a non-breaking update.
 */
export function setAudibleMedia(source: string, audible: boolean): void {
  if (audible) audibleSources.add(source);
  else audibleSources.delete(source);
}

export function isAudibleMediaPlaying(): boolean {
  return audibleSources.size > 0;
}

export function _resetAudibleMediaForTests(): void {
  audibleSources.clear();
}

export interface SoftReloadState {
  /** `document.visibilityState`. Anything but 'hidden' counts as visible. */
  readonly visibilityState: string | undefined;
  /** Milliseconds since this page loaded. */
  readonly pageAgeMs: number;
  readonly audibleMedia: boolean;
}

/** The first reason to hold a non-breaking reload, or null when it may go ahead. */
export function softReloadHold(state: SoftReloadState): SoftReloadHold | null {
  if (state.visibilityState !== 'hidden') return 'visible';
  if (state.audibleMedia) return 'audible-media';
  if (!(state.pageAgeMs >= SOFT_RELOAD_MIN_PAGE_AGE_MS)) return 'recently-loaded';
  return null;
}

/** Milliseconds since navigation start. 0 where the clock is unavailable, which holds the reload. */
function pageAgeMs(): number {
  try {
    return typeof performance !== 'undefined' ? performance.now() : 0;
  } catch {
    return 0;
  }
}

/** `softReloadHold` for the live page. */
export function currentSoftReloadHold(doc: { readonly visibilityState?: string } | undefined): SoftReloadHold | null {
  return softReloadHold({
    visibilityState: doc?.visibilityState,
    pageAgeMs: pageAgeMs(),
    audibleMedia: isAudibleMediaPlaying(),
  });
}
