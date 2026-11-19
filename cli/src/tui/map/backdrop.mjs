// Satellite imagery for the map: which GIBS tiles a viewport needs and how
// to turn ready tiles into half-block cell colours (day, night lights, fade).
import { mix } from '../term/ansi.mjs';
import { dayFactor, wrapLon } from './geo.mjs';
import { samplePixel } from './png.mjs';

// Imagery requests for the visible area: the whole globe, the flat viewport,
// or, when the viewport crosses the antimeridian, one tile on each side of it
// (a single world strip would cap at 2048 px and blur when zoomed in).
export function imageryRequests(view, proj, layer, time) {
  if (view.mode === 'globe') return [{ layer: layer.gibs, bbox: [-180, -90, 180, 90], width: 1080, height: 540, time }];
  const [west, s, east, n] = proj.bbox();
  const south = Math.max(-90, s);
  const north = Math.min(90, n);
  const pxPerDeg = proj.k / 2;
  const height = Math.max(8, Math.round((north - south) * pxPerDeg));
  const box = (w, e) => ({ layer: layer.gibs, bbox: [w, south, e, north], width: Math.max(8, Math.round((e - w) * pxPerDeg)), height, time });
  if (east - west >= 359.9) return [{ ...box(-180, 180), width: Math.min(2048, Math.max(64, Math.round(360 * pxPerDeg))) }];
  if (west < -180) return [box(west + 360, 180), box(-180, east)];
  if (east > 180) return [box(west, 180), box(-180, east - 360)];
  return [box(west, east)];
}

// tiles / nightTiles: ready cache entries, newest first; each is read with its own extent.
export function makeSampler(t, tiles, proj, sun, nightTiles, fade) {
  const dark = mix(t.panel, '#000000', 0.5);
  const sampleAt = (lon, lat) => {
    const px = sampleTiles(tiles, lon, lat);
    if (!px) return null;
    let color = rgb(px);
    if (sun) {
      const f = dayFactor(lat, lon, sun);
      if (f < 1) {
        let nightColor = '#02040a';
        const np = sampleTiles(nightTiles, lon, lat);
        if (np) nightColor = rgb([Math.min(255, np[0] * 1.6 + 4), Math.min(255, np[1] * 1.5 + 6), Math.min(255, np[2] * 1.3 + 12)]);
        color = mix(nightColor, color, 0.08 + 0.92 * f);
      }
    }
    return fade < 1 ? mix(t.panel, color, fade) : color;
  };
  return (cx, cy) => {
    const gTop = proj.fromDot(cx * 2 + 1, cy * 4 + 1);
    const gBot = proj.fromDot(cx * 2 + 1, cy * 4 + 3);
    if (!gTop && !gBot) return null;
    const top = gTop ? sampleAt(gTop.lon, gTop.lat) : null;
    const bottom = gBot ? sampleAt(gBot.lon, gBot.lat) : null;
    if (!top && !bottom) return null;
    return { top: top || dark, bottom: bottom || dark };
  };
}

// Pixel at (lon, lat) from the first tile covering it; each tile is read with its own extent.
export function sampleTiles(tiles, lon, lat) {
  for (const tile of tiles) {
    const [w, s, e, n] = tile.req.bbox;
    if (lat < s || lat > n) continue;
    let u = e - w >= 359.9 ? (wrapLon(lon) + 180) / 360 : (lon - w) / (e - w);
    if (u < 0 || u > 1) u = (wrapLon(lon) - w) / (e - w);
    if (u < 0 || u > 1) continue;
    return samplePixel(tile.image, u, (n - lat) / (n - s));
  }
  return null;
}

export function rgb([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
