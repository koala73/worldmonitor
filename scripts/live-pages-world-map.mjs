// A static world map for /tools/<slug>/ pages, drawn once at build time from
// the self-hosted world-atlas 110m topology (public/data/README.md). Each
// country is a <path data-iso2="XX">, so a page colours it with CSS rules that
// its live section carries: the routing middleware swaps the section, and the
// map recolours with it, with no script and no geometry in the Edge bundle.
//
// Node only (reads files); scripts/live-pages/ stays pure because middleware
// bundles it.

import { readFileSync } from 'node:fs';
import { geoGraticule10, geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';

export const WORLD_MAP_INPUT_PATHS = Object.freeze([
  'scripts/live-pages-world-map.mjs',
  'public/data/countries-110m.json',
  'shared/un-to-iso2.json',
]);

const WIDTH = 960;
const HEIGHT = 470;

// The topology gives these no ISO numeric code (id is absent or "-99").
// Both registers cover Somaliland under Somalia and northern Cyprus under Cyprus.
const ISO2_BY_NAME = Object.freeze({ Kosovo: 'XK', Somaliland: 'SO', 'N. Cyprus': 'CY' });

let cached = null;

function buildMap() {
  const topology = JSON.parse(readFileSync(new URL('../public/data/countries-110m.json', import.meta.url), 'utf8'));
  const unToIso2 = JSON.parse(readFileSync(new URL('../shared/un-to-iso2.json', import.meta.url), 'utf8'));
  const land = feature(topology, topology.objects.countries);
  land.features = land.features.filter((country) => country.properties?.name !== 'Antarctica');
  const projection = geoNaturalEarth1().fitExtent([[4, 4], [WIDTH - 4, HEIGHT - 4]], land);
  const path = geoPath(projection).digits(0);
  const shapes = Object.freeze(land.features
    .map((country) => {
      const name = String(country.properties?.name || '');
      const iso2 = unToIso2[String(country.id ?? '').padStart(3, '0')] || ISO2_BY_NAME[name] || '';
      const d = path(country);
      return d ? Object.freeze({ iso2, name, d }) : null;
    })
    .filter(Boolean));
  return { shapes, graticule: path(geoGraticule10()) };
}

/** The map's country shapes: { iso2, name, d }, Antarctica left out. */
export function worldMapShapes() {
  cached ??= buildMap();
  return cached.shapes;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The map as inline SVG: a 10° graticule
 * (`.graticule`) and one `.land` path per country. `label` is its accessible
 * name; the figure around it carries the legend and states what the colours mean.
 */
export function renderWorldMapSvg({ label, className = 'world-map' }) {
  worldMapShapes();
  const shapes = cached.shapes
    .map((shape) => `<path class="land"${shape.iso2 ? ` data-iso2="${shape.iso2}"` : ''} d="${shape.d}"><title>${escapeAttr(shape.name)}</title></path>`)
    .join('');
  return `<svg class="${escapeAttr(className)}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeAttr(label)}" preserveAspectRatio="xMidYMid meet"><path class="graticule" d="${cached.graticule}"/>${shapes}</svg>`;
}
