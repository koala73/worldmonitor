import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  getLayerExplanation,
  hasCuratedLayerExplanation,
  LAYER_EXPLANATIONS,
  LAYER_REGISTRY,
  V1_LAYER_EXPLANATION_KEYS,
} from '../src/config/map-layer-definitions';

const root = resolve(import.meta.dirname, '..');

describe('layer explanation metadata', () => {
  test('v1 high-adoption layers have curated structured cards', () => {
    const expected = new Set([
      'conflicts',
      'ucdpEvents',
      'ciiChoropleth',
      'natural',
      'flights',
      'ais',
      'waterways',
      'tradeRoutes',
      'cyberThreats',
      'hotspots',
    ]);

    assert.deepEqual(new Set(V1_LAYER_EXPLANATION_KEYS), expected);

    for (const key of V1_LAYER_EXPLANATION_KEYS) {
      assert.ok(LAYER_REGISTRY[key], `${key} must be a registered layer`);
      assert.equal(hasCuratedLayerExplanation(key), true, `${key} must have curated metadata`);

      const explanation = getLayerExplanation(key);
      assert.equal(explanation.coverage, 'curated', `${key} must not use fallback metadata`);
      assert.equal(explanation.key, key);
      assert.ok(explanation.category.trim(), `${key} category is required`);
      assert.ok(explanation.purpose.trim(), `${key} purpose is required`);
      assert.ok(explanation.source.trim(), `${key} source/provider text is required`);
      assert.ok(explanation.freshness.trim(), `${key} freshness text is required`);
      assert.ok(explanation.confidence.trim(), `${key} confidence text is required`);
      assert.ok(explanation.limitations.length > 0, `${key} limitations are required`);
      assert.ok(explanation.related.length > 0, `${key} related panels/actions are required`);
      assert.ok(explanation.evidence.length > 0, `${key} evidence paths are required`);

      for (const evidencePath of explanation.evidence) {
        assert.equal(
          existsSync(resolve(root, evidencePath)),
          true,
          `${key} evidence path does not exist: ${evidencePath}`,
        );
      }
    }
  });

  test('unsupported layers degrade to fallback metadata without fabricating freshness', () => {
    const explanation = getLayerExplanation('dayNight');

    assert.equal(explanation.coverage, 'fallback');
    assert.equal(explanation.key, 'dayNight');
    assert.equal(hasCuratedLayerExplanation('dayNight'), false);
    assert.match(explanation.source, /Not curated/i);
    assert.match(explanation.freshness, /No layer-level freshness contract/i);
    assert.match(explanation.confidence, /Unknown/i);
    assert.deepEqual(explanation.evidence, []);
  });

  test('curated explanations are not accidentally added outside the declared v1 set', () => {
    const declared = new Set<string>(V1_LAYER_EXPLANATION_KEYS);
    const curated = Object.entries(LAYER_EXPLANATIONS)
      .filter(([, explanation]) => explanation?.coverage === 'curated')
      .map(([key]) => key);

    assert.deepEqual(new Set(curated), declared);
  });
});

describe('map layer explanation control wiring', () => {
  const componentSources = new Map([
    ['SVG map', readFileSync(resolve(root, 'src/components/Map.ts'), 'utf8')],
    ['DeckGL map', readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf8')],
    ['Globe map', readFileSync(resolve(root, 'src/components/GlobeMap.ts'), 'utf8')],
  ]);
  const rendererSource = readFileSync(resolve(root, 'src/utils/layer-explanation-card.ts'), 'utf8');

  test('layer pickers render an explanation button for each layer row', () => {
    for (const [name, source] of componentSources) {
      assert.match(source, /layer-toggle-row/, `${name} must keep the layer and explanation controls grouped`);
      assert.match(source, /layer-explain-btn/, `${name} must render explanation buttons`);
      assert.match(source, /aria-label/, `${name} explanation buttons must be screen-reader labeled`);
      assert.match(source, /hasCuratedLayerExplanation/, `${name} must distinguish curated coverage`);
    }
  });

  test('info button opens the structured explanation card without toggling the layer', () => {
    for (const [name, source] of componentSources) {
      assert.match(source, /event\.preventDefault\(\)/, `${name} must not submit or trigger parent controls`);
      assert.match(source, /event\.stopPropagation\(\)/, `${name} must not toggle the layer when opening help`);
      assert.match(source, /this\.showLayerExplanation\(layer\)/, `${name} must open the explanation card`);
      assert.match(source, /getLayerExplanation\(layer\)/, `${name} must use the shared explanation catalog`);
      assert.match(source, /renderLayerExplanationCard/, `${name} must use the shared explanation renderer`);
    }
  });

  test('explanation card exposes source, freshness, confidence, limitations, and related sections', () => {
    for (const label of ['Source', 'Freshness', 'Confidence', 'Limitations', 'Related']) {
      assert.match(rendererSource, new RegExp(`>${label}<`), `missing shared card section: ${label}`);
    }
  });

  test('DeckGL help and explanation popups dismiss each other', () => {
    const source = componentSources.get('DeckGL map');
    assert.ok(source);
    assert.match(source, /querySelector\('\.layer-help-popup'\)\?\.remove\(\)/);
    assert.match(source, /querySelector\('\.layer-explanation-popup'\)\?\.remove\(\)/);
  });

  test('SVG map clears stale outside-click listeners when explanation popups close or switch', () => {
    const source = componentSources.get('SVG map');
    assert.ok(source);
    assert.match(source, /layerExplanationOutsideClickHandler/);
    assert.match(source, /clearLayerExplanationOutsideClickHandler\(\)/);
    assert.match(source, /document\.removeEventListener\('click', this\.layerExplanationOutsideClickHandler\)/);
  });
});
