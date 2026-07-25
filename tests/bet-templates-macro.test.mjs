import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { generateBets } from '../scripts/_bet-templates.mjs';
import { MACRO_BET_TEMPLATES, FRED_FEED_KEYS, FRED_SERIES } from '../scripts/_bet-templates-macro.mjs';
import {
  parseMetricKey, resolveHardSpec,
  FRED_MONTHLY_VALUE_SETTLEMENT_MAX_LAG_MS, FRED_DAILY_VALUE_SETTLEMENT_MAX_LAG_MS, VALUE_SETTLEMENT_MAX_LAG_MS,
} from '../scripts/_forecast-resolution-eval.mjs';
import { RESOLUTION_FEED_KEYS } from '../scripts/_forecast-resolution.mjs';
import { shapeResolutionFeed, ingestHistory } from '../scripts/seed-forecast-resolutions.mjs';

const NOW = Date.parse('2026-07-23T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const UNRATE_KEY = 'economic:fred:v1:UNRATE:0';

// seed-economy shape (#5098): {series:{observations:[{date,value},...]}} with
// FRED's '.' missing-value sentinel present.
function fredFixture(observations) {
  return { series: { observations } };
}

const UNRATE_OBS = [
  { date: '2026-04-01', value: '4.1' },
  { date: '2026-05-01', value: '.' }, // FRED missing sentinel — must be skipped
  { date: '2026-06-01', value: '4.2' },
];

function unrateFeed() {
  return { [UNRATE_KEY]: fredFixture(UNRATE_OBS) };
}

describe('FRED macro templates', () => {
  it('exact :0-suffixed keys are on the resolution allowlist', () => {
    for (const key of FRED_FEED_KEYS) {
      assert.ok(RESOLUTION_FEED_KEYS.has(key), `${key} missing from RESOLUTION_FEED_KEYS`);
    }
  });

  it('generates a directional threshold bet from the latest finite observation', () => {
    const bets = generateBets(MACRO_BET_TEMPLATES, unrateFeed(), NOW);
    assert.equal(bets.length, 1);
    const bet = bets[0];
    assert.equal(bet.domain, 'macro');
    // latest finite = 4.2 (June), previous finite = 4.1 (April; '.' skipped)
    assert.equal(bet.resolution.baselineValue, 4.2);
    assert.equal(bet.resolution.threshold, 4.3); // rising +0.1 > 0.5% floor
    assert.equal(bet.resolution.sourceFeed, UNRATE_KEY);
    assert.equal(bet.resolution.window, 'at-deadline');
    const parsed = parseMetricKey(bet.resolution.metricKey);
    assert.equal(parsed.fn, 'value');
    assert.equal(parsed.value, 'UNRATE');
    assert.match(bet.question, /US unemployment rate rise to at least 4\.3 % by /);
  });

  it('monthly series carry a ~35d horizon; DGS10 a 7d horizon', () => {
    const monthly = FRED_SERIES.find((s) => s.series === 'UNRATE');
    const daily = FRED_SERIES.find((s) => s.series === 'DGS10');
    assert.equal(monthly.horizonMs, 35 * DAY_MS);
    assert.equal(daily.horizonMs, 7 * DAY_MS);
  });

  it('emits no bet on zero/absent/empty observations', () => {
    assert.equal(generateBets(MACRO_BET_TEMPLATES, { [UNRATE_KEY]: fredFixture([]) }, NOW).length, 0);
    assert.equal(generateBets(MACRO_BET_TEMPLATES, { [UNRATE_KEY]: fredFixture([{ date: '2026-06-01', value: '0' }]) }, NOW).length, 0);
    assert.equal(generateBets(MACRO_BET_TEMPLATES, {}, NOW).length, 0);
  });
});

describe('FRED resolver enablement', () => {
  it('shapeResolutionFeed exposes the latest finite observation with its date as asOf', () => {
    const records = shapeResolutionFeed(UNRATE_KEY, { _seed: {}, data: fredFixture(UNRATE_OBS) });
    assert.deepEqual(records, [{ metric: 'UNRATE', value: 4.2, asOf: '2026-06-01' }]);
  });

  function unrateEntry() {
    const bets = generateBets(MACRO_BET_TEMPLATES, unrateFeed(), NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    return Object.values(ledger)[0];
  }

  it('worst-case calendar alignment PENDS through the monthly grace, then resolves', () => {
    const entry = unrateEntry();
    const deadline = entry.deadline; // NOW + 35d ≈ 2026-08-27 (mid-month)
    // Day 70 past the deadline, feed still holds the pre-deadline June obs:
    // inside the 75d FRED grace → pend (the 10d generic grace would have VOIDed).
    const stale = shapeResolutionFeed(UNRATE_KEY, fredFixture(UNRATE_OBS));
    const day70 = resolveHardSpec(entry, stale, [], deadline + 70 * DAY_MS);
    assert.equal(day70.status, 'pending');
    assert.equal(day70.evidence.reason, 'value_source_not_settled');
    assert.ok(70 * DAY_MS > VALUE_SETTLEMENT_MAX_LAG_MS, 'sanity: generic grace would have VOIDed by now');

    // The September release lands an observation dated ≥ the deadline → resolves.
    const settled = shapeResolutionFeed(UNRATE_KEY, fredFixture([
      ...UNRATE_OBS,
      { date: '2026-09-01', value: '4.4' },
    ]));
    const resolved = resolveHardSpec(entry, settled, [], deadline + 70 * DAY_MS);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.outcome, 'YES'); // 4.4 >= threshold 4.3, rising from 4.2
  });

  it('VOIDs only past the FRED monthly grace when no covering observation ever lands', () => {
    const entry = unrateEntry();
    const stale = shapeResolutionFeed(UNRATE_KEY, fredFixture(UNRATE_OBS));
    const pastGrace = resolveHardSpec(entry, stale, [], entry.deadline + FRED_MONTHLY_VALUE_SETTLEMENT_MAX_LAG_MS + DAY_MS);
    assert.equal(pastGrace.outcome, 'VOID');
    assert.equal(pastGrace.evidence.reason, 'value_source_never_settled');
  });

});

describe('FRED daily (DGS10) settlement grace', () => {
  const DGS10_KEY = 'economic:fred:v1:DGS10:0';
  const DGS10_OBS = [
    { date: '2026-07-20', value: '4.20' },
    { date: '2026-07-21', value: '4.25' },
  ];

  function dgs10Entry() {
    const bets = generateBets(MACRO_BET_TEMPLATES, { [DGS10_KEY]: fredFixture(DGS10_OBS) }, NOW);
    assert.equal(bets.length, 1);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    return Object.values(ledger)[0];
  }

  it('pends past the generic 10d grace inside the 14d daily grace, resolves on a covering observation, VOIDs past grace', () => {
    const entry = dgs10Entry();
    assert.equal(entry.spec.sourceFeed, DGS10_KEY);
    const deadline = entry.deadline; // NOW + 7d = 2026-07-30
    const stale = shapeResolutionFeed(DGS10_KEY, fredFixture(DGS10_OBS));

    // Day 11: past the generic 10d grace, inside the 14d FRED daily grace → pend.
    const day11 = resolveHardSpec(entry, stale, [], deadline + 11 * DAY_MS);
    assert.equal(day11.status, 'pending');
    assert.ok(11 * DAY_MS > VALUE_SETTLEMENT_MAX_LAG_MS, 'sanity: generic grace would have VOIDed by now');

    // A covering daily observation (dated >= the deadline) lands → resolves.
    const settledFeed = shapeResolutionFeed(DGS10_KEY, fredFixture([
      ...DGS10_OBS,
      { date: '2026-07-30', value: '4.40' },
    ]));
    const resolved = resolveHardSpec(entry, settledFeed, [], deadline + 11 * DAY_MS);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.outcome, 'YES'); // 4.40 >= threshold 4.30, rising from 4.25

    // Past the 14d daily grace with no covering observation → VOID.
    const pastGrace = resolveHardSpec(entry, stale, [], deadline + FRED_DAILY_VALUE_SETTLEMENT_MAX_LAG_MS + DAY_MS);
    assert.equal(pastGrace.outcome, 'VOID');
    assert.equal(pastGrace.evidence.reason, 'value_source_never_settled');
  });
});
