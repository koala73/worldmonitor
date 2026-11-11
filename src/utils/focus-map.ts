/**
 * Map fit for a dashboard focus (#10453): the box the map frames when a tab
 * is focused on a set of countries.
 *
 * Only the CHOSEN countries are fitted, never the neighbours; neighbours are
 * outlined but would widen the frame to most of a continent. Pure code over
 * shared/ data, loaded on demand by MapContainer so the bbox table stays out
 * of the dashboard's main chunk.
 */

import { countryBox, type CountryBox } from '../../shared/country-bbox';

/**
 * Highest MapLibre zoom a focus fit may reach. A focus is a monitoring
 * frame, so a single small country (Lebanon, Luxembourg) stops at a regional
 * zoom instead of filling the map at city level. The SVG and globe renderers
 * apply their own equivalent limits.
 */
export const FOCUS_FIT_MAX_ZOOM = 6;

/** Web Mercator cannot show the poles; a fit past these never resolves. */
const MAX_FIT_LAT = 85;

export interface FocusFitBounds {
  south: number;
  north: number;
  /** In [-180, 180]. */
  west: number;
  /**
   * `west + lonSpan`. Above 180 when the union crosses the antimeridian, so
   * MapLibre fits across the dateline instead of around the world.
   */
  east: number;
  lonSpan: number;
  latSpan: number;
  /** `lon` normalized to [-180, 180). */
  center: { lat: number; lon: number };
}

export type FocusBoxLookup = (code: string) => CountryBox | null;

function normalizeLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * The union box of the chosen countries' bounding boxes, along the shortest
 * longitude arc that covers all of them. Countries without a box (very small
 * states missing from the bundled boundaries, such as Singapore) are skipped.
 * Null when none has a box, or when one covers every longitude (Antarctica):
 * there is no frame to fit, and the outline still draws.
 */
export function focusFitBounds(
  codes: readonly string[],
  lookup: FocusBoxLookup = countryBox,
): FocusFitBounds | null {
  const arcs: Array<{ start: number; width: number }> = [];
  let south = Infinity;
  let north = -Infinity;
  for (const code of codes) {
    if (typeof code !== 'string' || !code) continue;
    const box = lookup(code);
    if (!box) continue;
    const width = box.west > box.east ? box.east + 360 - box.west : box.east - box.west;
    if (width >= 360) return null;
    arcs.push({ start: box.west, width });
    south = Math.min(south, box.south);
    north = Math.max(north, box.north);
  }
  if (arcs.length === 0) return null;

  // The tightest covering arc starts at the start of some country's arc (the
  // one just after the widest uncovered gap). Try each start and keep the
  // shortest arc that reaches the far end of every country.
  let best: { west: number; span: number } | null = null;
  for (const from of arcs) {
    let span = 0;
    for (const arc of arcs) {
      const offset = ((arc.start - from.start) % 360 + 360) % 360;
      span = Math.max(span, offset + arc.width);
    }
    if (!best || span < best.span || (span === best.span && from.start < best.west)) {
      best = { west: from.start, span };
    }
  }
  if (!best || best.span >= 360) return null;

  south = Math.max(-MAX_FIT_LAT, south);
  north = Math.min(MAX_FIT_LAT, north);
  const west = best.west;
  const east = west + best.span;
  return {
    south,
    north,
    west,
    east,
    lonSpan: best.span,
    latSpan: north - south,
    center: { lat: (south + north) / 2, lon: normalizeLon(west + best.span / 2) },
  };
}

/**
 * Globe camera altitude (in globe radii) that frames a fit. Same steps as
 * GlobeMap.fitCountry, with a wider step for unions that span most of a
 * hemisphere.
 */
export function focusGlobeAltitude(fit: FocusFitBounds): number {
  const span = Math.max(fit.latSpan, fit.lonSpan);
  if (span > 120) return 1.8;
  if (span > 60) return 1.0;
  if (span > 20) return 0.7;
  if (span > 8) return 0.45;
  if (span > 3) return 0.25;
  return 0.18;
}
