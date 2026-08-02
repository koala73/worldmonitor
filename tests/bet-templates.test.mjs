import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { generateBets } from '../scripts/_bet-templates.mjs';
import { ENERGY_BET_TEMPLATES, EIA_PETROLEUM_FEED } from '../scripts/_bet-templates-energy.mjs';
import { parseMetricKey, resolveHardSpec } from '../scripts/_forecast-resolution-eval.mjs';
import { RESOLUTION_FEED_KEYS } from '../scripts/_forecast-resolution.mjs';

const NOW = Date.parse('2026-07-12T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function eiaFixture(overrides = {}) {
  return {
    inventory: { current: 390, previous: 388, date: '2026-07-09', unit: 'Mbbl' },     // rising +2
    production: { current: 13.2, previous: 13.3, date: '2026-07-09', unit: 'Mbbl/d' }, // falling -0.1
    wti: { current: 78.5, previous: 76.0, date: '2026-07-11', unit: 'USD/bbl' },       // rising +2.5
    brent: { current: 82.1, previous: 82.1, date: '2026-07-11', unit: 'USD/bbl' },     // flat
    ...overrides,
  };
}

describe('generateBets (registry core)', () => {
  const template = {
    id: 'test:metric',
    feedKey: 'test:feed:v1',
    domain: 'test',
    extractMetric: (feed) => (Number.isFinite(feed?.value) ? { subject: 'thing', value: feed.value } : null),
    horizonPolicy: ({ nowMs }) => nowMs + DAY_MS,
    buildResolutionSpec: ({ deadlineMs, metric }) => ({
      kind: 'hard', metricKey: 'test:feed:v1|value(metric==thing)', operator: 'crosses',
      threshold: metric.value + 1, baselineValue: metric.value, window: 'at-deadline',
      deadline: deadlineMs, sourceFeed: 'test:feed:v1',
    }),
    buildQuestion: () => 'Will thing rise?',
  };

  it('skips a template whose metric is not extractable', () => {
    const bets = generateBets([template], { 'test:feed:v1': { value: null } }, NOW);
    assert.equal(bets.length, 0);
  });

  it('produces a shadow bet with a resolution spec and no probability', () => {
    const bets = generateBets([template], { 'test:feed:v1': { value: 5 } }, NOW);
    assert.equal(bets.length, 1);
    const bet = bets[0];
    assert.equal(bet.generationOrigin, 'bet_engine');
    assert.equal(bet.probability, null);
    assert.equal(bet.domain, 'test');
    assert.equal(bet.resolution.kind, 'hard');
    assert.equal(bet.generatedAt, NOW);
  });

  it('does not throw when a template misbehaves, and dedupes by id@deadline', () => {
    const throwing = { ...template, id: 'boom', extractMetric: () => { throw new Error('bad feed'); } };
    const dup = { ...template, id: 'test:metric' }; // same id → same dedupe key
    const bets = generateBets([template, throwing, dup], { 'test:feed:v1': { value: 5 } }, NOW);
    assert.equal(bets.length, 1); // throwing skipped, duplicate collapsed
  });
});

describe('energy bet templates (eia-petroleum pilot)', () => {
  it('generates one crisp, resolver-valid bet per available metric', () => {
    const bets = generateBets(ENERGY_BET_TEMPLATES, { [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    assert.equal(bets.length, 4);
    for (const bet of bets) {
      assert.equal(bet.domain, 'energy');
      assert.equal(bet.generationOrigin, 'bet_engine');
      assert.equal(bet.resolution.kind, 'hard');
      assert.equal(bet.resolution.sourceFeed, EIA_PETROLEUM_FEED);
      assert.equal(bet.resolution.window, 'at-deadline');
      assert.equal(bet.resolution.deadline, NOW + 7 * DAY_MS);
      // metricKey must parse and use the supported `value` fn on the `metric` field
      const parsed = parseMetricKey(bet.resolution.metricKey);
      assert.ok(parsed, `metricKey did not parse: ${bet.resolution.metricKey}`);
      assert.equal(parsed.fn, 'value');
      assert.equal(parsed.field, 'metric');
      // sourceFeed must be on the resolver allowlist (resolvable by construction)
      assert.ok(RESOLUTION_FEED_KEYS.has(bet.resolution.sourceFeed));
    }
  });

  it('frames a rising metric as a "rise to at least" bet above baseline', () => {
    const bets = generateBets(ENERGY_BET_TEMPLATES, { [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const inv = bets.find((b) => b.resolution.metricKey.includes('metric==inventory'));
    assert.equal(inv.resolution.baselineValue, 390);
    assert.equal(inv.resolution.threshold, 392); // 390 + max(|+2|, 0.5%·390)
    assert.match(inv.question, /US commercial crude oil inventories rise to at least 392 Mbbl by 2026-07-19/);
  });

  it('frames a falling metric as a "fall to at most" bet below baseline', () => {
    const bets = generateBets(ENERGY_BET_TEMPLATES, { [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const prod = bets.find((b) => b.resolution.metricKey.includes('metric==production'));
    assert.equal(prod.resolution.baselineValue, 13.2);
    assert.equal(prod.resolution.threshold, 13.1); // 13.2 - max(|-0.1|, floor)
    assert.match(prod.question, /US crude oil production fall to at most 13\.1 Mbbl\/d/);
  });

  it('applies a floor move on a flat week so the bet is not a coin flip', () => {
    const bets = generateBets(ENERGY_BET_TEMPLATES, { [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const brent = bets.find((b) => b.resolution.metricKey.includes('metric==brent'));
    assert.notEqual(brent.resolution.threshold, brent.resolution.baselineValue);
    assert.ok(brent.resolution.threshold > 82.1); // flat → default up by floor
  });

  it('omits metrics that are absent from the feed snapshot', () => {
    const bets = generateBets(
      ENERGY_BET_TEMPLATES,
      { [EIA_PETROLEUM_FEED]: { inventory: eiaFixture().inventory } },
      NOW,
    );
    assert.equal(bets.length, 1);
    assert.ok(bets[0].resolution.metricKey.includes('metric==inventory'));
  });

  it('emits no bet for a zero/negative reading (broken feed → no guaranteed-YES)', () => {
    const bets = generateBets(
      ENERGY_BET_TEMPLATES,
      { [EIA_PETROLEUM_FEED]: { inventory: { current: 0, previous: 0, date: '2026-07-09', unit: '' } } },
      NOW,
    );
    assert.equal(bets.length, 0);
  });

  it('uses the fallback unit + floor move for the real feed shape (empty unit, large magnitude)', () => {
    // Mirrors prod: unit is '' and inventory is in thousand barrels (~411357).
    const bets = generateBets(
      ENERGY_BET_TEMPLATES,
      { [EIA_PETROLEUM_FEED]: { inventory: { current: 411357, previous: 411357, date: '2026-07-09', unit: '' } } },
      NOW,
    );
    assert.equal(bets.length, 1);
    // flat week → floor move 0.5%·411357 ≈ 2056.8 → threshold 413413.785, labelled kbbl (not Mbbl)
    assert.match(bets[0].question, /US commercial crude oil inventories rise to at least 413413\.785 kbbl/);
    assert.notEqual(bets[0].resolution.threshold, bets[0].resolution.baselineValue);
  });
});

describe('energy bets resolve end-to-end through the existing resolver (KTD2)', () => {
  function inventoryBet() {
    const bets = generateBets(ENERGY_BET_TEMPLATES, { [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const bet = bets.find((b) => b.resolution.metricKey.includes('metric==inventory'));
    return { spec: bet.resolution, generationOrigin: bet.generationOrigin, generatedAt: NOW };
  }

  it('pends before the deadline', () => {
    const res = resolveHardSpec(inventoryBet(), [{ metric: 'inventory', value: 395 }], [], NOW + DAY_MS);
    assert.equal(res.status, 'pending');
  });

  it('resolves YES when the metric crosses the threshold at the deadline', () => {
    const entry = inventoryBet();
    const after = entry.spec.deadline + DAY_MS;
    const res = resolveHardSpec(entry, [{ metric: 'inventory', value: 395 }], [], after);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'YES'); // 395 >= 392, rising from baseline 390
  });

  it('resolves NO when the metric falls short of the threshold', () => {
    const entry = inventoryBet();
    const after = entry.spec.deadline + DAY_MS;
    const res = resolveHardSpec(entry, [{ metric: 'inventory', value: 391 }], [], after);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'NO'); // 391 < 392
  });
});
