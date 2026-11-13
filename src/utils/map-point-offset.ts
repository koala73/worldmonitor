/** A screen offset in CSS pixels: x to the right, y down. */
export interface ScreenOffset {
  x: number;
  y: number;
}

const MERCATOR_TILE = 512;
const MAX_MERCATOR_LAT = 85.051129;

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The Web Mercator map centre that draws (lat, lon) `offset` pixels from the container centre at `zoom`. */
export function mercatorCenterForOffset(lat: number, lon: number, zoom: number, offset: ScreenOffset): { lat: number; lon: number } {
  const world = MERCATOR_TILE * 2 ** zoom;
  const phi = (Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * world - offset.x;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * world - offset.y;
  const centreLat = (2 * Math.atan(Math.exp((0.5 - y / world) * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  return { lat: centreLat, lon: wrapLon((x / world) * 360 - 180) };
}

/**
 * The globe point of view that draws (lat, lon) `offset` pixels from the canvas centre, for a
 * camera `altitude` globe radii above the surface with a vertical field of view of `fovDeg`.
 * Close to the surface the visible patch is nearly flat, which is when an offset matters.
 */
export function globeCenterForOffset(
  lat: number,
  lon: number,
  altitude: number,
  fovDeg: number,
  viewportHeight: number,
  offset: ScreenOffset,
): { lat: number; lon: number } {
  if (viewportHeight <= 0) return { lat, lon };
  const degPerPx = ((2 * altitude * Math.tan((fovDeg * Math.PI) / 360)) / viewportHeight) * (180 / Math.PI);
  const centreLat = Math.max(-89, Math.min(89, lat + offset.y * degPerPx));
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return { lat: centreLat, lon: wrapLon(lon - (offset.x * degPerPx) / cos) };
}

/** Whether (lat, lon) faces a camera above (povLat, povLon) at `altitude` globe radii. */
export function isOnVisibleHemisphere(lat: number, lon: number, povLat: number, povLon: number, altitude: number): boolean {
  const rad = Math.PI / 180;
  const cosAngle = Math.sin(lat * rad) * Math.sin(povLat * rad)
    + Math.cos(lat * rad) * Math.cos(povLat * rad) * Math.cos((lon - povLon) * rad);
  return cosAngle > 1 / (1 + Math.max(0, altitude));
}

export interface ScreenArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const areaOf = (a: ScreenArea) => Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);

/** The largest part of `map` that none of `covers` draws over, trimming one side per cover. */
export function visibleMapArea(map: ScreenArea, covers: ScreenArea[]): ScreenArea {
  let area: ScreenArea = { left: map.left, top: map.top, right: map.right, bottom: map.bottom };
  for (const c of covers) {
    if (c.right <= area.left || c.left >= area.right || c.bottom <= area.top || c.top >= area.bottom) continue;
    const sides: ScreenArea[] = [
      { ...area, right: Math.min(area.right, c.left) },
      { ...area, left: Math.max(area.left, c.right) },
      { ...area, bottom: Math.min(area.bottom, c.top) },
      { ...area, top: Math.max(area.top, c.bottom) },
    ];
    area = sides.reduce((best, side) => (areaOf(side) > areaOf(best) ? side : best));
  }
  return area;
}
