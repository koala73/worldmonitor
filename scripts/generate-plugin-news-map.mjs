import { readFileSync, writeFileSync } from 'node:fs';
import { geoArea, geoEquirectangular, geoPath } from 'd3';

const source = JSON.parse(readFileSync(new URL('../public/data/countries.geojson', import.meta.url), 'utf8'));
const projection = geoEquirectangular().scale(900 / (2 * Math.PI)).translate([450, 225]).precision(0.5);
const path = geoPath(projection).digits(1);
const countries = source.features.map((feature) => {
  if (geoArea(feature) > 2 * Math.PI) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) ring.reverse();
  }
  const [x, y] = path.centroid(feature);
  return {
    code: feature.properties['ISO3166-1-Alpha-2'],
    name: feature.properties.name,
    path: path(feature),
    center: [Math.round(x), Math.round(y)],
  };
}).filter((country) => /^[A-Z]{2}$/.test(country.code) && country.path);
const output = JSON.stringify(countries) + '\n';
const target = new URL('../api/mcp/ui/news-map.generated.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('News map is stale. Run scripts/generate-plugin-news-map.mjs.');
} else {
  writeFileSync(target, output);
}
