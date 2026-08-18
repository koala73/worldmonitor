// Four road feeds union onto the canadaRoads map layer. Freshness recorded ALL
// of them as `ontario_511`, so an Alberta, Toronto or BC outage either reported
// as an Ontario failure or — for the two with no id at all — never reached the
// freshness panel. These pin one freshness id per source.
//
// Source-text assertions rather than imports: these modules are Vite-side and
// reading them through the test runner pulls in `import.meta.env`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANADA_ROAD_SOURCES } from '../src/services/canada-roads-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const roadsSrc = read('src/services/canada-roads.ts');
const freshnessSrc = read('src/services/data-freshness.ts');
const loaderSrc = read('src/app/data-loader.ts');
const panelsSrc = read('src/config/panels.ts');

/** [{key, freshnessId}] as declared in CANADA_ROAD_FRESHNESS_IDS. */
function freshnessIds(): Array<{ key: string; freshnessId: string }> {
  const block = /CANADA_ROAD_FRESHNESS_IDS = Object\.freeze\(\[([\s\S]*?)\]\s*as const\)/.exec(roadsSrc);
  assert.ok(block, 'CANADA_ROAD_FRESHNESS_IDS must exist');
  return [...block[1].matchAll(/\{\s*key:\s*'([^']+)',\s*freshnessId:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], freshnessId: m[2] }));
}

/**
 * Source keys as declared in CANADA_ROAD_SOURCES. Imported rather than scraped:
 * the descriptors live in `canada-roads-core.ts`, which has no Vite-side imports,
 * so the real list is reachable from a test.
 */
function sourceKeys(): string[] {
  return CANADA_ROAD_SOURCES.map(({ key }) => key);
}

test('every road source has its own freshness id', () => {
  const ids = freshnessIds();
  const keys = sourceKeys();
  assert.equal(keys.length, 5, 'fixture guard: five road sources union onto this layer');
  assert.equal(
    ids.length,
    keys.length,
    'a source without a freshness id reports under another jurisdiction, or not at all',
  );
  assert.deepEqual(ids.map((e) => e.key).sort(), [...keys].sort());
  const unique = new Set(ids.map((e) => e.freshnessId));
  assert.equal(unique.size, ids.length, 'two sources sharing one id is the bug being fixed');
});

test('each freshness id is registered with a distinct name and a degradation message', () => {
  const names: string[] = [];
  for (const { key, freshnessId } of freshnessIds()) {
    const entry = new RegExp(`\\n  ${freshnessId}: \\{ name: '([^']+)'`).exec(freshnessSrc);
    assert.ok(entry, `${freshnessId} (${key}) must be in the freshness registry`);
    names.push(entry[1]);
    // An unregistered id records silently and never renders — the same
    // invisibility the blanket ontario_511 caused, one layer down.
    assert.match(
      freshnessSrc,
      new RegExp(`\\n  ${freshnessId}: '[^']+'`),
      `${freshnessId} needs a degradation message, or its outage renders blank`,
    );
  }
  assert.equal(new Set(names).size, names.length, 'each jurisdiction needs a distinguishable label');
});

test('the freshness ids are declared in the DataSourceId union', () => {
  // An id absent from the union is a type error at the call site, but the call
  // site is a loop over data — so it would only fail at runtime.
  const types = read('src/types/index.ts');
  for (const { freshnessId } of freshnessIds()) {
    assert.match(types, new RegExp(`\\|\\s*'${freshnessId}'`), `${freshnessId} missing from DataSourceId`);
  }
});

test('the loader records per source rather than one blanket ontario_511', () => {
  const block = /const records = await fetchCanadaRoads\(\);[\s\S]*?\n  \}/.exec(loaderSrc);
  assert.ok(block, 'loadCanadaRoads must exist');

  assert.match(block[0], /for \(const \{ key, freshnessId \} of CANADA_ROAD_FRESHNESS_IDS\)/);
  assert.equal(
    /recordUpdate\('ontario_511'/.test(block[0]),
    false,
    'a hardcoded ontario_511 attributes every jurisdiction to Ontario',
  );
  // A degraded source must record an ERROR, not an update carrying the union
  // count — otherwise a dead Alberta feed reports Ontario's records as its own.
  assert.match(block[0], /state === 'unavailable' \|\| state === 'malformed'/);
  assert.match(block[0], /dataFreshness\.recordError\(freshnessId/);
});

test('the canadaRoads panel lists all five sources', () => {
  const line = /canadaRoads: \[([^\]]*)\]/.exec(panelsSrc);
  assert.ok(line, 'canadaRoads must map to freshness sources');
  for (const { freshnessId } of freshnessIds()) {
    assert.match(
      line[1],
      new RegExp(`'${freshnessId}'`),
      `${freshnessId} missing from the panel mapping — its outage would not surface there`,
    );
  }
});
