// What every visitor downloads before deciding they care about Canada.
//
// Measured on production 2026-08-16, the four feeds behind the `canadaRoads`
// map layer cost an anonymous desktop dashboard load ~2.71 MB uncompressed:
//
//   canadaRoads   306,757 B     400 records    was FAST tier
//   albertaRoads  200,882 B     300 records    was FAST tier
//   torontoRoads  1,985,018 B  2,288 records   on-demand
//   bcOpen511     215,450 B     228 records    on-demand
//
// It reached everyone through two independent routes, and closing one without
// the other leaves most of the weight in place:
//
//   1. A bootstrap TIER is not layer-gated. canadaRoads and albertaRoads sat in
//      FAST_KEY_NAMES, so all 507,639 B shipped to every client on every
//      variant — including mobile, where this layer is disabled and none of it
//      could render.
//   2. The on-demand tier exists to keep a payload out of the startup path, but
//      loadCanadaRoads() fetches on-demand sources whenever the layer renders,
//      and the layer shipped ENABLED by default. So the 2.2 MB the on-demand
//      list was protecting everyone from was fetched by everyone anyway. The
//      guard was correct and simply never load-bearing.
//
// These pin both halves. See #6763.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CANADA_ROAD_SOURCES } from '../src/services/canada-roads-core';
import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/**
 * A layer's default in a `MapLayers` object literal.
 *
 * The config modules reach `import.meta.env`, so they cannot be imported here
 * and the boolean has to be read from source. Brace-matched rather than
 * lazily regexed from `const NAME`: a `[\s\S]*?` reach for the key runs on into
 * the NEXT exported object whenever this one omits it, silently reporting a
 * sibling variant's default as this variant's.
 */
function layerDefault(rel: string, objectName: string, layer: string): boolean {
  const src = read(rel);
  const decl = new RegExp(`const ${objectName}[^=]*=\\s*\\{`).exec(src);
  assert.ok(decl, `${rel} must declare ${objectName}`);
  const from = src.indexOf('{', decl.index);
  let depth = 0;
  let end = -1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > from, `${objectName} in ${rel} must be a closed object literal`);
  const body = src.slice(from, end + 1);
  const match = new RegExp(`\\b${layer}:\\s*(true|false)\\b`).exec(body);
  assert.ok(match, `${objectName} in ${rel} must set ${layer}`);
  return match[1] === 'true';
}

test('the layer-default reader can see both booleans', () => {
  // Without this the assertions below pass by always reading false — and the
  // brace matcher must not be reading a neighbouring object's value either.
  assert.equal(layerDefault('src/config/variants/full.ts', 'DEFAULT_MAP_LAYERS', 'conflicts'), true);
  assert.equal(layerDefault('src/config/variants/full.ts', 'DEFAULT_MAP_LAYERS', 'satellites'), false);
  assert.equal(layerDefault('src/config/panels.ts', 'FULL_MAP_LAYERS', 'conflicts'), true);
  // MOBILE_DEFAULT_MAP_LAYERS is declared after DEFAULT_MAP_LAYERS in the same
  // file and disables far more; reading it correctly proves the brace matcher
  // stops at the right closing brace.
  assert.equal(layerDefault('src/config/variants/full.ts', 'MOBILE_DEFAULT_MAP_LAYERS', 'conflicts'), true);
  assert.equal(layerDefault('src/config/variants/full.ts', 'MOBILE_DEFAULT_MAP_LAYERS', 'canadaRoads'), false);
});

test('no Canada road source rides a bootstrap tier', () => {
  const fast = new Set(bootstrapTierKeyNames('fast'));
  const slow = new Set(bootstrapTierKeyNames('slow'));
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));

  assert.ok(CANADA_ROAD_SOURCES.length >= 5, 'expected the five road feeds');
  for (const { key } of CANADA_ROAD_SOURCES) {
    assert.ok(
      onDemand.has(key),
      `${key} must be an on-demand bootstrap key — a tier is not layer-gated, so `
      + 'tiering it ships its payload to every visitor on every variant',
    );
    assert.ok(!fast.has(key), `${key} must not ride the fast tier`);
    assert.ok(!slow.has(key), `${key} must not ride the slow tier`);
  }
});

test('a layer whose sources are all on-demand does not ship enabled', () => {
  // The conditional is the point: on-demand means "kept out of every visitor's
  // startup path", and a default-on layer fetches its sources at startup. The
  // two settings are only consistent in one combination.
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));
  const pulled = CANADA_ROAD_SOURCES.filter(({ key }) => onDemand.has(key)).map(({ key }) => key);
  if (!pulled.length) return; // every source tiered: startup cost is the tier's problem

  for (const [rel, name] of [
    ['src/config/variants/full.ts', 'DEFAULT_MAP_LAYERS'],
    ['src/config/panels.ts', 'FULL_MAP_LAYERS'],
  ] as const) {
    assert.equal(
      layerDefault(rel, name, 'canadaRoads'),
      false,
      `${name} must not enable canadaRoads by default while it pulls the on-demand `
      + `keys [${pulled.join(', ')}] — that fetches ~2.7 MB for every visitor, `
      + 'including everyone who never asked for Canada (#6763)',
    );
  }
});

test('App.ts runs the extracted opt-in helper, not an inline copy', () => {
  // The helper owns the four-branch behavior. If App stops calling it, the
  // unit tests keep passing while returning visitors never migrate.
  const app = read('src/App.ts');
  assert.match(app, /applyCanadaRoadsOptInMigration\(/);
  assert.match(app, /from '@\/services\/canada-roads-opt-in'/);
});
