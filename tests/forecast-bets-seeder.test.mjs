import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildBetsSnapshot, computeNextSeries } from '../scripts/seed-forecast-bets.mjs';
import { ingestHistory, shapeResolutionFeed } from '../scripts/seed-forecast-resolutions.mjs';
import { EIA_PETROLEUM_FEED } from '../scripts/_bet-templates-energy.mjs';
import { resolveHardSpec } from '../scripts/_forecast-resolution-eval.mjs';

const NOW = Date.parse('2026-07-12T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEADLINE = NOW + 7 * DAY_MS; // energy horizon; 2026-07-19

function eiaFixture(overrides = {}) {
  return {
    inventory: { current: 390, previous: 388, date: '2026-07-09', unit: 'Mbbl' },
    production: { current: 13.2, previous: 13.3, date: '2026-07-09', unit: 'Mbbl/d' },
    wti: { current: 78.5, previous: 76.0, date: '2026-07-11', unit: 'USD/bbl' },
    brent: { current: 82.1, previous: 82.1, date: '2026-07-11', unit: 'USD/bbl' },
    ...overrides,
  };
}

describe('buildBetsSnapshot base rate', () => {
  it('falls back to an honest thin-history prior when no series has accumulated', () => {
    // Empty prior series → only the current reading → 0 deltas → directional prior,
    // NOT a fabricated empirical number.
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW, {});
    assert.equal(snap.predictions.length, 4);
    for (const bet of snap.predictions) {
      assert.equal(bet.generationOrigin, 'bet_engine');
      assert.equal(bet.probability, 0.4); // prior_directional, honest placeholder
    }
  });

  it('computes a real empirical base rate over an accumulated multi-release series', () => {
    // Prior inventory releases; appended current (390) gives deltas +3,-2,+5,-2,+6.
    const priorSeries = {
      inventory: [
        { d: '2026-05-01', v: 380 }, { d: '2026-05-08', v: 383 },
        { d: '2026-05-15', v: 381 }, { d: '2026-05-22', v: 386 },
        { d: '2026-05-29', v: 384 },
      ],
    };
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW, priorSeries);
    const inv = snap.predictions.find((b) => b.resolution.metricKey.includes('inventory'));
    // requiredDelta +2 (threshold 392, baseline 390); deltas >= +2: +3,+5,+6 = 3 of 5
    // → (3+1)/(5+1+1) = 0.571429 — a genuine frequency, not the momentum coin-flip.
    assert.equal(inv.probability, 0.571429);
    // metrics without history still get the thin-history prior
    const brent = snap.predictions.find((b) => b.resolution.metricKey.includes('brent'));
    assert.equal(brent.probability, 0.4);
  });
});

describe('computeNextSeries (asOf-deduped accumulator)', () => {
  it('appends one point per real release and dedupes repeated ticks on the same asOf', () => {
    const first = computeNextSeries({ [EIA_PETROLEUM_FEED]: eiaFixture() }, {});
    assert.equal(first.inventory.length, 1);
    assert.deepEqual(first.inventory[0], { d: '2026-07-09', v: 390 });

    // A second daily tick with the SAME release date must not add a duplicate.
    const second = computeNextSeries({ [EIA_PETROLEUM_FEED]: eiaFixture() }, first);
    assert.equal(second.inventory.length, 1);

    // A genuinely new release appends.
    const third = computeNextSeries(
      { [EIA_PETROLEUM_FEED]: eiaFixture({ inventory: { current: 393, previous: 390, date: '2026-07-16', unit: '' } }) },
      second,
    );
    assert.equal(third.inventory.length, 2);
    assert.deepEqual(third.inventory[1], { d: '2026-07-16', v: 393 });
  });
});

describe('shapeResolutionFeed (eia-petroleum loader)', () => {
  it('shapes the flat petroleum snapshot into one record per metric, carrying asOf', () => {
    const records = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture());
    assert.equal(records.length, 4);
    const inv = records.find((r) => r.metric === 'inventory');
    assert.equal(inv.value, 390);
    assert.equal(inv.asOf, '2026-07-09');
  });

  it('unwraps a seed envelope and passes other feeds through untouched', () => {
    const wrapped = shapeResolutionFeed(EIA_PETROLEUM_FEED, { data: eiaFixture() });
    assert.equal(wrapped.find((r) => r.metric === 'wti').value, 78.5);
    const other = [{ country: 'Mali' }];
    assert.equal(shapeResolutionFeed('conflict:ucdp-events:v1', other), other);
  });
});

describe('bet-engine shadow bets flow through ingest → resolve', () => {
  function betEntry(metricSubstr) {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW, {});
    const ledger = ingestHistory({}, [snap], NOW);
    return Object.values(ledger).find((e) => e.spec?.metricKey?.includes(metricSubstr));
  }

  it('ingests a bets snapshot into a bet_engine ledger entry', () => {
    const entry = betEntry('inventory');
    assert.ok(entry);
    assert.equal(entry.generationOrigin, 'bet_engine');
    assert.equal(entry.status, 'pending');
    assert.equal(entry.spec.kind, 'hard');
  });

  it('resolves an up-bet YES when the settled feed crosses the threshold', () => {
    const entry = betEntry('inventory');
    // reading dated on the deadline day (settled) and above threshold 392
    const feed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 396, previous: 390, date: '2026-07-19', unit: '' },
    }));
    const res = resolveHardSpec(entry, feed, [], DEADLINE + DAY_MS);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'YES');
  });

  it('resolves a down-bet YES via the direction-aware crosses path', () => {
    const entry = betEntry('production'); // "fall to at most 13.1", baseline 13.2
    const feed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      production: { current: 13.0, previous: 13.2, date: '2026-07-19', unit: '' },
    }));
    const res = resolveHardSpec(entry, feed, [], DEADLINE + DAY_MS);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'YES'); // 13.0 <= 13.1, falling from baseline 13.2
  });
});

describe('value settlement gate (#2 — no false NO on a stale pre-release read)', () => {
  function inventoryEntry() {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW, {});
    const ledger = ingestHistory({}, [snap], NOW);
    return Object.values(ledger).find((e) => e.spec?.metricKey?.includes('inventory'));
  }

  it('pends when the feed reading predates the deadline (release not out yet)', () => {
    const entry = inventoryEntry();
    // feed still holds a pre-deadline reading (2026-07-12 < deadline 2026-07-19)
    const staleFeed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 390, previous: 388, date: '2026-07-12', unit: '' },
    }));
    const res = resolveHardSpec(entry, staleFeed, [], DEADLINE + DAY_MS);
    assert.equal(res.status, 'pending');
    assert.equal(res.evidence.reason, 'value_source_not_settled');
  });

  it('VOIDs once the settlement grace elapses and the feed never caught up', () => {
    const entry = inventoryEntry();
    const staleFeed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 390, previous: 388, date: '2026-07-12', unit: '' },
    }));
    const res = resolveHardSpec(entry, staleFeed, [], DEADLINE + 11 * DAY_MS);
    assert.equal(res.outcome, 'VOID');
  });
});
