import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { generateBets } from '../scripts/_bet-templates.mjs';
import { COMMODITY_BET_TEMPLATES, COMMODITY_FEED } from '../scripts/_bet-templates-commodities.mjs';
import { parseMetricKey, resolveHardSpec } from '../scripts/_forecast-resolution-eval.mjs';
import { RESOLUTION_FEED_KEYS } from '../scripts/_forecast-resolution.mjs';
import { shapeResolutionFeed, ingestHistory, samplePendingEntries, resolveDueEntries } from '../scripts/seed-forecast-resolutions.mjs';
import { buildBetsSnapshot } from '../scripts/seed-forecast-bets.mjs';
import { EIA_PETROLEUM_FEED } from '../scripts/_bet-templates-energy.mjs';

const NOW = Date.parse('2026-07-12T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEADLINE = NOW + 4 * DAY_MS; // 2026-07-16

// Unwrapped shape (the seeder unwraps {_seed,data} before templates see it).
function commoditiesFixture(overrides = {}) {
  return {
    quotes: [
      { symbol: 'CL=F', name: 'Crude Oil WTI', price: 71.41, change: -0.93 }, // falling
      { symbol: 'BZ=F', name: 'Brent Crude', price: 76.01, change: 0.5 },     // rising
      { symbol: 'NG=F', name: 'Natural Gas', price: 2.94, change: -2.39 },
      { symbol: 'GC=F', name: 'Gold', price: 4113.7, change: -0.65 },
      ...(overrides.extraQuotes || []),
    ],
  };
}

describe('commodity bet templates (fast-resolving lane)', () => {
  it('generates one crisp, resolver-valid bet per commodity', () => {
    const bets = generateBets(COMMODITY_BET_TEMPLATES, { [COMMODITY_FEED]: commoditiesFixture() }, NOW);
    assert.equal(bets.length, 4);
    for (const bet of bets) {
      assert.equal(bet.domain, 'market');
      assert.equal(bet.generationOrigin, 'bet_engine');
      assert.equal(bet.resolution.sourceFeed, COMMODITY_FEED);
      assert.equal(bet.resolution.window, 'at-deadline');
      assert.equal(bet.resolution.deadline, DEADLINE);
      const parsed = parseMetricKey(bet.resolution.metricKey);
      assert.ok(parsed, `did not parse: ${bet.resolution.metricKey}`);
      assert.equal(parsed.fn, 'price');
      assert.equal(parsed.field, 'symbol');
      assert.ok(RESOLUTION_FEED_KEYS.has(bet.resolution.sourceFeed));
    }
  });

  it('frames direction from the latest daily change', () => {
    const bets = generateBets(COMMODITY_BET_TEMPLATES, { [COMMODITY_FEED]: commoditiesFixture() }, NOW);
    const wti = bets.find((b) => b.resolution.metricKey.includes('symbol==CL=F'));
    // change -0.93 → falling → threshold below baseline 71.41 by 2.5% (2-dp)
    assert.equal(wti.resolution.baselineValue, 71.41);
    assert.equal(wti.resolution.threshold, 69.62); // 71.41 - 1.78525 → 69.62
    assert.match(wti.question, /WTI crude oil price fall to at most 69\.62 USD\/bbl by 2026-07-16/);

    const brent = bets.find((b) => b.resolution.metricKey.includes('symbol==BZ=F'));
    // change +0.5 → rising → threshold above baseline
    assert.ok(brent.resolution.threshold > brent.resolution.baselineValue);
    assert.match(brent.question, /Brent crude oil price rise to at least/);
  });

  it('emits no bet for a zero/negative quote or an absent symbol', () => {
    const bad = generateBets(COMMODITY_BET_TEMPLATES, {
      [COMMODITY_FEED]: { quotes: [{ symbol: 'CL=F', price: 0, change: 0 }] },
    }, NOW);
    assert.equal(bad.length, 0);
    const missing = generateBets(COMMODITY_BET_TEMPLATES, { [COMMODITY_FEED]: { quotes: [] } }, NOW);
    assert.equal(missing.length, 0);
  });

  it('skips a bet when the daily direction is undetermined (absent or flat change)', () => {
    // absent `change` (non-trading session) — direction unknown → no bet
    const absent = generateBets(COMMODITY_BET_TEMPLATES, {
      [COMMODITY_FEED]: { quotes: [{ symbol: 'CL=F', price: 71.41 }] },
    }, NOW);
    assert.equal(absent.length, 0);
    // exactly-flat change → no directional signal → no bet (no bullish default)
    const flat = generateBets(COMMODITY_BET_TEMPLATES, {
      [COMMODITY_FEED]: { quotes: [{ symbol: 'CL=F', price: 71.41, change: 0 }] },
    }, NOW);
    assert.equal(flat.length, 0);
  });
});

describe('shapeResolutionFeed exposes the nested commodities quotes array', () => {
  it('unwraps {_seed,data:{quotes}} to the quotes array and stamps asOf', () => {
    const fetchedAt = Date.parse('2026-07-16T06:00:00Z');
    const shaped = shapeResolutionFeed(COMMODITY_FEED, { _seed: { fetchedAt }, data: commoditiesFixture() });
    assert.ok(Array.isArray(shaped));
    const cl = shaped.find((q) => q.symbol === 'CL=F');
    assert.equal(cl.price, 71.41);
    assert.equal(cl.asOf, fetchedAt); // envelope fetchedAt carried onto each quote
  });
});

// Fresh quote dated on/after the deadline; deadline is 2026-07-16.
function shapedFeed(price, fetchedAtIso) {
  return shapeResolutionFeed(COMMODITY_FEED, {
    _seed: { fetchedAt: Date.parse(fetchedAtIso) },
    data: { quotes: [{ symbol: 'CL=F', price, change: -0.5 }] },
  });
}

describe('commodity bets resolve end-to-end (settlement-gated on quote freshness)', () => {
  function wtiBet() {
    const bets = generateBets(COMMODITY_BET_TEMPLATES, { [COMMODITY_FEED]: commoditiesFixture() }, NOW);
    const bet = bets.find((b) => b.resolution.metricKey.includes('symbol==CL=F'));
    return { spec: bet.resolution, generationOrigin: bet.generationOrigin, generatedAt: NOW };
  }

  it('resolves YES when a fresh quote falls past the threshold', () => {
    const res = resolveHardSpec(wtiBet(), shapedFeed(69.0, '2026-07-16T06:00:00Z'), [], DEADLINE + DAY_MS);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'YES'); // 69.0 <= 69.62 (falling bet), fresh quote
  });

  it('resolves NO when a fresh quote stays above the threshold', () => {
    const res = resolveHardSpec(wtiBet(), shapedFeed(70.5, '2026-07-16T06:00:00Z'), [], DEADLINE + DAY_MS);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'NO');
  });

  it('pends before the deadline', () => {
    const feed = shapeResolutionFeed(COMMODITY_FEED, { _seed: { fetchedAt: NOW }, data: commoditiesFixture() });
    const res = resolveHardSpec(wtiBet(), feed, [], NOW + DAY_MS);
    assert.equal(res.status, 'pending');
  });

  it('does NOT resolve a stale kept-warm quote as a deadline price (P2 regression)', () => {
    // Quote fetched two days BEFORE the deadline (fetch-failure keep-warm) —
    // must pend, not record a false YES against a pre-deadline price.
    const stale = shapedFeed(69.0, '2026-07-14T06:00:00Z'); // 2 days pre-deadline
    const res = resolveHardSpec(wtiBet(), stale, [], DEADLINE + DAY_MS);
    assert.equal(res.status, 'pending');
    assert.equal(res.evidence.reason, 'value_source_not_settled');
  });

  it('VOIDs a quote that never freshens past the settlement grace', () => {
    const stale = shapedFeed(69.0, '2026-07-14T06:00:00Z');
    const res = resolveHardSpec(wtiBet(), stale, [], DEADLINE + 11 * DAY_MS);
    assert.equal(res.outcome, 'VOID');
  });
});

describe('seeder emits both energy and commodity bets', () => {
  it('combines families; commodity bets use the honest thin-history prior', () => {
    const snap = buildBetsSnapshot({
      [COMMODITY_FEED]: { _seed: { fetchedAt: NOW }, data: commoditiesFixture() },
    }, NOW, {});
    // 4 commodity bets (no energy feed provided here)
    assert.equal(snap.predictions.length, 4);
    for (const bet of snap.predictions) {
      assert.equal(bet.domain, 'market');
      assert.equal(bet.probability, 0.4); // commodity series empty → prior
    }
    assert.ok(snap.predictions.some((b) => b.resolution.metricKey.includes('symbol==CL=F')));
  });

  it('does NOT generate a commodity bet from a stale kept-warm envelope (P2 #3)', () => {
    const stale = { [COMMODITY_FEED]: { _seed: { fetchedAt: NOW - 6 * DAY_MS }, data: commoditiesFixture() } };
    assert.equal(buildBetsSnapshot(stale, NOW, {}).predictions.length, 0); // 6d > 5d cap → dropped
    const fresh = { [COMMODITY_FEED]: { _seed: { fetchedAt: NOW - DAY_MS }, data: commoditiesFixture() } };
    assert.equal(buildBetsSnapshot(fresh, NOW, {}).predictions.length, 4);
  });
});

describe('commodity resolution hardening (review fixes)', () => {
  function wtiEntryInLedger() {
    const snap = buildBetsSnapshot({ [COMMODITY_FEED]: { _seed: { fetchedAt: NOW }, data: commoditiesFixture() } }, NOW, {});
    const ledger = ingestHistory({}, [snap], NOW);
    const key = Object.keys(ledger).find((k) => ledger[k].spec?.metricKey?.includes('symbol==CL=F'));
    return { ledger, key, deadline: ledger[key].deadline };
  }

  it('never prefers a stale post-deadline sample over the later fresh quote (P1 two-cycle)', () => {
    const { ledger, key, deadline } = wtiEntryInLedger();
    // Cycle 1: post-deadline but the feed still holds a STALE quote (asOf 2 days
    // pre-deadline) whose price 69.0 would score YES.
    const cycle1 = deadline + DAY_MS;
    const staleFeed = { [COMMODITY_FEED]: shapeResolutionFeed(COMMODITY_FEED, {
      _seed: { fetchedAt: deadline - 2 * DAY_MS },
      data: { quotes: [{ symbol: 'CL=F', price: 69.0, change: -0.5 }] },
    }) };
    samplePendingEntries(ledger, staleFeed, cycle1);
    resolveDueEntries(ledger, staleFeed, cycle1);
    assert.equal(ledger[key].status, 'pending'); // gate held the stale cycle

    // Cycle 2: the feed freshens (asOf post-deadline) to 70.5, which scores NO.
    const cycle2 = deadline + 2 * DAY_MS;
    const freshFeed = { [COMMODITY_FEED]: shapeResolutionFeed(COMMODITY_FEED, {
      _seed: { fetchedAt: cycle2 },
      data: { quotes: [{ symbol: 'CL=F', price: 70.5, change: -0.5 }] },
    }) };
    samplePendingEntries(ledger, freshFeed, cycle2);
    resolveDueEntries(ledger, freshFeed, cycle2);
    assert.equal(ledger[key].status, 'resolved');
    // Must reflect the FRESH 70.5 (NO), not the stored stale 69.0 (YES).
    assert.equal(ledger[key].outcome, 'NO');
  });

  it('pends (not VOIDs) when a partial refresh drops the symbol, VOIDs after grace (P2 #2)', () => {
    const { ledger, key, deadline } = wtiEntryInLedger();
    const entry = { spec: ledger[key].spec, generatedAt: NOW };
    // Feed present + fresh, but CL=F is absent (partial refresh dropped it).
    const partial = shapeResolutionFeed(COMMODITY_FEED, {
      _seed: { fetchedAt: deadline + DAY_MS },
      data: { quotes: [{ symbol: 'BZ=F', price: 76 }] },
    });
    const pend = resolveHardSpec(entry, partial, [], deadline + DAY_MS);
    assert.equal(pend.status, 'pending');
    assert.equal(pend.evidence.reason, 'value_source_record_missing');
    const voided = resolveHardSpec(entry, partial, [], deadline + 11 * DAY_MS);
    assert.equal(voided.outcome, 'VOID');
  });
});
