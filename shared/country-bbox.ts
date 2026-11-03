import COUNTRY_BBOXES from './country-bboxes.js';

export interface CountryBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function usableBox(box: CountryBox): boolean {
  return Object.values(box).every(Number.isFinite)
    && box.south >= -90 && box.north <= 90 && box.south <= box.north
    && box.west >= -180 && box.west <= 180 && box.east >= -180 && box.east <= 180
    && (box.east - box.west < 360 || box.south === -90 || box.north === 90);
}

/** Polar full-longitude extents are valid for local containment. */
export function countryBox(code: string): CountryBox | null {
  const bbox = COUNTRY_BBOXES[code.toUpperCase()];
  if (!bbox) return null;
  const [south, west, north, east] = bbox;
  const box = { south, west, north, east };
  return usableBox(box) ? box : null;
}

export function inBox(box: CountryBox | null, lat: number | undefined, lon: number | undefined): boolean {
  if (!box || !usableBox(box) || lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < box.south || lat > box.north || lon < -180 || lon > 180) return false;
  return box.west > box.east
    ? lon >= box.west || lon <= box.east
    : lon >= box.west && lon <= box.east;
}

/** Flight handlers expect ordinary intervals and can widen or invert wrapped ones. */
export function splitCountryBox(box: CountryBox): CountryBox[] {
  if (!usableBox(box) || box.east - box.west >= 360) return [];
  return box.west > box.east
    ? [{ ...box, east: 180 }, { ...box, west: -180 }]
    : [box];
}
