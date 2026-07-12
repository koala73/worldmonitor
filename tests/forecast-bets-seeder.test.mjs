import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildBetsSnapshot } from '../scripts/seed-forecast-bets.mjs';
import { ingestHistory, shapeResolutionFeed } from '../scripts/seed-forecast-resolutions.mjs';
import { EIA_PETROLEUM_FEED } from '../scripts/_bet-templates-energy.mjs';
import { resolveHardSpec } from '../scripts/_forecast-resolution-eval.mjs';

const NOW = Date.parse('2026-07-12T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function eiaFixture(overrides = {}) {
  return {
    inventory: { current: 390, previous: 388, date: '2026-07-09', unit: 'Mbbl' },
    production: { current: 13.2, previous: 13.3, date: '2026-07-09', unit: 'Mbbl/d' },
    wti: { current: 78.5, previous: 76.0, date: '2026-07-11', unit: 'USD/bbl' },
    brent: { current: 82.1, previous: 82.1, date: '2026-07-11', unit: 'USD/bbl' },
    ...overrides,
  };
}

describe('buildBetsSnapshot (shadow seeder)', () => {
  it('generates a resolver-ingestible snapshot with base-rate probabilities', () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    assert.equal(snap.generatedAt, NOW);
    assert.equal(snap.predictions.length, 4);
    for (const bet of snap.predictions) {
      assert.equal(bet.generationOrigin, 'bet_engine');
      assert.ok(bet.resolution && bet.resolution.kind === 'hard');
      // base-rate must have set a real, non-null probability in (0,1)
      assert.ok(Number.isFinite(bet.probability) && bet.probability > 0 && bet.probability < 1, `p=${bet.probability}`);
    }
  });

  it('sets a non-50% base rate from the metric\'s own last move', () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const inv = snap.predictions.find((b) => b.resolution.metricKey.includes('inventory'));
    // series [388,390], requiredDelta +2, one delta +2 crosses → (1+1)/(1+1+1)
    assert.equal(inv.probability, 0.666667);
  });

  it('returns an empty snapshot (no publish) when the feed is absent', () => {
    const snap = buildBetsSnapshot({}, NOW);
    assert.deepEqual(snap.predictions, []);
  });
});

describe('shapeResolutionFeed (eia-petroleum loader)', () => {
  it('shapes the flat petroleum snapshot into one record per metric', () => {
    const records = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture());
    assert.ok(Array.isArray(records));
    assert.equal(records.length, 4);
    const inv = records.find((r) => r.metric === 'inventory');
    assert.equal(inv.value, 390);
  });

  it('unwraps a seed envelope and passes other feeds through untouched', () => {
    const wrapped = shapeResolutionFeed(EIA_PETROLEUM_FEED, { data: eiaFixture() });
    assert.equal(wrapped.find((r) => r.metric === 'wti').value, 78.5);
    const other = [{ country: 'Mali' }];
    assert.equal(shapeResolutionFeed('conflict:ucdp-events:v1', other), other);
  });
});

describe('bet-engine shadow bets flow through ingest → resolve → scored slice', () => {
  it('ingests a bets snapshot into a bet_engine ledger entry', () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const ledger = ingestHistory({}, [snap], NOW);
    const entry = Object.values(ledger).find((e) => e.spec?.metricKey?.includes('inventory'));
    assert.ok(entry, 'inventory bet not ingested');
    assert.equal(entry.generationOrigin, 'bet_engine');
    assert.equal(entry.status, 'pending');
    assert.equal(entry.spec.kind, 'hard');
    assert.equal(entry.probability, 0.666667);
  });

  it('resolves the ingested bet YES when the shaped feed crosses the threshold', () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW);
    const ledger = ingestHistory({}, [snap], NOW);
    const entry = Object.values(ledger).find((e) => e.spec?.metricKey?.includes('inventory'));
    const feedData = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 396, previous: 390, date: '2026-07-19', unit: 'Mbbl' },
    }));
    const res = resolveHardSpec(entry, feedData, [], entry.deadline + DAY_MS);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'YES'); // 396 >= threshold 392
  });
});
