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

/**
 * Centre points ([lat, lon]) for the selectable countries that have no box in
 * shared/country-bboxes (small states and territories missing from the
 * bundled boundaries, such as Singapore, Bahrain and Malta). Copied from
 * scripts/data/country-centroids.json (#8862);
 * tests/focus-map-fit.test.mts pins each entry to that file and checks that
 * every selectable country but Antarctica can be fitted.
 */
export const FOCUS_CENTRES: Readonly<Record<string, readonly [number, number]>> = {
  AD: [42.54, 1.56], AG: [17.08, -61.79], AI: [18.22, -63.07], AS: [-14.3, -170.72],
  AW: [12.52, -69.98], AX: [60.23, 19.94], BB: [13.18, -59.56], BH: [26.04, 50.54],
  BL: [17.9, -62.84], BM: [32.31, -64.76], BS: [24.7, -78.04], CK: [-21.22, -159.79],
  CV: [15.08, -23.64], CW: [12.2, -68.97], DM: [15.44, -61.36], FK: [-51.74, -58.76],
  FM: [6.89, 158.23], FO: [62.17, -6.88], GD: [12.12, -61.68], GG: [49.47, -2.57],
  GI: [36.14, -5.35], GM: [13.45, -15.4], GS: [-54.36, -36.69], GU: [13.44, 144.77],
  HK: [22.44, 114.14], HM: [-53.09, 73.52], IM: [54.22, -4.54], IO: [-7.334, 72.435],
  JE: [49.22, -2.13], KI: [1.85, -157.37], KM: [-11.65, 43.34], KN: [17.33, -62.75],
  KY: [19.32, -81.29], LC: [13.89, -60.97], LI: [47.14, 9.54], MC: [43.75, 7.41],
  MF: [18.09, -63.06], MH: [7.1, 171.19], MO: [22.22, 113.51], MP: [15.18, 145.74],
  MS: [16.74, -62.19], MT: [35.89, 14.44], MU: [-20.28, 57.57], MV: [4.2, 73.5],
  NF: [-29.05, 167.95], NR: [-0.52, 166.93], NU: [-19.05, -169.87], PF: [-17.66, -149.42],
  PM: [46.94, -56.33], PN: [-24.36, -128.32], PW: [7.51, 134.58], SB: [-9.62, 160.17],
  SC: [-4.66, 55.48], SG: [1.36, 103.82], SH: [-15.96, -5.72], SM: [43.94, 12.46],
  ST: [0.24, 6.61], SX: [18.05, -63.06], TC: [21.81, -71.74], TF: [-49.3, 69.5],
  TO: [-21.17, -175.22], TT: [10.42, -61.29], TV: [-8.52, 179.2], UM: [19.28, 166.65],
  VA: [41.9, 12.43], VC: [13.25, -61.2], VG: [18.42, -64.62], VI: [17.74, -64.77],
  VU: [-15.23, 166.85], WF: [-14.29, -178.13], WS: [-13.63, -172.44],
};

/**
 * Half the side of the box framed around a centre. Every renderer's zoom cap
 * (FOCUS_FIT_MAX_ZOOM on MapLibre) stops before a box this size fills the map.
 */
const CENTRE_BOX_HALF_DEG = 1;

/**
 * The country's box, or a small box around its centre when the bundled
 * boundaries have none. A centre box is clipped to [-180, 180] so it never
 * crosses the antimeridian.
 */
export function focusCountryBox(code: string): CountryBox | null {
  const box = countryBox(code);
  if (box) return box;
  const centre = FOCUS_CENTRES[code.toUpperCase()];
  if (!centre) return null;
  const [lat, lon] = centre;
  return {
    south: Math.max(-90, lat - CENTRE_BOX_HALF_DEG),
    north: Math.min(90, lat + CENTRE_BOX_HALF_DEG),
    west: Math.max(-180, lon - CENTRE_BOX_HALF_DEG),
    east: Math.min(180, lon + CENTRE_BOX_HALF_DEG),
  };
}

function normalizeLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function chosenBoxes(codes: readonly string[], lookup: FocusBoxLookup): CountryBox[] | null {
  const boxes: CountryBox[] = [];
  for (const code of codes) {
    if (typeof code !== 'string' || !code) continue;
    const box = lookup(code);
    if (!box) continue;
    const width = box.west > box.east ? box.east + 360 - box.west : box.east - box.west;
    if (width >= 360) return null;
    boxes.push(box);
  }
  return boxes.length > 0 ? boxes : null;
}

function fitOf(south: number, north: number, west: number, east: number): FocusFitBounds {
  south = Math.max(-MAX_FIT_LAT, south);
  north = Math.min(MAX_FIT_LAT, north);
  const span = east - west;
  return {
    south,
    north,
    west,
    east,
    lonSpan: span,
    latSpan: north - south,
    center: { lat: (south + north) / 2, lon: normalizeLon(west + span / 2) },
  };
}

/**
 * The union box of the chosen countries' bounding boxes, along the shortest
 * longitude arc that covers all of them. A country missing from the bundled
 * boundaries (Singapore, Bahrain, Malta) counts as a small box around its
 * centre; codes with neither are skipped. Null when none can be placed, or
 * when one covers every longitude (Antarctica): there is no frame to fit,
 * and the outline still draws.
 *
 * This is the globe's fit. The flat renderers show one world and use
 * focusSingleWorldFitBounds.
 */
export function focusFitBounds(
  codes: readonly string[],
  lookup: FocusBoxLookup = focusCountryBox,
): FocusFitBounds | null {
  const boxes = chosenBoxes(codes, lookup);
  if (!boxes) return null;
  const arcs = boxes.map((box) => ({
    start: box.west,
    width: box.west > box.east ? box.east + 360 - box.west : box.east - box.west,
  }));
  const south = Math.min(...boxes.map((box) => box.south));
  const north = Math.max(...boxes.map((box) => box.north));

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
  return fitOf(south, north, best.west, best.west + best.span);
}

/**
 * The fit for the flat renderers, which draw a single world: DeckGL's
 * MapLibre map sets renderWorldCopies: false, and the SVG map clamps its pan
 * to one equirectangular world. A short arc across the antimeridian (Fiji
 * with the US, Russia with the US) cannot be shown there: MapLibre clamps
 * the camera back inside the world and drops one end of the arc, and the
 * SVG map has nothing past +/-180. So when the short arc crosses the
 * antimeridian, this frames the plain union in [-180, 180] instead, zoomed
 * out as far as it takes (up to the whole world) so every chosen country is
 * on screen.
 *
 * A country whose own box crosses the antimeridian (only Russia in the
 * bundled boxes) is counted by its larger side: no view of one world shows
 * both sides short of the whole map, and Chukotka's strip east of -180 is
 * not worth zooming Russia out to the world.
 *
 * The globe keeps focusFitBounds' short arc: it has no seam, and its camera
 * centred on the arc's midpoint is the closest view of every chosen country.
 */
export function focusSingleWorldFitBounds(
  codes: readonly string[],
  lookup: FocusBoxLookup = focusCountryBox,
): FocusFitBounds | null {
  const arc = focusFitBounds(codes, lookup);
  if (!arc || arc.east <= 180) return arc;
  const boxes = chosenBoxes(codes, lookup);
  if (!boxes) return null;
  let west = Infinity;
  let east = -Infinity;
  for (const box of boxes) {
    const [from, to] = box.west <= box.east
      ? [box.west, box.east]
      : 180 - box.west >= box.east + 180 ? [box.west, 180] : [-180, box.east];
    west = Math.min(west, from);
    east = Math.max(east, to);
  }
  return fitOf(arc.south, arc.north, west, east);
}

/**
 * The highest altitude the globe camera reaches: GlobeMap sets
 * `controls.maxDistance = 600` for a globe of radius 100, so the camera is at
 * most 5 radii above the surface and sees about 80 degrees around its nadir.
 */
export const GLOBE_MAX_ALTITUDE = 5;

/** Great-circle angle in degrees between two points. */
function angleBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const cos = Math.sin(a.lat * rad) * Math.sin(b.lat * rad)
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lon - b.lon) * rad);
  return Math.acos(Math.min(1, Math.max(-1, cos))) / rad;
}

/**
 * Globe camera altitude (in globe radii) that frames a fit. Same steps as
 * GlobeMap.fitCountry, with a wider step for unions that span most of a
 * hemisphere. A camera at altitude `a` sees `acos(1 / (1 + a))` degrees
 * around its nadir, so a union wider than the steps assume (GB with NZ, 167
 * degrees apart) is raised until that reaches its farthest corner, up to the
 * camera's limit. Past the limit no view shows every country; the fit then
 * frames as much as the camera can.
 */
export function focusGlobeAltitude(fit: FocusFitBounds): number {
  const span = Math.max(fit.latSpan, fit.lonSpan);
  const stepped = span > 120 ? 1.8
    : span > 60 ? 1.0
      : span > 20 ? 0.7
        : span > 8 ? 0.45
          : span > 3 ? 0.25
            : 0.18;
  const radius = Math.max(
    ...[fit.south, fit.north].flatMap((lat) => [fit.west, fit.east].map((lon) => angleBetween(fit.center, { lat, lon }))),
  );
  const needed = radius >= 89 ? GLOBE_MAX_ALTITUDE : 1 / Math.cos(radius * Math.PI / 180) - 1;
  return Math.min(GLOBE_MAX_ALTITUDE, Math.max(stepped, needed));
}
