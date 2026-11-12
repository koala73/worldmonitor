import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { improveBasemapLabels } from '../src/config/basemap-labels.ts';

function harness(styleLayers: { id: string; type?: string }[]) {
  const writes = new Map<string, Record<string, unknown>>();
  return {
    writes,
    getStyle: () => ({ layers: styleLayers }),
    setPaintProperty(id: string, property: string, value: unknown) {
      writes.set(id, { ...writes.get(id), [property]: value });
    },
  };
}

test('styles geographic labels across providers without touching roads, POIs, or overlays', () => {
  const ids = ['place_country_major', 'place_capital_dot_z7', 'place_city', 'place_state', 'place_village', 'water_name', 'watername_sea', 'label_city', 'label_city_capital', 'label_country_1', 'waterway_line_label'];
  const map = harness([...ids, 'roadname_major', 'poi_park', 'protest-clusters-badge'].map(id => ({id, type: 'symbol'})));
  improveBasemapLabels(map, false);
  assert.deepEqual([...map.writes.keys()], ids);
  assert.equal(map.writes.get('place_country_major')!['text-color'], '#d3dbe5');
  assert.equal(map.writes.get('place_capital_dot_z7')!['text-color'], '#d3dbe5');
  assert.equal(map.writes.get('place_city')!['text-color'], '#bdc8d5');
  assert.equal(map.writes.get('place_village')!['text-color'], '#9ba9b9');
  assert.equal(map.writes.get('watername_sea')!['text-color'], '#9ebac9');
  for (const paint of map.writes.values()) {
    assert.equal(paint['text-halo-color'], '#101820');
    assert.ok(Number(paint['text-halo-width']) >= 1);
  }
});

test('real Protomaps dark and light styles retain layout and label hierarchy', () => {
  for (const flavor of ['black', 'dark', 'grayscale', 'light', 'white'] as const) {
    const style = layers('basemap', namedFlavor(flavor), { lang: 'en' });
    const before = JSON.stringify(style);
    const map = harness(style);
    const light = flavor === 'light' || flavor === 'white';
    improveBasemapLabels(map, light);
    for (const id of ['places_country', 'places_region', 'places_locality', 'places_subplace', 'water_label_ocean', 'earth_label_islands']) {
      assert.ok(map.writes.has(id), `${flavor}: ${id}`);
    }
    assert.equal(map.writes.get('places_country')!['text-halo-color'], light ? '#f5f7fa' : '#101820');
    assert.notEqual(map.writes.get('places_country')!['text-color'], map.writes.get('places_subplace')!['text-color']);
    assert.equal(JSON.stringify(style), before, 'source style and layout are unchanged');
    assert.ok(!map.writes.has('roads_labels_major'));
  }
});

test('unknown, raster, missing, and unmodifiable styles degrade gracefully', () => {
  assert.doesNotThrow(() => improveBasemapLabels(null, false));
  assert.doesNotThrow(() => improveBasemapLabels({getStyle: () => undefined}, true));
  const map = harness([{id:'satellite',type:'raster'}, {id:'custom',type:'symbol'}]);
  improveBasemapLabels(map, true);
  assert.equal(map.writes.size, 0);
  assert.doesNotThrow(() => improveBasemapLabels({getStyle:()=>({layers:[{id:'place_city',type:'symbol'}]}),setPaintProperty:()=>{throw new Error('removed');}},false));
});
