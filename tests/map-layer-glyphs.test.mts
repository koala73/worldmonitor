// Category glyphs on DeckGL map markers (#10139). The map must draw the same
// symbol the Layers menu shows for a layer, and the deck-layer → picker-layer
// mapping must not drift from the layer ids DeckGLMap actually builds.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import type { MapLayers } from '../src/types';
import { LAYER_REGISTRY } from '../src/config/map-layer-definitions';
import {
  CATEGORY_GLYPH_MIN_ZOOM,
  CATEGORY_GLYPH_SPARSE_LIMIT,
  DECK_POINT_LAYER_CATEGORY,
  categoryForDeckLayerId,
  categoryGlyphForLayer,
  categoryGlyphSizePx,
  decodeLayerIcon,
} from '../src/config/map-layer-glyphs';

const deckSource = readFileSync(new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8');

describe('decodeLayerIcon', () => {
  test('decodes decimal and hex entities and requests emoji presentation', () => {
    assert.equal(decodeLayerIcon('&#128293;'), '\u{1F525}️');
    assert.equal(decodeLayerIcon('&#9992;'), '✈️');
    assert.equal(decodeLayerIcon('&#x2708;'), '✈️');
  });

  test('does not double the variation selector', () => {
    assert.equal(decodeLayerIcon('✈️'), '✈️');
  });
});

describe('categoryGlyphForLayer', () => {
  test('uses the Layers-menu icon for the layer', () => {
    assert.equal(categoryGlyphForLayer('fires'), '\u{1F525}️');
    assert.equal(categoryGlyphForLayer('protests'), '\u{1F4E2}️');
    assert.equal(categoryGlyphForLayer('military'), '✈️');
    assert.equal(categoryGlyphForLayer('datacenters'), '\u{1F5A5}️');
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

  test('every mapped deck id is a layer id DeckGLMap builds', () => {
    for (const id of Object.keys(DECK_POINT_LAYER_CATEGORY)) {
      assert.ok(deckSource.includes(`'${id}'`), `DeckGLMap.ts has no layer id '${id}'`);
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
