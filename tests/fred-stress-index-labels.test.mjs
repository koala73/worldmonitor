import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeStressIndex } from '../scripts/_fred-seeder.mjs';

const latest = (value) => ({ observations: [{ date: '2026-11-20', value }] });

test('the T10Y3M stress component is labelled as the Treasury term spread', () => {
  const index = computeStressIndex({
    T10Y2Y: latest(0.52),
    T10Y3M: latest(0.55),
    VIXCLS: latest(18.4),
    STLFSI4: latest(-0.4),
    GSCPI: latest(0.3),
    ICSA: latest(224000),
  });
  const termSpread = index?.components.find((c) => c.id === 'T10Y3M');
  assert.equal(termSpread?.label, '10Y-3M Treasury Spread');
  assert.equal(termSpread?.rawValue, 0.55);
});
