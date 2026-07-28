/**
 * Bounds how many HTML markers the 3D globe renders at once (#5368).
 *
 * globe.gl renders `htmlElementsData` through three's CSS2DRenderer, which walks
 * EVERY marker on EVERY animation frame and rewrites `display`, `transform` and
 * `zIndex` on each one — unconditionally, even with a still camera — then runs a
 * whole-scene `traverseVisible` plus an O(n log n) depth sort
 * (three/examples/jsm/renderers/CSS2DRenderer.js:214-310, driven from
 * globe.gl's `_animationCycle`). Frame cost is therefore linear in marker count
 * and lands squarely in the interaction frame budget, which is what INP measures.
 *
 * Measured on production 2026-07-18: the desktop default view carries 2,319
 * markers, 1,526 of them live AIS vessels arriving over a websocket with no
 * ceiling of their own; opting into Armed Conflict Events adds a further 2,000.
 * Nothing upstream bounds these, so the ceiling belongs here.
 *
 * This module is deliberately free of DOM and three.js imports so the real
 * selection function can be unit-tested directly against real payload shapes.
 */

/** A single layer's contribution to the globe, before budgeting. */
export interface GlobeMarkerGroup<T> {
  /**
   * Layer toggle key this group belongs to. Several groups may share one key —
   * `military` alone contributes flights, vessels and clusters — in which case
   * each is budgeted independently (they are separate feeds with unrelated
   * volumes) but their truncation is reported against the one toggle.
   */
  layer: string;
  markers: readonly T[];
  /**
   * Higher = more important = kept when the group must be trimmed. Layers with a
   * severity signal (deaths, magnitude, brightness) pass it here; the rest get
   * `proximityRank` so the cut is view-relative. Omitting it entirely falls back
   * to raw feed order — see the warning in `takeTop`.
   */
  rank?: (marker: T) => number;
  /**
   * Breaks ties within an equal `rank`, before source order does.
   *
   * A severity rank is usually coarse — `carrier ? 1 : 0` leaves ~1,500 vessels
   * on the same score — and without a tie-break the cut among them falls back to
   * feed order, which is the arbitrary-selection problem `proximityRank` exists
   * to avoid. Pass `proximityRank` here so severity decides first and nearness
   * decides the rest. Compared lexicographically, so no weighting to tune.
   */
  tieBreak?: (marker: T) => number;
  /**
   * Ephemeral or navigational markers that must always render (e.g. the
   * flash-to-location pin). Exempt groups bypass the budget entirely; keep them
   * to a handful of markers.
   */
  exempt?: boolean;
}

export interface GlobeMarkerBudget {
  /**
   * Ceiling per GROUP, not per layer key. A layer that supplies several feeds
   * (`military` = flights + vessels + clusters) is budgeted once per feed, so
   * its rendered total can reach this many times its feed count — bounded, as
   * always, by `total`.
   */
  perLayer: number;
  /** Ceiling across all non-exempt layers combined. */
  total: number;
}

export interface GlobeLayerTruncation {
  shown: number;
  total: number;
}

export interface GlobeMarkerSelection<T> {
  markers: T[];
  /** Only layers that actually lost markers appear here. */
  truncated: Record<string, GlobeLayerTruncation>;
}

/**
 * Mobile keeps the default view (~120 markers on production today) untouched and
 * only bites when a user stacks heavy layers onto a phone.
 */
export const GLOBE_MARKER_BUDGET_MOBILE: GlobeMarkerBudget = { perLayer: 150, total: 400 };

/** Desktop's default view is 2,319 markers today, so this cuts it ~2.9x. */
export const GLOBE_MARKER_BUDGET_DESKTOP: GlobeMarkerBudget = { perLayer: 300, total: 800 };

/**
 * Largest per-group cap `c <= max` for which `sum(min(len_i, c)) <= total`.
 *
 * Trimming the biggest groups first (max-min fairness) rather than trimming
 * every group proportionally keeps small layers whole: one 1,526-marker vessel
 * feed must not evict an 11-marker weather layer.
 */
function fairShareCap(sizes: readonly number[], total: number, max: number): number {
  const used = (cap: number): number => sizes.reduce((sum, n) => sum + Math.min(n, cap), 0);
  if (used(max) <= total) return max;
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (used(mid) <= total) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export interface LatLng { lat: number; lng: number }

/**
 * Ranks markers by nearness to the point the camera is looking at.
 *
 * This is the default for layers with no severity signal of their own, and it
 * exists because the obvious alternative is indefensible: trimming a static
 * reference layer by raw array order means an alphabetically-ordered facility
 * list quietly loses whatever sits past the cut — on the nuclear layer that is
 * Zaporizhzhia. Nearness makes the trim view-relative instead of arbitrary, so
 * a user always sees the sites in the region they are actually looking at and
 * the rest arrive as they rotate or zoom toward them.
 *
 * The score is the cosine of the central angle (higher = nearer), which orders
 * identically to great-circle distance without the `acos`.
 */
export function proximityRank<T>(focus: LatLng, position: (marker: T) => LatLng): (marker: T) => number {
  const rad = Math.PI / 180;
  const focusLat = focus.lat * rad;
  const sinFocusLat = Math.sin(focusLat);
  const cosFocusLat = Math.cos(focusLat);
  return (marker) => {
    const { lat, lng } = position(marker);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return -Infinity;
    const markerLat = lat * rad;
    return sinFocusLat * Math.sin(markerLat)
      + cosFocusLat * Math.cos(markerLat) * Math.cos((lng - focus.lng) * rad);
  };
}

/** Top `cap` markers by rank then tie-break, preserving the group's own order. */
function takeTop<T>(
  markers: readonly T[],
  cap: number,
  rank?: (marker: T) => number,
  tieBreak?: (marker: T) => number,
): T[] {
  if (markers.length <= cap) return markers.slice();
  // No rank means the caller has no opinion, so the cut falls wherever the feed
  // happened to order things. Callers rendering anything a user might depend on
  // should pass a rank (severity, or `proximityRank`) rather than accept this.
  if (!rank) return markers.slice(0, cap);
  // A non-finite score sorts last rather than poisoning the comparator with NaN.
  const finite = (value: number): number => (Number.isFinite(value) ? value : -Infinity);
  // Rank desc, then tie-break desc, then original index asc — compared in order
  // rather than summed, so a coarse rank never has to be weighted against a fine
  // tie-break (magnitude 5.1 vs 5.2 stays decisive; equal scores fall to nearness).
  const keep = markers
    .map((marker, index) => ({
      marker,
      index,
      score: finite(rank(marker)),
      tie: tieBreak ? finite(tieBreak(marker)) : 0,
    }))
    .sort((a, b) => (b.score - a.score) || (b.tie - a.tie) || (a.index - b.index))
    .slice(0, cap)
    .sort((a, b) => a.index - b.index);
  return keep.map(entry => entry.marker);
}

/**
 * Applies the per-layer cap, then the global ceiling, returning the markers to
 * render plus a report of what was withheld so the UI can disclose it.
 */
export function selectGlobeMarkers<T>(
  groups: readonly GlobeMarkerGroup<T>[],
  budget: GlobeMarkerBudget,
): GlobeMarkerSelection<T> {
  const exempt = groups.filter(group => group.exempt);
  const budgeted = groups.filter(group => !group.exempt && group.markers.length > 0);

  const cap = fairShareCap(
    budgeted.map(group => group.markers.length),
    budget.total,
    budget.perLayer,
  );

  const markers: T[] = [];
  // Totalled across every group sharing a layer key, so a layer whose vessel
  // feed is trimmed still reports its untrimmed flights in the same figure.
  const perLayer = new Map<string, GlobeLayerTruncation>();

  for (const group of budgeted) {
    const kept = takeTop(group.markers, cap, group.rank, group.tieBreak);
    const running = perLayer.get(group.layer) ?? { shown: 0, total: 0 };
    running.shown += kept.length;
    running.total += group.markers.length;
    perLayer.set(group.layer, running);
    markers.push(...kept);
  }
  for (const group of exempt) {
    markers.push(...group.markers);
  }

  const truncated: Record<string, GlobeLayerTruncation> = {};
  for (const [layer, counts] of perLayer) {
    if (counts.shown < counts.total) truncated[layer] = counts;
  }

  return { markers, truncated };
}
