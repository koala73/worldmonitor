import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stringifyWithinBudget } from '../server/_shared/bounded-json.ts';

describe('stringifyWithinBudget', () => {
  it('matches JSON.stringify for plain JSON values under the cap', () => {
    const values = [
      null, 0, -1.5, 1e21, NaN, true, false, '', 'é "q" \\ \n 🌍',
      [], {}, [1, 'a', null, [true]], { a: 1, b: { c: [1, 2, { d: 'x' }] }, e: undefined },
      [undefined, 1], { 'k"ey': 'v' },
    ];
    for (const v of values) {
      const r = stringifyWithinBudget(v, 1024);
      assert.equal(r.ok, true, JSON.stringify(v));
      assert.equal(r.text, JSON.stringify(v) ?? 'null');
    }
    assert.deepEqual(stringifyWithinBudget(undefined, 10), { ok: true, text: 'null' });
  });

  it('rejects at exactly one byte over the cap', () => {
    const v = { a: 'x'.repeat(10) };
    const size = JSON.stringify(v).length;
    assert.equal(stringifyWithinBudget(v, size).ok, true);
    const r = stringifyWithinBudget(v, size - 1);
    assert.equal(r.ok, false);
    assert.ok(r.minBytes > size - 1);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const v = '🌍'.repeat(100); // 200 code units, 400 UTF-8 bytes
    assert.equal(stringifyWithinBudget(v, 300).ok, false);
    assert.equal(stringifyWithinBudget(v, 402).ok, true);
  });

  it('stops early on a shared-reference graph whose serialization would be huge', () => {
    let node = { leaf: 'x'.repeat(16) };
    for (let i = 0; i < 40; i += 1) node = [node, node];
    const started = Date.now();
    const r = stringifyWithinBudget(node, 256 * 1024);
    assert.equal(r.ok, false);
    assert.ok(r.minBytes > 256 * 1024);
    assert.ok(Date.now() - started < 1000);
  });
  it('measures toJSON results within the budget, matching JSON.stringify', () => {
    const date = new Date(0);
    assert.deepEqual(stringifyWithinBudget([date, { at: date }], 1024), {
      ok: true,
      text: JSON.stringify([date, { at: date }]),
    });
    let calls = 0;
    const huge = { toJSON: () => { calls += 1; return 'x'.repeat(1_000_000); } };
    const r = stringifyWithinBudget([huge], 1024);
    assert.equal(r.ok, false);
    assert.equal(calls, 1, 'an over-budget toJSON result is never serialized');
  });
});
