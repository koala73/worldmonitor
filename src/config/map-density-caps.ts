/**
 * Mobile overlay density caps, shared by every map renderer.
 *
 * These used to be private statics on `MapComponent`, which made them the SVG
 * renderer's caps rather than the app's. A phone with a saved globe preference
 * reaches `useGlobe = true` independently of `isMobile`, so it drew the full
 * uncapped sets while the default mobile path (SVG) drew the capped ones
 * (#4545). Keeping one definition here is what stops the two renderers
 * drifting again; `tests/dom/mobile-density-caps.test.mts` pins that every
 * renderer path applies them.
 */

/** Below this magnitude, a quake is not worth a marker on a phone. */
export const MOBILE_MIN_EARTHQUAKE_MAGNITUDE = 5;

/** Newest-first cap on Iran strike markers for a phone. */
export const MOBILE_MAX_IRAN_EVENTS = 50;

/** Quakes a phone should draw, given the renderer-agnostic cap. */
export function capEarthquakesForMobile<T extends { magnitude: number }>(quakes: readonly T[]): T[] {
  return quakes.filter((quake) => quake.magnitude >= MOBILE_MIN_EARTHQUAKE_MAGNITUDE);
}

/** Iran events a phone should draw, given the renderer-agnostic cap. */
export function capIranEventsForMobile<T>(events: readonly T[]): T[] {
  return events.slice(0, MOBILE_MAX_IRAN_EVENTS);
}
