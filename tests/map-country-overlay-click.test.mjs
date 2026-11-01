import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import ts from 'typescript';
import { GeoJsonLayer } from '@deck.gl/layers';
import { canonicalizeCountryCode, getCountryAtCoordinates, preloadCountryGeometry } from '../src/services/country-geometry.ts';
import { resolveCountryForPointerInteraction } from '../src/components/map/input-delay-interactions.ts';

// Exercise the real layer builder and click handler without the WebGL shell.
const source = ts.createSourceFile('DeckGLMap.ts', readFileSync(
  new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'DeckGLMap');
const members = ['CHOROPLETH_LAYER_IDS', 'AREA_OVERLAY_LAYER_IDS', 'createConflictZonesLayer', 'handleClick', 'resolveCountryFromCoordinate'];
const body = declaration.members.filter(node => members.includes(node.name?.getText(source)))
  .map(node => node.getText(source)).join('\n');
const javascript = ts.transpileModule(`class DeckGLMap { ${body} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const bindings = {
  GeoJsonLayer,
  COLORS: { conflict: [255, 0, 0, 80] },
  getCurrentTheme: () => 'dark',
  canonicalizeCountryCode,
  getCountryAtCoordinates,
  resolveCountryForPointerInteraction,
};
const DeckGLMap = new Function(...Object.keys(bindings), `${javascript}; return DeckGLMap;`)(...Object.values(bindings));
const countries = JSON.parse(readFileSync(new URL('../public/data/countries.geojson', import.meta.url), 'utf8'));

before(async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    assert.ok(['/data/countries.geojson', 'https://maps.worldmonitor.app/country-boundary-overrides.geojson'].includes(String(input)));
    return Response.json(String(input) === '/data/countries.geojson'
      ? countries
      : { type: 'FeatureCollection', features: [] });
  };
  try {
    await preloadCountryGeometry();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [code, name, lon, lat] of [
  ['IR', 'Iran', 54, 32],
  ['UA', 'Ukraine', 32, 49],
  ['SD', 'Sudan', 30, 16],
  ['MM', 'Myanmar', 96, 21],
]) {
  for (const hoverState of ['fresh', 'missing', 'pending']) {
    test(`clicking the country-shaped conflict overlay opens ${name} with ${hoverState} hover`, () => {
      const country = countries.features.find(feature => feature.properties['ISO3166-1-Alpha-2'] === code);
      const feature = { ...country, properties: { id: name.toLowerCase(), name: `${name} conflict`, intensity: 'high' } };
      const map = new DeckGLMap();
      const clicks = [];
      Object.assign(map, {
        countriesGeoJsonData: countries,
        hoveredCountryIso2: hoverState === 'missing' ? null : hoverState === 'pending' ? 'US' : code,
        hoveredCountryName: hoverState === 'missing' ? null : hoverState === 'pending' ? 'United States' : name,
        hoverQueryThrottle: { isPending: () => hoverState === 'pending' },
        onCountryClick: payload => clicks.push(payload),
        shouldSuppressCountryClickAfterDrag: () => false,
      });
      const layer = map.createConflictZonesLayer({ type: 'FeatureCollection', features: [feature] });
      assert.equal(layer.props.pickable, true);
      map.handleClick({ coordinate: [lon, lat] });
      assert.deepEqual(clicks, [{ code, name, lon, lat }], 'bare country clicks open the brief');
      clicks.length = 0;
      map.handleClick({ layer, object: feature, coordinate: [lon, lat] });
      assert.deepEqual(clicks, [{ code, name, lon, lat }]);
    });
  }
}
