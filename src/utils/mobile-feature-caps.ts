/**
 * Mobile-only semantic density caps for the earthquake and Iran-event feeds
 * (#4463), shared by every renderer (#4545).
 *
 * These are distinct from the marker budgets in `globe-marker-budget.ts`. A
 * budget is a *quantity* ceiling applied to whatever markers a layer produced;
 * these are *semantic* cuts applied to the feed itself — "a phone does not show
 * sub-M5.0 quakes at all", not "a phone shows at most N of them". A feed can sit
 * comfortably under its budget and still need capping here.
 *
 * They were originally `private static readonly` members of `MapComponent`, so
 * only the SVG renderer enforced them. `MapContainer.useGlobe` carries no
 * `isMobile` term (neither the persisted-preference path in the constructor nor
 * the runtime `switchToGlobe()`), so a phone in 3D mode reached `GlobeMap` with
 * the raw feeds and rendered up to `GLOBE_MARKER_BUDGET_MOBILE.perLayer` (150)
 * of exactly the markers these caps exist to remove. Hoisting them here gives
 * the policy one home, so a fourth renderer inherits it by calling these rather
 * than by remembering two magic numbers.
 *
 * Deliberately free of DOM, renderer and service-type imports: the predicates
 * are structural, so they can be unit-tested directly against real payloads.
 */

/**
 * Phones render no earthquake below this magnitude. The production seeder only
 * ingests USGS `4.5_week.geojson`, so this cut is exactly the M4.5-4.9 band.
 */
export const MOBILE_MIN_EARTHQUAKE_MAGNITUDE = 5;

/** Phones render at most this many Iran events. */
export const MOBILE_MAX_IRAN_EVENTS = 50;

/**
 * The magnitude floor, or the list untouched off mobile.
 *
 * A missing/NaN magnitude is treated as below the floor rather than coerced to
 * 0: either way it fails `>=`, but saying so here keeps the two callers from
 * each inventing their own `?? 0`.
 */
export function capEarthquakesForMobile<T extends { magnitude?: number }>(
  earthquakes: readonly T[],
  isMobile: boolean,
): readonly T[] {
  if (!isMobile) return earthquakes;
  return earthquakes.filter((eq) => (eq.magnitude ?? 0) >= MOBILE_MIN_EARTHQUAKE_MAGNITUDE);
}

/** The event-count cut, or the list untouched off mobile. */
export function capIranEventsForMobile<T>(events: readonly T[], isMobile: boolean): readonly T[] {
  if (!isMobile) return events;
  return events.length > MOBILE_MAX_IRAN_EVENTS ? events.slice(0, MOBILE_MAX_IRAN_EVENTS) : events;
}
