import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { layout, splitBootstrap } from '../scripts/dogfood/split-bootstrap.mjs';

describe('dogfood bootstrap split', () => {
  it('gives each top-level key of each tier its own pretty-printed file, largest last in the index', () => {
    const files = splitBootstrap({
      fast: { data: { theaterPosture: { theaters: [{ id: 'iran', postureLevel: 'normal' }] }, marketQuotes: { quotes: [1, 2, 3] } } },
      slow: { data: { wildfires: { fires: Array.from({ length: 50 }, (_, i) => ({ i })) } } },
    });
    assert.deepEqual(files.map((f) => f.name), ['fast-marketQuotes.json', 'fast-theaterPosture.json', 'slow-wildfires.json']);
    const posture = files.find((f) => f.name === 'fast-theaterPosture.json');
    assert.equal(JSON.parse(posture.text).theaters[0].postureLevel, 'normal');
    assert.ok(posture.text.includes('\n  '), 'indented, so a partial read by line works');
  });

  it('lays out one record per line: the top two levels indented, deeper values compact', () => {
    const text = layout({ quotes: [{ symbol: '^GSPC', price: 1, spark: [1, 2] }, { symbol: '^DJI', price: 2, spark: [] }], at: 5 });
    assert.equal(text, '{\n  "quotes": [\n    {"symbol":"^GSPC","price":1,"spark":[1,2]},\n    {"symbol":"^DJI","price":2,"spark":[]}\n  ],\n  "at": 5\n}');
    assert.deepEqual(JSON.parse(text), { quotes: [{ symbol: '^GSPC', price: 1, spark: [1, 2] }, { symbol: '^DJI', price: 2, spark: [] }], at: 5 });
  });

  it('accepts a payload without a data wrapper and drops key names that could leave the directory', () => {
    const files = splitBootstrap({ fast: { cii: { a: 1 }, '../x': {}, 'a/b': {}, '': {} } });
    assert.deepEqual(files.map((f) => f.name), ['fast-cii.json']);
  });

  it('skips a tier that failed to load instead of failing the run', () => {
    assert.deepEqual(splitBootstrap({ fast: null, slow: 'oops' }), []);
  });
});
