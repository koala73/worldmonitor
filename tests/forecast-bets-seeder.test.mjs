import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildBetsSnapshot, computeNextSeries, attachEnsembleProbabilities, collectOpenEnsembleIds,
  ENSEMBLE_TOP_K_DEFAULT,
} from '../scripts/seed-forecast-bets.mjs';
import { ingestHistory, resolveDueEntries, shapeResolutionFeed } from '../scripts/seed-forecast-resolutions.mjs';
import { EIA_PETROLEUM_FEED } from '../scripts/_bet-templates-energy.mjs';
import { MARKET_SLOT_COUNT } from '../scripts/_bet-templates-markets.mjs';
import { MARKET_GEO_SLOT_COUNT } from '../scripts/_bet-templates-markets-geo.mjs';
import { resolveHardSpec } from '../scripts/_forecast-resolution-eval.mjs';
import { createEnsembleCache } from '../scripts/_forecast-ensemble.mjs';

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

  it('keeps EIA pending through the default grace and resolves from the covering weekly report', () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: eiaFixture() }, NOW, {});
    const ledger = ingestHistory({}, [snap], NOW);
    const key = Object.keys(ledger).find((k) => ledger[k].spec?.metricKey?.includes('inventory'));
    const staleFeed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 390, previous: 388, date: '2026-07-12', unit: '' },
    }));
    resolveDueEntries(ledger, { [EIA_PETROLEUM_FEED]: staleFeed }, DEADLINE + 10 * DAY_MS);
    assert.equal(ledger[key].status, 'pending');

    const coveringReport = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 396, previous: 390, date: '2026-07-24', unit: '' },
    }));
    resolveDueEntries(ledger, { [EIA_PETROLEUM_FEED]: coveringReport }, DEADLINE + 11 * DAY_MS);
    assert.equal(ledger[key].status, 'resolved');
    assert.equal(ledger[key].outcome, 'YES');
  });

  it('uses the EIA-specific grace when a partial refresh drops the metric', () => {
    const entry = inventoryEntry();
    const partialFeed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({ inventory: null }));
    const pending = resolveHardSpec(entry, partialFeed, [], DEADLINE + 10 * DAY_MS);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.evidence.reason, 'value_source_record_missing');

    const voided = resolveHardSpec(entry, partialFeed, [], DEADLINE + 14 * DAY_MS);
    assert.equal(voided.outcome, 'VOID');
  });

  it('VOIDs once the EIA-specific settlement grace elapses and the feed never caught up', () => {
    const entry = inventoryEntry();
    const staleFeed = shapeResolutionFeed(EIA_PETROLEUM_FEED, eiaFixture({
      inventory: { current: 390, previous: 388, date: '2026-07-12', unit: '' },
    }));
    const res = resolveHardSpec(entry, staleFeed, [], DEADLINE + 14 * DAY_MS);
    assert.equal(res.outcome, 'VOID');
  });
});

describe('Phase-2: baselines + ensemble stage (#5525 U13)', () => {
  function llmDouble(probability) {
    const fn = async (system, user, options = {}) => {
      fn.calls.push(options.stage);
      if (probability instanceof Error) throw probability;
      return { text: JSON.stringify({ probability, rationale: 'test' }), provider: 'double', model: 'double' };
    };
    fn.calls = [];
    return fn;
  }

  it('every snapshot bet carries baselineProbability + probabilitySource=base_rate', () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW }, data: eiaFixture() } }, NOW, {});
    assert.ok(snap.predictions.length > 0);
    for (const bet of snap.predictions) {
      assert.equal(bet.baselineProbability, bet.probability);
      assert.equal(bet.probabilitySource, 'base_rate');
    }
  });

  it('attachEnsembleProbabilities replaces probability on top-K, keeps the baseline, persists passes', async () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW }, data: eiaFixture() } }, NOW, {});
    const callLLM = llmDouble(0.72);
    const stats = await attachEnsembleProbabilities(snap, { callLLM, topK: 2, news: ['headline'], deadlineMs: Date.now() + 60_000, cache: createEnsembleCache() });
    assert.equal(stats.attempted, 2);
    assert.equal(stats.ensembled, 2);
    const ensembled = snap.predictions.filter((b) => b.probabilitySource === 'ensemble');
    assert.equal(ensembled.length, 2);
    for (const bet of ensembled) {
      assert.equal(bet.probability, 0.72);
      assert.equal(bet.baselineProbability, 0.4); // baseline retained
      assert.equal(bet.passes.length, 3);
    }
    const tail = snap.predictions.filter((b) => b.probabilitySource === 'base_rate');
    assert.ok(tail.length > 0); // only top-K ensembled
    assert.equal(callLLM.calls.length, 6); // 3 passes × K=2
  });

  it('all-fail ensemble leaves bets on the base rate', async () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW }, data: eiaFixture() } }, NOW, {});
    const stats = await attachEnsembleProbabilities(snap, { callLLM: llmDouble(new Error('down')), topK: 2, deadlineMs: Date.now() + 60_000, cache: createEnsembleCache() });
    assert.equal(stats.ensembled, 0);
    for (const bet of snap.predictions) assert.equal(bet.probabilitySource, 'base_rate');
  });

  it('skips open-ensemble ids without consuming a top-K slot (backfills lower ranks)', async () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW }, data: eiaFixture() } }, NOW, {});
    const ranked = [...snap.predictions].sort((a, b) => (b.userValueScore || 0) - (a.userValueScore || 0));
    const first = ranked[0];
    const second = ranked[1];
    assert.ok(first && second && first.id !== second.id);
    const callLLM = llmDouble(0.7);
    const stats = await attachEnsembleProbabilities(snap, {
      callLLM, topK: 1, deadlineMs: Date.now() + 60_000, cache: createEnsembleCache(),
      openEnsembleIds: new Set([first.id]),
    });
    // Open-ensemble skip frees the slot so the next-ranked bet is ensembled.
    assert.equal(stats.skipped, 1);
    assert.equal(stats.attempted, 1);
    assert.equal(stats.ensembled, 1);
    assert.equal(first.probabilitySource, 'base_rate');
    assert.equal(second.probabilitySource, 'ensemble');
    assert.equal(callLLM.calls.length, 3); // 3 passes × 1 new attempt
  });

  it('ENSEMBLE_TOP_K default leaves room for Gate-2 lanes after full geo+general slates', () => {
    // 6 geo (0.9) + 6 general (0.8) must not exhaust K; energy (0.75) needs a seat.
    assert.equal(ENSEMBLE_TOP_K_DEFAULT, MARKET_GEO_SLOT_COUNT + MARKET_SLOT_COUNT + 6);
    assert.ok(ENSEMBLE_TOP_K_DEFAULT > MARKET_GEO_SLOT_COUNT + MARKET_SLOT_COUNT);
  });

  it('multi-family ranking: topK=12 starves energy; default K admits energy under full geo+general', async () => {
    // Synthetic scores mirror production families without needing live market feeds.
    const bets = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `geo-${i}`, title: `geo ${i}`, userValueScore: 0.9,
        baselineProbability: 0.4, probability: 0.4, probabilitySource: 'base_rate',
        resolution: { operator: 'crosses', threshold: 50, baselineValue: 20 },
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `mkt-${i}`, title: `market ${i}`, userValueScore: 0.8,
        baselineProbability: 0.4, probability: 0.4, probabilitySource: 'base_rate',
        resolution: { operator: 'crosses', threshold: 50, baselineValue: 20 },
      })),
      {
        id: 'energy-wti', title: 'WTI rise', userValueScore: 0.75,
        baselineProbability: 0.4, probability: 0.4, probabilitySource: 'base_rate',
        resolution: { operator: 'gte', threshold: 80, baselineValue: 78 },
      },
    ];
    const callLLMStarved = llmDouble(0.66);
    const starved = await attachEnsembleProbabilities(
      { predictions: bets.map((b) => ({ ...b })) },
      { callLLM: callLLMStarved, topK: 12, deadlineMs: Date.now() + 60_000, cache: createEnsembleCache() },
    );
    assert.equal(starved.attempted, 12);
    assert.equal(starved.ensembled, 12);
    // Rebuild — previous call mutated copies only; fresh list for the default-K case.
    const bets2 = bets.map((b) => ({ ...b }));
    const callLLMRoom = llmDouble(0.66);
    const room = await attachEnsembleProbabilities(
      { predictions: bets2 },
      { callLLM: callLLMRoom, topK: ENSEMBLE_TOP_K_DEFAULT, deadlineMs: Date.now() + 60_000, cache: createEnsembleCache() },
    );
    assert.equal(room.attempted, 13); // 6 geo + 6 general + 1 energy
    assert.equal(room.ensembled, 13);
    const energy = bets2.find((b) => b.id === 'energy-wti');
    assert.equal(energy.probabilitySource, 'ensemble');
  });

  it('collectOpenEnsembleIds indexes only pending FULL-ensemble entries — partials retry (review #3)', () => {
    const ids = collectOpenEnsembleIds({
      a: { id: 'x', status: 'pending', probabilitySource: 'ensemble' },
      b: { id: 'y', status: 'pending', probabilitySource: 'base_rate' },
      c: { id: 'z', status: 'resolved', probabilitySource: 'ensemble' },
      d: { id: 'w', status: 'pending', probabilitySource: 'ensemble_partial' },
    });
    assert.deepEqual([...ids], ['x']);
  });

  it('a partial round attaches as ensemble_partial so the open window is not frozen (review #3)', async () => {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW }, data: eiaFixture() } }, NOW, {});
    let call = 0;
    const partialLLM = async (_system, _user, options = {}) => {
      call += 1;
      if (options.stage === 'ensemble_inside_view') return { text: 'no probability here' };
      return { text: JSON.stringify({ probability: 0.7, rationale: 'test' }), provider: 'double', model: 'double' };
    };
    const stats = await attachEnsembleProbabilities(snap, { callLLM: partialLLM, topK: 1, deadlineMs: Date.now() + 60_000, cache: createEnsembleCache() });
    assert.equal(stats.ensembled, 0);
    assert.equal(stats.partial, 1);
    const bet = snap.predictions.find((b) => b.probabilitySource === 'ensemble_partial');
    assert.ok(bet, 'partial result attached under its own provenance');
    assert.equal(bet.probability, 0.7);
    assert.equal(bet.baselineProbability, 0.4); // baseline retained
    assert.equal(bet.passes.length, 3);
    assert.ok(call >= 3);
  });
});

describe('Phase-2: resolver ingest pass-through + no-downgrade guard (#5525 KTD5)', () => {
  function betSnapshot(extra = {}) {
    const snap = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW }, data: eiaFixture() } }, NOW, {});
    for (const bet of snap.predictions) Object.assign(bet, extra);
    return snap;
  }

  it('createEntry carries baselineProbability, probabilitySource, and passes into the ledger', () => {
    const snap = betSnapshot({ probabilitySource: 'ensemble', probability: 0.7, passes: [{ name: 'p1', probability: 0.7 }] });
    const ledger = ingestHistory({}, [snap], NOW);
    const entry = Object.values(ledger)[0];
    assert.equal(entry.probability, 0.7);
    assert.equal(entry.probabilitySource, 'ensemble');
    assert.equal(entry.baselineProbability, 0.4);
    assert.equal(entry.passes.length, 1);
  });

  it('updateOpenWindow never downgrades an ensemble probability to a later base-rate', () => {
    const ensembled = betSnapshot({ probabilitySource: 'ensemble', probability: 0.7 });
    const ledger = ingestHistory({}, [ensembled], NOW);
    // Next run: same bets fall out of top-K → re-ingested with base-rate 0.4.
    const baseRate = betSnapshot(); // probabilitySource base_rate, probability 0.4
    baseRate.generatedAt = NOW + 60_000;
    for (const bet of baseRate.predictions) bet.generatedAt = NOW + 60_000;
    const after = ingestHistory(ledger, [baseRate], NOW + 60_000);
    const entry = Object.values(after)[0];
    assert.equal(entry.probability, 0.7); // NOT reverted to 0.4
    assert.equal(entry.probabilitySource, 'ensemble');
  });

  it('updateOpenWindow still updates base-rate→base-rate and ensemble→ensemble', () => {
    const first = betSnapshot(); // base_rate 0.4
    const ledger = ingestHistory({}, [first], NOW);
    const second = betSnapshot({ probability: 0.45 });
    for (const bet of second.predictions) bet.generatedAt = NOW + 60_000;
    second.generatedAt = NOW + 60_000;
    const after = ingestHistory(ledger, [second], NOW + 60_000);
    assert.equal(Object.values(after)[0].probability, 0.45); // base→base updates
  });

  it('a later base_rate re-ingest never clobbers an ensemble_partial window (review R2 #1)', () => {
    // Budget break / top-K miss re-ingests the bet as base_rate. The partial
    // is the only DERIVED probability the window has — grading the placeholder
    // prior instead would corrupt the Gate-2 evidence.
    const partial = betSnapshot({ probabilitySource: 'ensemble_partial', probability: 0.6 });
    let ledger = ingestHistory({}, [partial], NOW);
    const baseRate = betSnapshot(); // probabilitySource base_rate, probability 0.4
    for (const bet of baseRate.predictions) bet.generatedAt = NOW + 60_000;
    baseRate.generatedAt = NOW + 60_000;
    ledger = ingestHistory(ledger, [baseRate], NOW + 60_000);
    const entry = Object.values(ledger)[0];
    assert.equal(entry.probability, 0.6); // NOT reverted to 0.4
    assert.equal(entry.probabilitySource, 'ensemble_partial');
  });

  it('open-window updates refresh calibration so market comparisons stay contemporaneous (review R2 #3)', () => {
    const first = betSnapshot({ calibration: { marketPrice: 62, source: 'polymarket' } });
    let ledger = ingestHistory({}, [first], NOW);
    assert.equal(Object.values(ledger)[0].calibration.marketPrice, 62);
    // Ensemble upgrade arrives with the market having moved: vsMarketSkill /
    // deviationSkill compare entry.probability to calibration.marketPrice, so
    // the graded probability must be paired with the contemporaneous price.
    const upgraded = betSnapshot({
      probabilitySource: 'ensemble', probability: 0.7,
      calibration: { marketPrice: 71, source: 'polymarket' },
    });
    for (const bet of upgraded.predictions) bet.generatedAt = NOW + 60_000;
    upgraded.generatedAt = NOW + 60_000;
    ledger = ingestHistory(ledger, [upgraded], NOW + 60_000);
    let entry = Object.values(ledger)[0];
    assert.equal(entry.probability, 0.7);
    assert.equal(entry.calibration.marketPrice, 71);
    // ensemble→ensemble same-rank refresh keeps working too.
    const refreshed = betSnapshot({
      probabilitySource: 'ensemble', probability: 0.75,
      calibration: { marketPrice: 74, source: 'polymarket' },
    });
    for (const bet of refreshed.predictions) bet.generatedAt = NOW + 120_000;
    refreshed.generatedAt = NOW + 120_000;
    ledger = ingestHistory(ledger, [refreshed], NOW + 120_000);
    entry = Object.values(ledger)[0];
    assert.equal(entry.probability, 0.75);
    assert.equal(entry.calibration.marketPrice, 74);
  });

  it('a later FULL ensemble upgrades a partial entry; a later partial never downgrades a full (review #3)', () => {
    // partial → full: upgrade allowed, passes carried through the merge.
    const partial = betSnapshot({ probabilitySource: 'ensemble_partial', probability: 0.6, passes: [{ name: 'p', probability: 0.6 }, { name: 'q', probability: null }] });
    let ledger = ingestHistory({}, [partial], NOW);
    const full = betSnapshot({ probabilitySource: 'ensemble', probability: 0.7, passes: [{ name: 'a', probability: 0.7 }] });
    for (const bet of full.predictions) bet.generatedAt = NOW + 60_000;
    full.generatedAt = NOW + 60_000;
    ledger = ingestHistory(ledger, [full], NOW + 60_000);
    let entry = Object.values(ledger)[0];
    assert.equal(entry.probability, 0.7);
    assert.equal(entry.probabilitySource, 'ensemble');
    assert.equal(entry.passes.length, 1); // merged forecast's passes copied

    // full → partial: the no-downgrade guard holds.
    const laterPartial = betSnapshot({ probabilitySource: 'ensemble_partial', probability: 0.5 });
    for (const bet of laterPartial.predictions) bet.generatedAt = NOW + 120_000;
    laterPartial.generatedAt = NOW + 120_000;
    ledger = ingestHistory(ledger, [laterPartial], NOW + 120_000);
    entry = Object.values(ledger)[0];
    assert.equal(entry.probability, 0.7);
    assert.equal(entry.probabilitySource, 'ensemble');
  });

  it('non-market deadlines never creep on re-ingest (guard for review #4 scope)', () => {
    // Energy horizons are wall-clock derived: a next-day run generates a later
    // deadline for the same id. The merge must NOT advance the open window's
    // deadline or daily reruns would keep the bet open forever.
    const first = betSnapshot();
    const ledger = ingestHistory({}, [first], NOW);
    const entryBefore = Object.values(ledger)[0];
    const nextDay = buildBetsSnapshot({ [EIA_PETROLEUM_FEED]: { _seed: { fetchedAt: NOW + DAY_MS }, data: eiaFixture() } }, NOW + DAY_MS, {});
    const after = ingestHistory(ledger, [nextDay], NOW + DAY_MS);
    const entryAfter = Object.values(after).find((e) => e.key === entryBefore.key);
    assert.equal(entryAfter.deadline, entryBefore.deadline);
    assert.equal(entryAfter.spec.deadline, entryBefore.spec.deadline);
  });
});
