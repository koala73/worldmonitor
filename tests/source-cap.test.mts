import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectSourcesUnderCap } from '../src/services/source-cap';

const F = (...names: string[]) => names.map((name) => ({ name }));

describe('selectSourcesUnderCap: round-robin per-category fairness', () => {
  it('returns empty when cap is 0', () => {
    const r = selectSourcesUnderCap({ a: F('a1', 'a2') }, [], new Set(), 0);
    assert.equal(r.keep.size, 0);
    assert.deepEqual([...r.autoDisabled].sort(), ['a1', 'a2']);
  });

  it('returns empty for negative cap (defensive)', () => {
    const r = selectSourcesUnderCap({ a: F('a1') }, [], new Set(), -5);
    assert.equal(r.keep.size, 0);
    assert.equal(r.autoDisabled.size, 0);
  });

  it('keeps everything when total <= cap', () => {
    const r = selectSourcesUnderCap(
      { a: F('a1', 'a2'), b: F('b1') },
      F('intel-1'),
      new Set(),
      10,
    );
    assert.equal(r.keep.size, 4);
    assert.equal(r.autoDisabled.size, 0);
    assert.ok(r.keep.has('a1') && r.keep.has('a2') && r.keep.has('b1') && r.keep.has('intel-1'));
  });

  it('REGRESSION: every category gets at least 1 source when cap is small but >= category count', () => {
    // The pre-fix bug: alphabetical sort + slice(0, N) could leave entire
    // categories with ZERO enabled sources. Round-robin must keep ≥1 from
    // each category until budget exhausted.
    const feeds = {
      'aaa-cat': F('alpha-1', 'alpha-2', 'alpha-3'),
      'bbb-cat': F('beta-1', 'beta-2'),
      'zzz-cat': F('zeta-1', 'zeta-2'), // alphabetically last — was the bug victim
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 3);
    assert.equal(r.keep.size, 3);
    // All three categories must have at least one source kept
    assert.ok(r.keep.has('alpha-1'), 'aaa-cat must keep alpha-1');
    assert.ok(r.keep.has('beta-1'), 'bbb-cat must keep beta-1');
    assert.ok(r.keep.has('zeta-1'), 'zzz-cat must keep zeta-1 (was the bug victim)');
  });

  it('REGRESSION: late-alphabet categories are not starved at production-realistic scale', () => {
    // Approximate the production shape: 30 categories, 3-4 feeds each, cap=80.
    // Pre-fix: late-alphabet categories went empty. Post-fix: every category
    // keeps at least its first feed.
    const categories: { [k: string]: ReturnType<typeof F> } = {};
    const letters = 'abcdefghijklmnopqrstuvwxyz1234'.split('');
    for (const letter of letters) {
      categories[`cat-${letter}`] = F(`${letter}-1`, `${letter}-2`, `${letter}-3`);
    }
    const r = selectSourcesUnderCap(categories, [], new Set(), 80);

    for (const letter of letters) {
      assert.ok(
        r.keep.has(`${letter}-1`),
        `category cat-${letter} must keep its first source ${letter}-1 (would have been auto-disabled by pre-fix alphabetical slice for late letters)`,
      );
    }
  });

  it('respects user-disabled sources — never adds them to keep', () => {
    const feeds = { a: F('a1', 'a2'), b: F('b1', 'b2') };
    const userDisabled = new Set(['a1', 'b2']);
    const r = selectSourcesUnderCap(feeds, [], userDisabled, 10);
    assert.ok(!r.keep.has('a1'), 'a1 was user-disabled — must not be re-enabled');
    assert.ok(!r.keep.has('b2'), 'b2 was user-disabled — must not be re-enabled');
    assert.ok(r.keep.has('a2') && r.keep.has('b1'));
    // autoDisabled is the cap-rejected set — it should NOT include user-disabled
    assert.ok(!r.autoDisabled.has('a1'));
    assert.ok(!r.autoDisabled.has('b2'));
  });

  it('takes within-category sources in declaration order (editorial primary first)', () => {
    // feeds.ts editorial team controls "primary source" by listing it first.
    // Round-robin shifts from the front of each bucket — primary always wins.
    const feeds = { a: F('primary', 'secondary', 'tertiary') };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 1);
    assert.ok(r.keep.has('primary'));
    assert.ok(!r.keep.has('secondary'));
    assert.ok(!r.keep.has('tertiary'));
  });

  it('handles INTEL_SOURCES as its own bucket (does not dominate categories)', () => {
    const feeds = { a: F('a1'), b: F('b1') };
    const intel = F('intel-1', 'intel-2', 'intel-3');
    const r = selectSourcesUnderCap(feeds, intel, new Set(), 3);
    // Round-robin: a1, b1, intel-1
    assert.ok(r.keep.has('a1'));
    assert.ok(r.keep.has('b1'));
    assert.ok(r.keep.has('intel-1'));
    assert.equal(r.keep.size, 3);
  });

  it('is deterministic across repeated calls with same input', () => {
    const feeds = {
      a: F('a1', 'a2', 'a3'),
      b: F('b1', 'b2'),
      c: F('c1', 'c2', 'c3', 'c4'),
    };
    const r1 = selectSourcesUnderCap(feeds, [], new Set(), 5);
    const r2 = selectSourcesUnderCap(feeds, [], new Set(), 5);
    assert.deepEqual([...r1.keep].sort(), [...r2.keep].sort());
    assert.deepEqual([...r1.autoDisabled].sort(), [...r2.autoDisabled].sort());
  });

  it('skips empty / undefined categories without crashing', () => {
    const feeds = { a: F('a1'), b: undefined, c: [] };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 10);
    assert.equal(r.keep.size, 1);
    assert.ok(r.keep.has('a1'));
  });

  it('uses Object.entries iteration order (deterministic per category insertion)', () => {
    // With only 1 slot and 3 categories, only the first category's first source
    // makes it. This documents that category iteration follows insertion order.
    const feeds = { gamma: F('g1'), alpha: F('a1'), beta: F('b1') };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 1);
    assert.ok(r.keep.has('g1'), 'gamma was first-inserted — gets the slot');
    assert.ok(!r.keep.has('a1'));
    assert.ok(!r.keep.has('b1'));
  });

  it('autoDisabled excludes sources the user explicitly disabled', () => {
    const feeds = { a: F('a1', 'a2', 'a3') };
    const userDisabled = new Set(['a3']);
    const r = selectSourcesUnderCap(feeds, [], userDisabled, 1);
    assert.ok(r.keep.has('a1'));
    // a2 didn't make the cap → autoDisabled. a3 is user-disabled → not in either.
    assert.ok(r.autoDisabled.has('a2'));
    assert.ok(!r.autoDisabled.has('a3'));
    assert.ok(!r.keep.has('a3'));
  });
});
