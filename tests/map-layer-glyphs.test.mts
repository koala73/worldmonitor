// Category glyphs on DeckGL map markers (#10139). The map must draw the same
// symbol the Layers menu shows for a layer, and the deck-layer → picker-layer
// mapping must not drift from the layer ids DeckGLMap actually builds.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import type { MapLayers } from '../src/types';
import { LAYER_REGISTRY } from '../src/config/map-layer-definitions';
import {
  CATEGORY_GLYPH_EXCLUDED_POINT_LAYER_IDS,
  CATEGORY_GLYPH_MIN_ZOOM,
  CATEGORY_GLYPH_SPARSE_LIMIT,
  DECK_POINT_LAYER_CATEGORY,
  categoryForDeckLayerId,
  categoryGlyphForLayer,
  categoryGlyphSizePx,
  decodeLayerIcon,
  markerPixelRadius,
} from '../src/config/map-layer-glyphs';

const deckSource = readFileSync(new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8');

// Ids of the point-marker layers (ScatterplotLayer / IconLayer) DeckGLMap
// builds, read from their declarations. `id: cacheKey` layers resolve through
// the cacheKey constant declared in the same builder.
function deckPointLayerIds(): Set<string> {
  const ids = new Set<string>();
  const decl = /new (?:ScatterplotLayer|IconLayer)(?:<[^>]*>)?\(\{\s*id: ([^,\n]+)/g;
  for (const match of deckSource.matchAll(decl)) {
    const expr = match[1]!;
    if (expr.trim() === 'cacheKey') {
      const before = deckSource.slice(0, match.index);
      const key = [...before.matchAll(/const cacheKey = '([^']+)'/g)].pop();
      if (key) ids.add(key[1]!);
      continue;
    }
    for (const literal of expr.matchAll(/'([^']+)'/g)) ids.add(literal[1]!);
  }
  return ids;
}

describe('decodeLayerIcon', () => {
  test('decodes decimal and hex entities and requests emoji presentation', () => {
    assert.equal(decodeLayerIcon('&#128293;'), '\u{1F525}\uFE0F');
    assert.equal(decodeLayerIcon('&#9992;'), '✈\uFE0F');
    assert.equal(decodeLayerIcon('&#x2708;'), '✈\uFE0F');
  });

  test('does not double the variation selector', () => {
    assert.equal(decodeLayerIcon('✈\uFE0F'), '✈\uFE0F');
  });
});

describe('categoryGlyphForLayer', () => {
  test('uses the Layers-menu icon for the layer', () => {
    assert.equal(categoryGlyphForLayer('fires'), '\u{1F525}\uFE0F');
    assert.equal(categoryGlyphForLayer('protests'), '\u{1F4E2}\uFE0F');
    assert.equal(categoryGlyphForLayer('military'), '✈\uFE0F');
    assert.equal(categoryGlyphForLayer('datacenters'), '\u{1F5A5}\uFE0F');
  });
});

describe('categoryForDeckLayerId', () => {
  test('maps point layers and their ghost pick twins to the owning layer', () => {
    assert.equal(categoryForDeckLayerId('fires-layer'), 'fires');
    assert.equal(categoryForDeckLayerId('protest-clusters-layer'), 'protests');
    assert.equal(categoryForDeckLayerId('outages-layer-ghost'), 'outages');
  });

  test('leaves line, fill and decoration layers unmapped', () => {
    for (const id of ['cables-layer', 'pipelines-layer', 'trade-routes-layer', 'cii-choropleth-layer', 'protest-clusters-badge', 'hotspots-pulse']) {
      assert.equal(categoryForDeckLayerId(id), undefined, id);
    }
  });

  test('every mapped or excluded id is a point layer DeckGLMap builds', () => {
    const built = deckPointLayerIds();
    for (const id of [...Object.keys(DECK_POINT_LAYER_CATEGORY), ...Object.keys(CATEGORY_GLYPH_EXCLUDED_POINT_LAYER_IDS)]) {
      assert.ok(built.has(id), `DeckGLMap.ts builds no point layer '${id}'`);
    }
  });

  test('every point layer DeckGLMap builds is mapped or explicitly excluded', () => {
    const unaccounted = [...deckPointLayerIds()].filter((id) =>
      !(id in DECK_POINT_LAYER_CATEGORY) && !(id in CATEGORY_GLYPH_EXCLUDED_POINT_LAYER_IDS));
    assert.deepEqual(unaccounted, [], 'map each new point layer to its Layers-menu key, or exclude it with a reason');
  });

  test('a layer is never both mapped and excluded', () => {
    for (const id of Object.keys(CATEGORY_GLYPH_EXCLUDED_POINT_LAYER_IDS)) {
      assert.ok(!(id in DECK_POINT_LAYER_CATEGORY), id);
    }
  });

  test('every mapped category is a registered map layer', () => {
    for (const [id, key] of Object.entries(DECK_POINT_LAYER_CATEGORY)) {
      assert.ok(LAYER_REGISTRY[key as keyof MapLayers], `${id} → unknown layer ${key}`);
    }
  });
});

describe('categoryGlyphSizePx', () => {
  test('draws nothing for empty layers or bad zoom', () => {
    assert.equal(categoryGlyphSizePx(5, 0), 0);
    assert.equal(categoryGlyphSizePx(Number.NaN, 10), 0);
  });

  test('below the minimum zoom only sparse layers keep a small glyph', () => {
    assert.equal(categoryGlyphSizePx(1.5, CATEGORY_GLYPH_SPARSE_LIMIT), 12);
    assert.equal(categoryGlyphSizePx(1.5, CATEGORY_GLYPH_SPARSE_LIMIT + 1), 0);
  });

  test('from the minimum zoom every layer gets glyphs that grow and cap at 20px', () => {
    assert.equal(categoryGlyphSizePx(CATEGORY_GLYPH_MIN_ZOOM, 5000), 14);
    assert.ok(categoryGlyphSizePx(CATEGORY_GLYPH_MIN_ZOOM + 2, 5000) > 14);
    assert.equal(categoryGlyphSizePx(18, 5000), 20);
  });
});

describe('markerPixelRadius', () => {
  test('passes pixel radii through the scale and clamp', () => {
    assert.equal(markerPixelRadius({ units: 'pixels', value: 7, lat: 0, zoom: 4 }), 7);
    assert.equal(markerPixelRadius({ units: 'pixels', value: 7, scale: 2, maxPx: 10, lat: 0, zoom: 4 }), 10);
    assert.equal(markerPixelRadius({ units: 'pixels', value: 1, minPx: 6, lat: 0, zoom: 4 }), 6);
  });

  test('converts meters with zoom and latitude like web mercator', () => {
    // 512 * 2^0 px span the equator's 40,075 km at zoom 0.
    const equator = markerPixelRadius({ value: 40_075_016.686, lat: 0, zoom: 0 });
    assert.ok(Math.abs(equator - 512) < 1e-6);
    assert.ok(Math.abs(markerPixelRadius({ value: 1000, lat: 0, zoom: 5 }) * 2 - markerPixelRadius({ value: 1000, lat: 0, zoom: 6 })) < 1e-9);
    assert.ok(markerPixelRadius({ value: 1000, lat: 60, zoom: 5 }) > markerPixelRadius({ value: 1000, lat: 0, zoom: 5 }) * 1.99);
  });

  test('defaults to meters, the ScatterplotLayer default', () => {
    assert.equal(markerPixelRadius({ value: 1000, lat: 0, zoom: 5 }), markerPixelRadius({ units: 'meters', value: 1000, lat: 0, zoom: 5 }));
  });
});
