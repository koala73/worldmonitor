import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { defaultOnLayerKeys, defaultOnLayerStats } from '../scripts/lib/default-map-layer-count.mjs';
import { getCompleteLayerCatalogKeys } from '../src/config/map-layer-definitions.ts';

const wrap = (body: string) => `const FULL_MAP_LAYERS: MapLayers = {\n${body}\n};\n\nconst FULL_MOBILE_MAP_LAYERS: MapLayers = {\n  conflicts: true,\n};\n`;

test('counts unquoted and quoted true keys and ignores false ones', () => {
  const source = wrap("  conflicts: true,\n  'bases': true,\n  \"hotspots\" : true,\n  fires: false,");
  assert.deepEqual(defaultOnLayerKeys(source), ['conflicts', 'bases', 'hotspots']);
});

test('ignores true values inside line and block comments', () => {
  const source = wrap('  conflicts: true,\n  // gpsJamming: true,\n  /* satellites: true,\n     webcams: true, */\n  fires: false,');
  assert.deepEqual(defaultOnLayerKeys(source), ['conflicts']);
});

test('counts a bare !_desktop value as on for the website and ignores the iran flag expression', () => {
  const source = wrap('  bases: !_desktop,\n  conflicts: true,\n  iranAttacks: IRAN_ATTACKS_ENABLED && !_desktop,\n  fires: false,');
  assert.deepEqual(defaultOnLayerKeys(source), ['bases', 'conflicts']);
});

test('fails closed on a layout the parser cannot read', () => {
  const source = wrap('  conflicts: true, bases: true,\n  fires: false,');
  assert.throws(() => defaultOnLayerKeys(source), /2 on values but 1 parsed keys/);
});

test('fails closed instead of counting an expression that starts with an on value', () => {
  for (const value of ['!_desktop && false', '!_desktop ? false : true', 'true && false']) {
    assert.throws(() => defaultOnLayerKeys(wrap(`  bases: ${value},`)), /on values but 0 parsed keys/);
  }
});

test('fails closed when the FULL_MAP_LAYERS block is missing', () => {
  assert.throws(() => defaultOnLayerKeys('export const OTHER = {};'), /could not isolate FULL_MAP_LAYERS/);
});

test('counts only catalog layers and rounds the share', () => {
  const source = wrap('  conflicts: true,\n  iranAttacks: true,\n  bases: true,\n  fires: false,');
  assert.deepEqual(defaultOnLayerStats(source, ['conflicts', 'bases', 'fires']), { defaultOnLayers: 2, defaultOnLayerPct: 67 });
});

test('rejects a count of zero or the whole catalog', () => {
  assert.throws(() => defaultOnLayerStats(wrap('  fires: false,'), ['fires', 'bases']), /between 1 and 1, got 0/);
  assert.throws(() => defaultOnLayerStats(wrap('  fires: true,\n  bases: true,'), ['fires', 'bases']), /between 1 and 1, got 2/);
});

test('the real full-variant defaults match the published copy stats', () => {
  const source = readFileSync(new URL('../src/config/panels.ts', import.meta.url), 'utf8');
  const published = JSON.parse(readFileSync(new URL('../pro-test/src/generated/copy-stats.json', import.meta.url), 'utf8'));
  const { defaultOnLayers, defaultOnLayerPct } = published;
  assert.deepEqual(defaultOnLayerStats(source, getCompleteLayerCatalogKeys('full')), { defaultOnLayers, defaultOnLayerPct });
});
