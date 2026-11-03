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
  it('calls each toJSON once, with its key, and writes exactly that result', () => {
    const date = new Date(0);
    const v = [date, { at: date }];
    assert.deepEqual(stringifyWithinBudget(v, 1024), { ok: true, text: JSON.stringify(v) });

    const keys = [];
    const spy = { toJSON: (key) => { keys.push(key); return key === 'skip' ? undefined : 1; } };
    const r = stringifyWithinBudget({ a: spy, skip: spy, b: [spy] }, 1024);
    assert.deepEqual(r, { ok: true, text: '{"a":1,"b":[1]}' });
    assert.deepEqual(keys, ['a', 'skip', '0']);

    // A toJSON that is small on its first call and huge on its second must
    // not slip a large result past the budget.
    let calls = 0;
    const flip = { toJSON: () => (calls++ === 0 ? 'ok' : 'x'.repeat(1_000_000)) };
    assert.deepEqual(stringifyWithinBudget([flip], 1024), { ok: true, text: '["ok"]' });
    assert.equal(calls, 1);
  });

  it('throws on cycles and BigInt like JSON.stringify', () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(() => stringifyWithinBudget(cyclic, 1024), TypeError);
    assert.throws(() => stringifyWithinBudget({ n: 1n }, 1024), TypeError);
    // Shared (non-cyclic) references are fine.
    const leaf = { x: 1 };
    assert.equal(stringifyWithinBudget([leaf, leaf], 1024).ok, true);
  });
});
