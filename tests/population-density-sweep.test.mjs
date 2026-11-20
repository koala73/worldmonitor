import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSweep } from '../scripts/check-population-density-sweep.mjs';

test('seeded atlas sweep never borrows foreign density or drops table-country land', (t) => {
  const { counts, examples } = runSweep();
  t.diagnostic(JSON.stringify(counts));
  assert.equal(counts.wrongCountry, 0, JSON.stringify(examples));
  assert.equal(counts.nullTableLand, 0);
});
