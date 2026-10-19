// Places a coordinate in a Tier-1 CII country using real borders
// (scripts/shared/cii-country-borders.data.mjs, generated from the Natural Earth
// 1:50m map by scripts/generate-cii-country-borders.mjs).
//
// Shared by the CII scorer (server/worldmonitor/intelligence/v1/get-risk-scores.ts)
// and the military seeder (scripts/seed-military-cii.mjs), which Railway packages
// from scripts/ alone and so cannot import server/.
//
// A point inside a Tier-1 country's land is that country. A point on any other
// land is in no Tier-1 country (null). A point at sea within 12 nautical miles
// of a coast belongs to the nearest coast's country, so a strike on a port or
// a fire on a beach the 1:50m coastline cuts off still counts, and returns
// null when that nearest coast is not Tier-1. Farther out is null.

import borders from './cii-country-borders.data.mjs';

/** Territorial sea: 12 nautical miles. */
export const CII_COASTAL_WATERS_KM = 22.224;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

function decodeArcs({ arcs, transform }) {
  const [sx, sy] = transform.scale;
  const [tx, ty] = transform.translate;
  return arcs.map((encoded) => {
    const points = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < encoded.length; i += 2) {
      x += encoded[i];
      y += encoded[i + 1];
      points.push([x * sx + tx, y * sy + ty]);
    }
    return points;
  });
}

// Russia's mainland ring crosses the antimeridian (Chukotka). Read raw, its
// 180 -> -180 edges span the whole map and flip ray-cast parity across entire
// latitude bands (Karelia read as sea, Finnish Lapland as Russia). Each ring is
// unwrapped into continuous longitudes, so it may extend past +-180, and a
// point is also tested 360 degrees east and west.
function buildRing(ringArcs, arcs) {
  const ring = [];
  for (const index of ringArcs) {
    const points = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    for (let i = ring.length ? 1 : 0; i < points.length; i++) ring.push(points[i]);
  }
  const flat = new Float64Array(ring.length * 2);
  let offset = 0;
  ring.forEach(([lon, lat], i) => {
    if (i > 0) {
      const previous = ring[i - 1][0];
      if (lon - previous > 180) offset -= 360;
      else if (previous - lon > 180) offset += 360;
    }
    flat[i * 2] = lon + offset;
    flat[i * 2 + 1] = lat;
  });
  return flat;
}

function buildPolygon(code, polygonArcs, arcs) {
  const rings = polygonArcs.map((ringArcs) => buildRing(ringArcs, arcs));
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const outer = rings[0];
  for (let i = 0; i < outer.length; i += 2) {
    minLon = Math.min(minLon, outer[i]);
    maxLon = Math.max(maxLon, outer[i]);
    minLat = Math.min(minLat, outer[i + 1]);
    maxLat = Math.max(maxLat, outer[i + 1]);
  }
  return { code, rings, minLon, maxLon, minLat, maxLat };
}

const ARCS = decodeArcs(borders);
const TIER1_POLYGONS = Object.entries(borders.countries)
  .flatMap(([code, polygons]) => polygons.map((polygon) => buildPolygon(code, polygon, ARCS)));
const OTHER_LAND_POLYGONS = borders.otherLand.map((polygon) => buildPolygon(null, polygon, ARCS));
const ALL_POLYGONS = [...TIER1_POLYGONS, ...OTHER_LAND_POLYGONS];

/** The Tier-1 countries the border file covers. */
export const CII_BORDER_COUNTRIES = Object.freeze(Object.keys(borders.countries).sort());
const TIER1 = new Set(CII_BORDER_COUNTRIES);
const ATTRIBUTED_TERRITORIES = borders.attributedTerritories;

/**
 * The Tier-1 row an event already tagged with an ISO2 country scores to: the
 * country itself, the row a territory with no row of its own counts toward
 * (PS -> IL, as on the map), or null for any other country.
 */
export function ciiCountryForIso2(iso2) {
  const code = typeof iso2 === 'string' ? iso2.trim().toUpperCase() : '';
  if (TIER1.has(code)) return code;
  return Object.hasOwn(ATTRIBUTED_TERRITORIES, code) ? ATTRIBUTED_TERRITORIES[code] : null;
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const yi = ring[i + 1];
    const xj = ring[j];
    const yj = ring[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(polygon, lon, lat) {
  if (lat < polygon.minLat || lat > polygon.maxLat) return false;
  for (const x of [lon, lon + 360, lon - 360]) {
    if (x < polygon.minLon || x > polygon.maxLon) continue;
    if (!inRing(x, lat, polygon.rings[0])) continue;
    let inHole = false;
    for (let r = 1; r < polygon.rings.length && !inHole; r++) inHole = inRing(x, lat, polygon.rings[r]);
    if (!inHole) return true;
  }
  return false;
}

/** Squared distance in km² from the point to the nearest edge of the ring (local flat projection). */
function ringDistanceSq(ring, lon, lat, kx, ky) {
  let best = Infinity;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const ax = (ring[i] - lon) * kx;
    const ay = (ring[i + 1] - lat) * ky;
    const bx = (ring[i + 2] - lon) * kx;
    const by = (ring[i + 3] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = px * px + py * py;
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when (lat, lon) is on land in the border file: any Tier-1 country, or
 * non-Tier-1 land near one. Land far from every Tier-1 country is not in the
 * file and reads as false.
 */
export function ciiIsLand(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return ALL_POLYGONS.some((polygon) => inPolygon(polygon, lon, lat));
}

/**
 * ISO2 of the Tier-1 country at (lat, lon), or null when the point is on
 * non-Tier-1 land, farther than 12 nautical miles offshore, or not a number.
 */
export function ciiCountryAt(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  for (const polygon of ALL_POLYGONS) {
    if (inPolygon(polygon, lon, lat)) return polygon.code;
  }
  // At sea on the 1:50m map: the nearest coast within territorial waters.
  const ky = KM_PER_DEG_LAT;
  const kx = KM_PER_DEG_LON_EQUATOR * Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const marginLat = CII_COASTAL_WATERS_KM / ky;
  const marginLon = CII_COASTAL_WATERS_KM / kx;
  let bestCode = null;
  let bestDistanceSq = CII_COASTAL_WATERS_KM * CII_COASTAL_WATERS_KM;
  for (const polygon of ALL_POLYGONS) {
    if (lat < polygon.minLat - marginLat || lat > polygon.maxLat + marginLat) continue;
    for (const x of [lon, lon + 360, lon - 360]) {
      if (x < polygon.minLon - marginLon || x > polygon.maxLon + marginLon) continue;
      for (const ring of polygon.rings) {
        const d = ringDistanceSq(ring, x, lat, kx, ky);
        if (d < bestDistanceSq) {
          bestDistanceSq = d;
          bestCode = polygon.code;
        }
      }
    }
  }
  return bestCode;
}
