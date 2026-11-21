import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { loadCiiFixtures } from '../scripts/lib/cii-fixtures.mts';
import { computeCiiScoreTable } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { summarizeUcdp } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';

const require = createRequire(import.meta.url);
const { summarizeUcdpWindow } = require('../scripts/shared/ucdp-candidate.cjs');

it('released v14 reads the same sample-month inputs and table with the additive writer payload', () => {
  assert.equal(CII_FORMULA_VERSION, 'v14');
  const fixture = loadCiiFixtures().at(-1)!;
  const day = 86_400_000;
  const events = Object.values(TIER1_COUNTRIES).flatMap((country, index) =>
    Array.from({ length: 12 }, (_, n) => ({
      id: `${country}-${n}`, country, dateStart: fixture.nowMs - (n + 1) * day,
      dateEnd: fixture.nowMs - (n + 1) * day, deathsBest: index + n,
      location: { latitude: 1, longitude: 1 }, hasPreciseLocation: true,
      violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
    })),
  );
  const oldPayload = { events, fetchedAt: fixture.nowMs, candidateVersion: '26.0.9' };
  const summary = summarizeUcdpWindow(events, { startMs: fixture.nowMs - 365 * day, endMs: fixture.nowMs });
  const newPayload = { ...oldPayload, countryDays: summary.countryDays, dailyTotals: summary.dailyTotals,
    window: { complete: true, startMs: fixture.nowMs - 365 * day, endMs: fixture.nowMs } };
  const options = { nowMs: fixture.nowMs, iranEventsEnabled: fixture.iranEventsEnabled };
  const oldTable = computeCiiScoreTable({ ...fixture.inputs, ucdp: oldPayload }, options);
  const newTable = computeCiiScoreTable({ ...fixture.inputs, ucdp: newPayload }, options);
  assert.deepEqual(newTable.aux.ucdpEvents, oldTable.aux.ucdpEvents);
  assert.deepEqual(newTable.rows, oldTable.rows);
  assert.deepEqual(newTable.scores, oldTable.scores);
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    assert.deepEqual(summarizeUcdp(newPayload, code), summarizeUcdp(oldPayload, code));
  }
});
