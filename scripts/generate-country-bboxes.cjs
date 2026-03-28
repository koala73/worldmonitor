'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const geojson = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'countries.geojson'), 'utf8'));

function coordsFromGeom(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates.flat(1);
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

const result = {};
for (const f of geojson.features) {
  const iso2 = f.properties['ISO3166-1-Alpha-2'];
  // Skip entries with non-standard ISO codes (e.g. "-99" for disputed/unassigned territories)
  if (!iso2 || !f.geometry || !/^[A-Z]{2}$/.test(iso2)) continue;
  const coords = coordsFromGeom(f.geometry);
  if (!coords.length) continue;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  // [sw_lat, sw_lon, ne_lat, ne_lon] — 2dp precision keeps file compact
  result[iso2] = [+(minLat.toFixed(2)), +(minLon.toFixed(2)), +(maxLat.toFixed(2)), +(maxLon.toFixed(2))];
}

// Sort keys for stable diffs
const sorted = Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));

const out = path.join(root, 'shared', 'country-bboxes.json');
fs.writeFileSync(out, JSON.stringify(sorted, null, 2) + '\n');
console.log(`Wrote ${Object.keys(sorted).length} entries to ${out}`);
