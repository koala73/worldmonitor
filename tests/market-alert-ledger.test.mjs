import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MARKET_ALERT_ACTIVITY_GAP_MS,
  MARKET_ALERT_ACTIVITY_MAX_RUNS,
  MARKET_ALERT_ACTIVITY_RETENTION_MS,
  MARKET_ALERT_BASE_RATE_RULE,
  MARKET_ALERT_EVIDENCE_EXPIRY_MS,
  MARKET_ALERT_LEDGER_RETENTION_MS,
  MARKET_ALERT_RESOLUTION_RULE,
  MARKET_ALERT_WINDOW_MS,
  buildScorecard,
  entityForMarket,
  entityForPrediction,
  ingestSignals,
  pruneLedger,
  resolveDueEntries,
  storyMatchesEntity,
} from '../scripts/_market-alert-ledger.mjs';
import { MARKET_ALERT_TYPES } from '../scripts/shared/market-alert-core.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const CRUDE = { symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 80, change: 3.1 };
const WHEAT = { symbol: 'ZW=F', name: 'Wheat', display: 'Wheat', price: 600, change: 2.4 };
const AVGO = { symbol: 'AVGO', name: 'Broadcom', display: 'AVGO', price: 1500, change: 5.0 };
const RATE_CUT = { title: 'Will the Fed cut rates in December?', yesPrice: 30, volume: 1000, url: 'https://polymarket.com/event/fed-cut' };

function marketSignal(type, market, overrides = {}) {
  return {
    id: `sig-${type}-${market.symbol}`,
    type,
    title: 'Silent Divergence',
    description: `${market.name} moved +${market.change.toFixed(2)}% - no news found for: ${market.symbol}, ${market.name}`,
    confidence: 0.71,
    timestamp: new Date(NOW),
    data: { marketChange: market.change, newsVelocity: 0, correlatedEntities: [market.symbol] },
    ...overrides,
  };
}

function predictionSignal(pred, shift) {
  return {
    id: 'sig-pred',
    type: 'prediction_leads_news',
    title: 'Prediction Market Shift',
    description: `"${pred.title}" moved ${shift}% with low news coverage`,
    confidence: 0.75,
    timestamp: new Date(NOW),
    data: {
      predictionShift: shift,
      newsVelocity: 0,
      relatedTopics: ['fed', 'interest', 'inflation', 'recession'],
      correlatedEntities: [`${pred.url}|${pred.title}`],
    },
  };
}

const QUIET_BASELINE = { marketChanges: { 'CL=F': 1.0, 'ZW=F': 1.0 }, emitted: [], activity: {} };
const heldRun = (sinceMs, untilMs, types = ['silent_divergence']) => ({ since: sinceMs, until: untilMs, types });
// The previous tick held a silent alert for crude: its run is five minutes old.
const alertedAt = (nowMs) => ({ marketChanges: { 'CL=F': 3.0 }, emitted: ['silent_divergence:CL=F'], activity: { 'CL=F': [heldRun(nowMs - 5 * MIN, nowMs - 5 * MIN)] } });

function ingest(ledger, signals, nowMs = NOW, baseline = QUIET_BASELINE) {
  return ingestSignals(ledger, signals, { nowMs, runtimeMode: 'legacy', markets: [CRUDE, WHEAT], predictions: [RATE_CUT], baseline });
}

function every(fromMinutes, toMinutes, types) {
  const ticks = [];
  for (let minutes = fromMinutes; minutes <= toMinutes; minutes += 5) ticks.push([minutes, types]);
  return ticks;
}

// A tick whose third element is null has no baseline, as at cold start or
// after a seeder gap; its runs still carry over, as the seeder reads them
// from the stale snapshot, and its observedAt is the previous tick's time,
// as the snapshot's timestamp is. 'unquoted' is the tick after a feed skip,
// whose baseline lacks the symbol's quote.
function runTicks(ticks, market) {
  let state = { ledger: {}, emitted: [], activity: {}, held: [], observedAt: null };
  for (const [minutes, types, baseline] of ticks) {
    const nowMs = NOW + minutes * MIN;
    const marketChanges = baseline === 'unquoted' ? {} : { [market.symbol]: market.change };
    const tick = ingestSignals(state.ledger, types.map((type) => marketSignal(type, market)), {
      nowMs,
      runtimeMode: 'legacy',
      markets: [market],
      predictions: [],
      baseline: baseline === null ? null : { marketChanges, emitted: state.emitted, activity: state.activity },
      activity: state.activity,
      observedAt: state.observedAt,
    });
    state = { ledger: tick.ledger, emitted: tick.emitted, activity: tick.activity, held: [...state.held, tick.held], observedAt: nowMs };
  }
  return state;
}

function rowsOf(ledger) {
  return Object.values(ledger).map((entry) => [entry.type, entry.emittedAt]);
}

function archiveOf(stories, tiers, coveredFromMs = NOW - HOUR, truncated = false) {
  return {
    readStories: async () => ({ coveredFromMs, truncated, stories }),
    readSourceTiers: async (hashes) => new Map(hashes.map((hash) => [hash, tiers[hash] ?? { tier: 4, source: 'unknown' }])),
  };
}

const NO_ARCHIVE_PASS = { readFailed: false, truncated: false, unproven: 0, coveredFromMs: null, readAt: null };

describe('ingestSignals', () => {
  it('creates an id@deadline entry with the whitelisted fields', () => {
    const { ledger, created } = ingest({}, [marketSignal('silent_divergence', CRUDE)]);
    assert.equal(created, 1);
    const key = `silent_divergence:CL=F@${NOW + MARKET_ALERT_WINDOW_MS}`;
    assert.deepEqual(Object.keys(ledger), [key]);
    const entry = ledger[key];
    assert.deepEqual(entry, {
      id: 'silent_divergence:CL=F',
      key,
      type: 'silent_divergence',
      entity: { kind: 'market', symbol: 'CL=F', name: 'Crude Oil', entityId: 'CL=F' },
      emittedAt: NOW,
      deadline: NOW + MARKET_ALERT_WINDOW_MS,
      observedChange: 3.1,
      newsVelocity: 0,
      confidence: 0.71,
      runtimeMode: 'legacy',
      description: 'Crude Oil moved +3.10% - no news found for: CL=F, Crude Oil',
      lastSeenAt: NOW,
      samples: 0,
      status: 'pending',
    });
  });

  it('records a prediction signal with its question, url, and the topics named in the question', () => {
    const { ledger } = ingest({}, [predictionSignal(RATE_CUT, -10)]);
    const [entry] = Object.values(ledger);
    assert.equal(entry.id, `prediction_leads_news:${RATE_CUT.url}|${RATE_CUT.title}`);
    assert.equal(entry.observedChange, -10);
    assert.deepEqual(entry.entity, {
      kind: 'prediction',
      title: RATE_CUT.title,
      url: RATE_CUT.url,
      relatedTopics: ['fed'],
    });
  });

  it('a prediction whose question has no topic keyword opens no row', () => {
    const rain = { title: 'Will it rain in London on Friday?', yesPrice: 50, volume: 10, url: 'https://polymarket.com/event/rain' };
    const { ledger, created, gated } = ingestSignals({}, [predictionSignal(rain, 8)], {
      nowMs: NOW, runtimeMode: 'legacy', markets: [], predictions: [rain], baseline: { marketChanges: {}, emitted: [] },
    });
    assert.deepEqual(ledger, {});
    assert.equal(created, 0);
    assert.equal(gated, 1);
  });

  it('resolves a market symbol to its registry entity through an alias and keeps null when none exists', () => {
    assert.deepEqual(entityForMarket({ symbol: 'BTC', name: 'Bitcoin' }), { kind: 'market', symbol: 'BTC', name: 'Bitcoin', entityId: 'bitcoin' });
    assert.deepEqual(entityForMarket(WHEAT), { kind: 'market', symbol: 'ZW=F', name: 'Wheat', entityId: null });
  });

  it('re-emission inside the window bumps lastSeenAt and samples without a second row', () => {
    const first = ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger;
    const { ledger, created, updated } = ingest(first, [marketSignal('silent_divergence', CRUDE)], NOW + 5 * 60 * 1000);
    assert.equal(created, 0);
    assert.equal(updated, 1);
    const entries = Object.values(ledger);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].lastSeenAt, NOW + 5 * 60 * 1000);
    assert.equal(entries[0].samples, 1);
    assert.equal(entries[0].emittedAt, NOW);
  });

  it('opens a new window once the previous deadline is more than the gap behind', () => {
    const first = ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger;
    const atGap = ingest(first, [marketSignal('silent_divergence', CRUDE)], NOW + MARKET_ALERT_WINDOW_MS + MARKET_ALERT_ACTIVITY_GAP_MS);
    assert.deepEqual({ created: atGap.created, held: atGap.held }, { created: 0, held: 1 });
    const { ledger, created } = ingest(first, [marketSignal('silent_divergence', CRUDE)], NOW + MARKET_ALERT_WINDOW_MS + MARKET_ALERT_ACTIVITY_GAP_MS + 1);
    assert.equal(created, 1);
    assert.equal(Object.keys(ledger).length, 2);
  });

  it('a quiet-market signal opens a row only when no held activity for the symbol is under way', () => {
    const crude = [marketSignal('silent_divergence', CRUDE), marketSignal('flow_price_divergence', CRUDE)];
    const fresh = ingest({}, crude, NOW, { marketChanges: { 'CL=F': 3.0 }, emitted: [] });
    assert.deepEqual({ created: fresh.created, held: fresh.held }, { created: 2, held: 0 });

    const underWay = ingest({}, crude, NOW, alertedAt(NOW));
    assert.deepEqual({ ledger: underWay.ledger, created: underWay.created, held: underWay.held }, { ledger: {}, created: 0, held: 2 }, 'held activity of any type for the symbol holds both quiet-market alerts');

    const unseen = ingest({}, crude, NOW, { marketChanges: { 'ZW=F': 3.0 }, emitted: [] });
    assert.deepEqual({ ledger: unseen.ledger, created: unseen.created, held: unseen.held }, { ledger: {}, created: 0, held: 2 }, 'a symbol absent from the previous marketChanges is held');
  });

  it('a move that was silent, then explained, then silent again gets one row of each kind and nothing more', () => {
    const timeline = [[0, ['silent_divergence']], [5, ['silent_divergence']], [360, ['explained_market_move']], [365, ['explained_market_move']], [375, ['silent_divergence']]];
    const { ledger, activity } = runTicks(timeline, AVGO);
    assert.deepEqual(Object.keys(ledger), [
      `explained_market_move:AVGO@${NOW + 360 * MIN + MARKET_ALERT_WINDOW_MS}`,
      `silent_divergence:AVGO@${NOW + MARKET_ALERT_WINDOW_MS}`,
    ]);
    const [explained, silent] = Object.values(ledger);
    assert.equal(silent.lastSeenAt, NOW + 375 * MIN, 'silent 15 minutes after its window closed is held and bumps its own row');
    assert.equal(explained.lastSeenAt, NOW + 365 * MIN, 'a hold touches only its same-type row');
    assert.deepEqual(activity, {});
  });

  it('explained for an hour, silent for six, then explained again opens one explained row and no silent row', () => {
    const ticks = [...every(0, 60, ['explained_market_move']), ...every(65, 415, ['silent_divergence']), ...every(420, 440, ['explained_market_move'])];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW]]);
    assert.equal(Object.values(ledger)[0].lastSeenAt, NOW + 60 * MIN, 'the last explained tick inside its window; the silent holds touch no row');
    assert.deepEqual(activity, { AVGO: [{ since: NOW + 65 * MIN, until: NOW + 440 * MIN, types: ['explained_market_move', 'silent_divergence'] }] }, 'the silent holds, and the explained ticks held behind them, are one run');
  });

  it('silent every tick for ten hours but one keeps bumping the single silent row', () => {
    const ticks = [...every(0, 395, ['silent_divergence']), [400, []], ...every(405, 600, ['silent_divergence'])];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['silent_divergence', NOW]]);
    assert.equal(Object.values(ledger)[0].lastSeenAt, NOW + 600 * MIN);
    assert.deepEqual(activity, {});
  });

  it('a move whose type alternates every three hours for a day opens at most one row per type', () => {
    const ticks = [];
    for (let hour = 0; hour < 24; hour += 3) {
      const type = (hour / 3) % 2 === 0 ? 'explained_market_move' : 'silent_divergence';
      ticks.push(...every(hour * 60, hour * 60 + 175, [type]));
    }
    const { ledger } = runTicks(ticks, AVGO);
    const counts = {};
    for (const entry of Object.values(ledger)) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    for (const [type, count] of Object.entries(counts)) assert.ok(count <= 1, `${count} ${type} rows`);
    assert.ok(Object.keys(ledger).length <= 2, `${Object.keys(ledger).length} rows in total`);
    assert.deepEqual(counts, { explained_market_move: 1 });
  });

  it('explained resuming after a 20-minute silence opens a second explained row', () => {
    const ticks = [...every(0, 355, ['explained_market_move']), ...every(360, 375, []), [380, ['explained_market_move']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW], ['explained_market_move', NOW + 380 * MIN]]);
  });

  it('explained from a cold start, with no baseline on the first tick, opens no row while it keeps being emitted', () => {
    const [first, ...rest] = every(0, 60, ['explained_market_move']);
    const { ledger, held } = runTicks([[...first, null], ...rest], AVGO);
    assert.deepEqual(rowsOf(ledger), []);
    assert.deepEqual(held, Array(rest.length + 1).fill(1), 'held on every tick, the first for its missing baseline');
  });

  it('explained re-emitted after a seeder gap, with the baseline gone stale, opens no second row', () => {
    const ticks = [...every(0, 500, ['explained_market_move']), [530, ['explained_market_move'], null], ...every(535, 600, ['explained_market_move'])];
    const { ledger, held } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW]]);
    assert.deepEqual(held.slice(-15), Array(15).fill(1), 'every tick from the gap onward is held');
  });

  it('explained opens its row when the only fresh run was started by another quiet type', () => {
    const ticks = [...every(0, 25, ['silent_divergence']), ...every(30, 55, ['silent_divergence', 'flow_price_divergence']), [60, ['explained_market_move']]];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW + 60 * MIN], ['silent_divergence', NOW]]);
    assert.equal(Object.values(ledger)[1].lastSeenAt, NOW + 55 * MIN, 'the silent row is left as it was');
    assert.deepEqual(activity, { AVGO: [{ since: NOW + 30 * MIN, until: NOW + 55 * MIN, types: ['flow_price_divergence'] }] }, 'the flow holds are the run; the new explained row does not extend it');
  });

  it('silent, then explained, then silent past the explained window and the gap, then explained again opens no second explained row', () => {
    const ticks = [[0, ['silent_divergence']], [5, ['explained_market_move']], ...every(10, 380, ['silent_divergence']), [385, ['explained_market_move']], [390, ['explained_market_move']]];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW + 5 * MIN], ['silent_divergence', NOW]]);
    assert.deepEqual(activity, { AVGO: [{ since: NOW + 385 * MIN, until: NOW + 390 * MIN, types: ['explained_market_move'] }] }, 'the silent row absorbed every silent hold, so the explained holds are the only run');
  });

  it('one tick without the alert inside another type\'s window does not let a quiet type open a row', () => {
    const cases = [
      ['explained, a dropout, then silent', [[0, ['explained_market_move']], [5, []], [10, ['silent_divergence']]]],
      ['silent, a dropout, then flow', [[0, ['silent_divergence']], [5, []], [10, ['flow_price_divergence']]]],
      ['flow, a dropout, then silent beside explained', [[0, ['flow_price_divergence']], [5, []], [10, ['silent_divergence', 'explained_market_move']]]],
    ];
    for (const [label, ticks] of cases) {
      const { ledger, activity } = runTicks(ticks, AVGO);
      const first = ticks[0][1][0];
      const rows = rowsOf(ledger).filter(([type]) => type !== 'explained_market_move' || first === 'explained_market_move');
      assert.deepEqual(rows, [[first, NOW]], label);
      assert.deepEqual(activity, { AVGO: [{ since: NOW + 10 * MIN, until: NOW + 10 * MIN, types: [ticks[2][1][0]] }] }, `${label}: the quiet hold is a run`);
    }
  });

  it('explained held with no baseline inside its fresh row bumps the row, so two dropouts after it do not reopen it', () => {
    const ticks = [...every(0, 365, ['explained_market_move']), [370, ['explained_market_move'], null], [375, []], [380, []], [385, ['explained_market_move']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW]]);
    assert.equal(Object.values(ledger)[0].lastSeenAt, NOW + 385 * MIN);
  });

  it('silent held on an unquoted baseline after a feed skip bumps its fresh row, so two dropouts after it do not reopen it', () => {
    const ticks = [...every(0, 365, ['silent_divergence']), [370, []], [375, ['silent_divergence'], 'unquoted'], [380, []], [385, []], [390, ['silent_divergence']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['silent_divergence', NOW]]);
    assert.equal(Object.values(ledger)[0].lastSeenAt, NOW + 390 * MIN);
  });

  it('a cold-start run continues through a hold on an unquoted baseline, so two dropouts after a feed skip open no row', () => {
    const [first, ...rest] = every(0, 45, ['silent_divergence']);
    const ticks = [[...first, null], ...rest, [50, []], [55, ['silent_divergence'], 'unquoted'], [60, []], [65, []], [70, ['silent_divergence']]];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), []);
    assert.deepEqual(activity, { AVGO: [{ since: NOW, until: NOW + 70 * MIN, types: ['silent_divergence'] }] });
  });

  it('explained held through a seeder gap and one dropout after it opens no second row', () => {
    const ticks = [[0, []], ...every(5, 420, ['explained_market_move']), [455, [], null], [460, ['explained_market_move']], [465, ['explained_market_move']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW + 5 * MIN]]);
    assert.equal(Object.values(ledger)[0].lastSeenAt, NOW + 465 * MIN, 'the tick after the gap carried the row to its own time, so the next ones bumped it');
  });

  it('explained held through a seeder gap and one silent flicker after it opens no second row', () => {
    const ticks = [[0, []], ...every(5, 420, ['explained_market_move']), [455, ['silent_divergence'], null], [460, ['explained_market_move']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW + 5 * MIN]]);
  });

  it('a move that stopped twenty minutes before a seeder gap opens a second row after it', () => {
    const ticks = [[0, []], ...every(5, 400, ['explained_market_move']), ...every(405, 420, []), [460, [], null], [465, ['explained_market_move']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW + 5 * MIN], ['explained_market_move', NOW + 465 * MIN]]);
  });

  it('explained, a dropout, then explained fifteen minutes later on a still-live baseline opens no second row', () => {
    const ticks = [...every(0, 365, ['explained_market_move']), [370, []], [385, ['explained_market_move']]];
    const { ledger } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW]]);
    assert.equal(Object.values(ledger)[0].lastSeenAt, NOW + 385 * MIN, 'the skipped ticks observed nothing, so the move was one quiet tick old');
  });

  it('explained held at a cold start, one dropout, then explained again opens no row', () => {
    const { ledger, activity } = runTicks([[0, ['explained_market_move'], null], [5, []], [10, ['explained_market_move']]], AVGO);
    assert.deepEqual(rowsOf(ledger), []);
    assert.deepEqual(activity, { AVGO: [{ since: NOW, until: NOW + 10 * MIN, types: ['explained_market_move'] }] }, 'the cold-start hold is a run that names its type');
  });

  it('silent held on an unquoted baseline, one dropout, then silent again opens no row', () => {
    const { ledger, activity } = runTicks([[0, ['silent_divergence'], 'unquoted'], [5, []], [10, ['silent_divergence']]], AVGO);
    assert.deepEqual(rowsOf(ledger), []);
    assert.deepEqual(activity, { AVGO: [{ since: NOW, until: NOW + 10 * MIN, types: ['silent_divergence'] }] });
  });

  it('explained held at a cold start, then silent for twenty minutes, then explained again opens no explained row', () => {
    const ticks = [[0, ['explained_market_move'], null], ...every(5, 20, ['silent_divergence']), [25, ['explained_market_move']]];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), []);
    assert.deepEqual(activity, { AVGO: [{ since: NOW, until: NOW + 25 * MIN, types: ['explained_market_move', 'silent_divergence'] }] }, 'the run carries every type it held');
  });

  it('an explained row chained to a silent run through a bumped flow row is one stretch, so explained opens no second row', () => {
    const ticks = [
      [0, ['flow_price_divergence']], [5, ['explained_market_move']], ...every(10, 365, []),
      [370, ['explained_market_move']], ...every(375, 385, ['flow_price_divergence']), [390, ['silent_divergence']], [395, []], [400, []], [405, ['explained_market_move']],
    ];
    const { ledger, activity } = runTicks(ticks, AVGO);
    assert.deepEqual(rowsOf(ledger), [['explained_market_move', NOW + 5 * MIN], ['flow_price_divergence', NOW]]);
    assert.deepEqual(activity, { AVGO: [{ since: NOW + 390 * MIN, until: NOW + 405 * MIN, types: ['explained_market_move', 'silent_divergence'] }] });
  });

  it('silent on one tick then explained on the next opens the explained row', () => {
    const silentTick = ingest({}, [marketSignal('silent_divergence', CRUDE), marketSignal('flow_price_divergence', CRUDE)], NOW, { marketChanges: { 'CL=F': 3.0 }, emitted: [] });
    assert.deepEqual(silentTick.emitted, ['flow_price_divergence:CL=F', 'silent_divergence:CL=F']);
    const explainedTick = ingest(silentTick.ledger, [marketSignal('explained_market_move', CRUDE)], NOW + 5 * 60 * 1000, { marketChanges: { 'CL=F': 3.1 }, emitted: silentTick.emitted });
    assert.deepEqual({ created: explainedTick.created, held: explainedTick.held }, { created: 1, held: 0 });
    assert.deepEqual(Object.values(explainedTick.ledger).map((entry) => entry.type).sort(), ['explained_market_move', 'flow_price_divergence', 'silent_divergence']);
    assert.deepEqual(explainedTick.emitted, ['explained_market_move:CL=F']);
  });

  it('a signal under the confidence gate on one tick is new on the next', () => {
    const gatedTick = ingest({}, [marketSignal('silent_divergence', CRUDE, { confidence: 0.59 })], NOW, { marketChanges: { 'CL=F': 3.0 }, emitted: [] });
    assert.deepEqual({ gated: gatedTick.gated, emitted: gatedTick.emitted }, { gated: 1, emitted: [] });
    const passingTick = ingest(gatedTick.ledger, [marketSignal('silent_divergence', CRUDE)], NOW + 5 * 60 * 1000, { marketChanges: { 'CL=F': 3.1 }, emitted: gatedTick.emitted });
    assert.deepEqual({ created: passingTick.created, held: passingTick.held }, { created: 1, held: 0 });
  });

  it('reports the sorted market ids that passed the type and confidence gate, never predictions', () => {
    const signals = [
      marketSignal('silent_divergence', WHEAT),
      marketSignal('flow_price_divergence', CRUDE),
      marketSignal('silent_divergence', CRUDE, { confidence: 0.59 }),
      marketSignal('flow_drop', CRUDE),
      predictionSignal(RATE_CUT, -10),
    ];
    const { emitted } = ingest({}, signals, NOW, null);
    assert.deepEqual(emitted, ['flow_price_divergence:CL=F', 'silent_divergence:ZW=F']);
  });

  it('no baseline holds every market signal', () => {
    const signals = [marketSignal('silent_divergence', CRUDE), marketSignal('flow_price_divergence', CRUDE), marketSignal('silent_divergence', WHEAT)];
    const { ledger, created, held } = ingest({}, signals, NOW, null);
    assert.deepEqual(ledger, {});
    assert.equal(created, 0);
    assert.equal(held, 3);
  });

  it('re-emission inside an open window still counts a sample when the alert was emitted on the previous tick', () => {
    const first = ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger;
    const { ledger, created, updated, held } = ingest(first, [marketSignal('silent_divergence', CRUDE)], NOW + 5 * 60 * 1000, { marketChanges: { 'CL=F': 3.1 }, emitted: ['silent_divergence:CL=F'] });
    assert.deepEqual({ created, updated, held }, { created: 0, updated: 1, held: 0 });
    const entries = Object.values(ledger);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].samples, 1);
  });

  it('a closed window does not reopen while the alert keeps re-emitting; the hold bumps only its lastSeenAt', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const closed = (await resolveDueEntries(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, { nowMs: dueAt + 1, archive: archiveOf([], {}) })).ledger;
    const [row] = Object.values(closed);
    const { ledger, created, held, touched, activity } = ingest(closed, [marketSignal('silent_divergence', CRUDE)], dueAt + 2, { marketChanges: { 'CL=F': 3.0 }, emitted: ['silent_divergence:CL=F'], activity: {} });
    assert.deepEqual({ created, held, touched, activity }, { created: 0, held: 1, touched: 1, activity: {} });
    assert.deepEqual(Object.values(ledger), [{ ...row, lastSeenAt: dueAt + 2 }]);
  });

  it('a hold for a missing baseline or an unquoted symbol bumps a fresh same-type row, extends a fresh run, and otherwise starts one', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const closed = (await resolveDueEntries(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, { nowMs: dueAt + 1, archive: archiveOf([], {}) })).ledger;
    const [row] = Object.values(closed);
    const unquoted = { marketChanges: { 'ZW=F': 3.0 }, emitted: [], activity: {} };
    for (const baseline of [null, unquoted]) {
      const fresh = ingest(closed, [marketSignal('silent_divergence', CRUDE)], dueAt + 2, baseline);
      assert.deepEqual({ held: fresh.held, touched: fresh.touched, activity: fresh.activity }, { held: 1, touched: 1, activity: {} });
      assert.deepEqual(Object.values(fresh.ledger), [{ ...row, lastSeenAt: dueAt + 2 }], 'the fresh closed row is bumped');

      const stale = ingest(closed, [marketSignal('silent_divergence', CRUDE)], dueAt + 20 * MIN, baseline);
      assert.deepEqual({ held: stale.held, touched: stale.touched, activity: stale.activity }, { held: 1, touched: 1, activity: { 'CL=F': [heldRun(dueAt + 20 * MIN, dueAt + 20 * MIN)] } });
      assert.deepEqual(stale.ledger, closed, 'a stale row is left alone; the hold starts a run');

      const run = heldRun(dueAt + 20 * MIN, dueAt + 30 * MIN);
      const continued = ingestSignals(closed, [marketSignal('silent_divergence', CRUDE)], { nowMs: dueAt + 40 * MIN, runtimeMode: 'legacy', markets: [CRUDE], predictions: [], baseline, activity: { 'CL=F': [run] } });
      assert.deepEqual({ held: continued.held, touched: continued.touched, activity: continued.activity }, { held: 1, touched: 1, activity: { 'CL=F': [heldRun(run.since, dueAt + 40 * MIN)] } });
      assert.deepEqual(continued.ledger, closed);
    }
  });

  it('a quoted hold with no row of its type starts a run of activity, named for the type, and counts as touched', () => {
    const explained = ingest({}, [marketSignal('explained_market_move', CRUDE)]).ledger;
    const { ledger, held, touched, activity } = ingest(explained, [marketSignal('silent_divergence', CRUDE)], NOW + 5 * MIN, { marketChanges: { 'CL=F': 3.0 }, emitted: ['explained_market_move:CL=F'], activity: {} });
    assert.deepEqual({ ledger, held, touched, activity }, { ledger: explained, held: 1, touched: 1, activity: { 'CL=F': [heldRun(NOW + 5 * MIN, NOW + 5 * MIN)] } });
  });

  it('a divergence hold whose same-type row went stale records activity and leaves the row alone', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const closed = (await resolveDueEntries(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, { nowMs: dueAt + 1, archive: archiveOf([], {}) })).ledger;
    const bumped = ingest(closed, [marketSignal('silent_divergence', CRUDE)], dueAt + 2, alertedAt(dueAt + 2)).ledger;
    assert.equal(Object.values(bumped)[0].lastSeenAt, dueAt + 2);
    const later = dueAt + 2 + 20 * MIN;
    const explainedRun = heldRun(later - 5 * MIN, later - 5 * MIN, ['explained_market_move']);
    const { ledger, held, touched, activity } = ingest(bumped, [marketSignal('silent_divergence', CRUDE)], later, { ...alertedAt(later), emitted: ['explained_market_move:CL=F'], activity: { 'CL=F': [explainedRun] } });
    assert.deepEqual({ held, touched, activity }, { held: 1, touched: 1, activity: { 'CL=F': [heldRun(explainedRun.since, later, ['explained_market_move', 'silent_divergence'])] } });
    assert.deepEqual(ledger, bumped, 'a stale row is not stretched');
  });

  it('a later hold extends the run inside the continuity window and starts a new one past it', () => {
    assert.equal(MARKET_ALERT_ACTIVITY_GAP_MS, 15 * MIN);
    const explained = ingest({}, [marketSignal('explained_market_move', CRUDE)]).ledger;
    const run = heldRun(NOW, NOW);
    const cases = [
      [5 * MIN, [heldRun(NOW, NOW + 5 * MIN)]],
      [MARKET_ALERT_ACTIVITY_GAP_MS, [heldRun(NOW, NOW + MARKET_ALERT_ACTIVITY_GAP_MS)]],
      [20 * MIN, [run, heldRun(NOW + 20 * MIN, NOW + 20 * MIN)]],
    ];
    for (const [gap, runs] of cases) {
      const { held, activity } = ingest(explained, [marketSignal('silent_divergence', CRUDE)], NOW + gap, { ...alertedAt(NOW + gap), activity: { 'CL=F': [run] } });
      assert.deepEqual({ held, activity }, { held: 1, activity: { 'CL=F': runs } }, `${gap / MIN} minutes after the last hold, inside the explained window`);
    }
  });

  it('a ninth run drops the oldest', () => {
    assert.equal(MARKET_ALERT_ACTIVITY_MAX_RUNS, 8);
    const explained = ingest({}, [marketSignal('explained_market_move', CRUDE)]).ledger;
    const runs = Array.from({ length: MARKET_ALERT_ACTIVITY_MAX_RUNS }, (_, i) => heldRun(NOW - (9 - i) * HOUR, NOW - (9 - i) * HOUR + 10 * MIN));
    const { activity } = ingest(explained, [marketSignal('silent_divergence', CRUDE)], NOW, { ...alertedAt(NOW), activity: { 'CL=F': runs } });
    assert.deepEqual(activity, { 'CL=F': [...runs.slice(1), heldRun(NOW, NOW)] });
  });

  it('carries forward runs inside the retention window, drops older ones, and drops a symbol left with none', () => {
    assert.equal(MARKET_ALERT_ACTIVITY_RETENTION_MS, 30 * HOUR + 6 * 24 * HOUR, 'control offset + window + the six days a due row may wait for evidence');
    const kept = { since: NOW - MARKET_ALERT_ACTIVITY_RETENTION_MS - HOUR, until: NOW - MARKET_ALERT_ACTIVITY_RETENTION_MS };
    const dropped = { since: NOW - MARKET_ALERT_ACTIVITY_RETENTION_MS - HOUR, until: NOW - MARKET_ALERT_ACTIVITY_RETENTION_MS - 1 };
    const { activity } = ingest({}, [], NOW, { ...QUIET_BASELINE, activity: { 'CL=F': [dropped, kept], 'ZW=F': [dropped] } });
    assert.deepEqual(activity, { 'CL=F': [kept] });
  });

  it('drops signals under the dashboard confidence gate and unknown types', () => {
    const low = marketSignal('silent_divergence', CRUDE, { confidence: 0.59 });
    const foreign = marketSignal('flow_drop', CRUDE);
    const { ledger, gated } = ingest({}, [low, foreign]);
    assert.deepEqual(ledger, {});
    assert.equal(gated, 2);
  });

  it('truncates the description to 200 characters', () => {
    const long = marketSignal('silent_divergence', CRUDE, { description: 'x'.repeat(500) });
    const [entry] = Object.values(ingest({}, [long]).ledger);
    assert.equal(entry.description.length, 200);
  });
});

describe('storyMatchesEntity', () => {
  const crude = entityForMarket(CRUDE);
  it('matches an alias of the registry entity', () => {
    assert.equal(storyMatchesEntity('Oil prices jump as OPEC cuts output', crude), true);
  });
  it('ignores a keyword-only registry hit', () => {
    assert.equal(storyMatchesEntity('OPEC ministers meet in Vienna', crude), false);
  });
  it('matches the market name as a whole word when it has four or more characters', () => {
    const wheat = entityForMarket(WHEAT);
    assert.equal(storyMatchesEntity('Wheat futures climb after export ban', wheat), true);
    assert.equal(storyMatchesEntity('Buckwheat harvest sets record', wheat), false);
    assert.equal(storyMatchesEntity('Gas prices rise', entityForMarket({ symbol: 'ZZ=F', name: 'Gas' })), false);
  });
  it('matches a prediction through a topic keyword its question names', () => {
    const entity = entityForPrediction(RATE_CUT);
    assert.equal(storyMatchesEntity('Fed signals a December pause', entity), true);
    assert.equal(storyMatchesEntity('Federer retires from tennis', entity), false);
    assert.equal(storyMatchesEntity('Inflation cools for a third month', entity), false);
  });
});

describe('entityForPrediction', () => {
  it('derives only keywords present in the question', () => {
    assert.deepEqual(entityForPrediction(RATE_CUT).relatedTopics, ['fed']);
    assert.deepEqual(entityForPrediction({ title: 'Will Iran strike Israel by June?' }).relatedTopics, ['iran', 'israel']);
    assert.deepEqual(entityForPrediction({ title: 'Will Bitcoin exceed $100k?' }).relatedTopics, ['bitcoin']);
  });
});

describe('resolveDueEntries', () => {
  const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
  function pendingLedger() {
    return ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger;
  }

  it('leaves an entry pending before its deadline', async () => {
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt - 1, archive: archiveOf([], {}) });
    assert.equal(result.hit + result.miss + result.void, 0);
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
  });

  it('resolves HIT on a Tier-2 story about the entity first tracked inside the window', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 2 * HOUR };
    const result = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 1,
      archive: archiveOf([story], { h1: { tier: 2, source: 'BBC' } }),
    });
    assert.equal(result.hit, 1);
    const [entry] = Object.values(result.ledger);
    assert.equal(entry.status, 'resolved');
    assert.equal(entry.outcome, 'HIT');
    assert.equal(entry.resolvedAt, dueAt + 1);
    assert.deepEqual(entry.evidence, {
      storyHash: 'h1',
      title: story.title,
      source: 'BBC',
      tier: 2,
      firstSeen: story.firstSeen,
      leadTimeMs: 2 * HOUR,
    });
  });

  it('takes the earliest qualifying story as evidence', async () => {
    const later = { hash: 'late', title: 'Crude oil extends gains', firstSeen: NOW + 3 * HOUR };
    const earlier = { hash: 'early', title: 'Oil climbs on OPEC cut', firstSeen: NOW + 1 * HOUR };
    const result = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 1,
      archive: archiveOf([later, earlier], { late: { tier: 1, source: 'Reuters' }, early: { tier: 2, source: 'BBC' } }),
    });
    assert.equal(Object.values(result.ledger)[0].evidence.storyHash, 'early');
  });

  it('does not count a Tier-3-only story', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 2 * HOUR };
    const result = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 1,
      archive: archiveOf([story], { h1: { tier: 3, source: 'OilPrice.com' } }),
    });
    assert.equal(result.miss, 1);
    const [entry] = Object.values(result.ledger);
    assert.equal(entry.outcome, 'MISS');
    assert.deepEqual(entry.evidence, { reason: 'no_matching_story', candidates: 1 });
  });

  it('does not count a story first tracked before the emission', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW - 1 };
    const result = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 1,
      archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }),
    });
    assert.equal(result.miss, 1);
    assert.deepEqual(Object.values(result.ledger)[0].evidence, { reason: 'no_matching_story', candidates: 0 });
  });

  it('does not count a story first tracked after the deadline', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: dueAt + 1 };
    const result = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 2,
      archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }),
    });
    assert.equal(result.miss, 1);
  });

  it('resolves MISS when the window closes with no matching story', async () => {
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([], {}) });
    assert.equal(result.miss, 1);
  });

  it('leaves every due entry pending and unproven when the story read fails', async () => {
    const archive = { readStories: async () => null, readSourceTiers: async () => new Map() };
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
    assert.deepEqual(
      { read: result.read, readAt: result.readAt, readFailed: result.readFailed, truncated: result.truncated, coveredFromMs: result.coveredFromMs, unproven: result.unproven },
      { read: true, readAt: dueAt + 1, readFailed: true, truncated: false, coveredFromMs: null, unproven: 1 },
    );
    assert.equal(result.hit + result.miss + result.void, 0);
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
  });

  it('leaves every due entry pending and unproven when the source read fails', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + HOUR };
    const archive = { readStories: async () => ({ coveredFromMs: NOW - HOUR, truncated: false, stories: [story] }), readSourceTiers: async () => null };
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
    assert.deepEqual({ read: result.read, readFailed: result.readFailed, unproven: result.unproven }, { read: true, readFailed: true, unproven: 1 });
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
  });

  it('reports the archive coverage and truncation of the pass, and whether it read at all', async () => {
    const nothingDue = await resolveDueEntries(pendingLedger(), { nowMs: dueAt - 1, archive: archiveOf([], {}, NOW - 2 * HOUR, true) });
    assert.deepEqual(
      { read: nothingDue.read, readAt: nothingDue.readAt, truncated: nothingDue.truncated, coveredFromMs: nothingDue.coveredFromMs },
      { read: false, readAt: null, truncated: false, coveredFromMs: null },
    );
    const truncated = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([], {}, NOW - 2 * HOUR, true) });
    assert.deepEqual(
      { read: truncated.read, readAt: truncated.readAt, miss: truncated.miss, truncated: truncated.truncated, coveredFromMs: truncated.coveredFromMs },
      { read: true, readAt: dueAt + 1, miss: 1, truncated: true, coveredFromMs: NOW - 2 * HOUR },
    );
  });

  it('leaves an entry pending when the archive cannot prove coverage of its window', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 2 * HOUR };
    const result = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 1,
      archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }, NOW + 1),
    });
    assert.equal(result.readFailed, false);
    assert.deepEqual({ hit: result.hit, miss: result.miss, void: result.void, unproven: result.unproven }, { hit: 0, miss: 0, void: 0, unproven: 1 });
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
    assert.equal(result.pending, 1);
  });

  it('an empty archive proves nothing', async () => {
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([], {}, null) });
    assert.equal(result.readFailed, false);
    assert.equal(result.miss, 0);
    assert.equal(result.unproven, 1);
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
  });

  it('scores a window the archive covers', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 2 * HOUR };
    const hit = await resolveDueEntries(pendingLedger(), {
      nowMs: dueAt + 1,
      archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }, NOW),
    });
    assert.equal(hit.hit, 1);
    assert.equal(hit.unproven, 0);
    assert.equal(Object.values(hit.ledger)[0].outcome, 'HIT');
    const miss = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([], {}, NOW - 1) });
    assert.equal(miss.miss, 1);
    assert.equal(miss.unproven, 0);
    assert.equal(Object.values(miss.ledger)[0].outcome, 'MISS');
  });

  it('scores only the due entries whose windows the archive covers', async () => {
    const ledger = ingest(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, [marketSignal('silent_divergence', WHEAT)], NOW + HOUR).ledger;
    const result = await resolveDueEntries(ledger, { nowMs: dueAt + HOUR + 1, archive: archiveOf([], {}, NOW + 30 * 60 * 1000) });
    assert.deepEqual({ miss: result.miss, unproven: result.unproven, pending: result.pending }, { miss: 1, unproven: 1, pending: 1 });
    const byId = Object.fromEntries(Object.values(result.ledger).map((entry) => [entry.id, entry.status]));
    assert.deepEqual(byId, { 'silent_divergence:CL=F': 'pending', 'silent_divergence:ZW=F': 'resolved' });
  });

  it('asks the archive for stories since 24 hours before the oldest due emission', async () => {
    const calls = [];
    const archive = {
      readStories: async (sinceMs) => { calls.push(sinceMs); return { coveredFromMs: NOW - HOUR, truncated: false, stories: [] }; },
      readSourceTiers: async () => new Map(),
    };
    const ledger = ingest(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, [marketSignal('silent_divergence', WHEAT)], NOW + HOUR).ledger;
    await resolveDueEntries(ledger, { nowMs: dueAt + HOUR + 1, archive });
    assert.deepEqual(calls, [NOW - 24 * HOUR]);
  });

  it('resolves VOID once the evidence window has expired, without reading the archive or scoring a control', async () => {
    let reads = 0;
    const archive = { readStories: async () => { reads += 1; return { coveredFromMs: NOW - HOUR, truncated: false, stories: [] }; }, readSourceTiers: async () => new Map() };
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + MARKET_ALERT_EVIDENCE_EXPIRY_MS + 1, archive });
    assert.equal(result.void, 1);
    assert.equal(reads, 0);
    const [entry] = Object.values(result.ledger);
    assert.equal(entry.outcome, 'VOID');
    assert.deepEqual(entry.evidence, { reason: 'evidence_expired' });
    assert.equal(entry.control, undefined);
  });

  describe('base-rate control', () => {
    const CONTROL = { start: NOW - 24 * HOUR, end: NOW - 18 * HOUR };
    const COVERED = NOW - 25 * HOUR;
    const controlStory = { hash: 'c1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW - 23 * HOUR };
    const liveStory = { hash: 'h1', title: 'Crude oil extends gains', firstSeen: NOW + 2 * HOUR };

    it('scores the control window by its own stories while the live window scores by its own', async () => {
      const tierReads = [];
      const archive = archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED);
      const readSourceTiers = archive.readSourceTiers;
      archive.readSourceTiers = async (hashes) => { tierReads.push([...hashes].sort()); return readSourceTiers(hashes); };
      const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
      const [entry] = Object.values(result.ledger);
      assert.equal(entry.outcome, 'MISS');
      assert.deepEqual(entry.control, { ...CONTROL, outcome: 'HIT', storyHash: 'c1' });
      assert.deepEqual(tierReads, [['c1']]);
    });

    it('reads the live and control candidates in one source-tier batch', async () => {
      const tierReads = [];
      const archive = archiveOf([liveStory, controlStory], { h1: { tier: 2, source: 'BBC' }, c1: { tier: 1, source: 'Reuters' } }, COVERED);
      const readSourceTiers = archive.readSourceTiers;
      archive.readSourceTiers = async (hashes) => { tierReads.push([...hashes].sort()); return readSourceTiers(hashes); };
      const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
      const [entry] = Object.values(result.ledger);
      assert.equal(entry.outcome, 'HIT');
      assert.equal(entry.control.outcome, 'HIT');
      assert.deepEqual(tierReads, [['c1', 'h1']]);
    });

    it('scores control MISS when the control window has no qualifying story', async () => {
      const tier3 = { hash: 'c3', title: 'Oil slips as OPEC meets', firstSeen: NOW - 20 * HOUR };
      const unrelated = { hash: 'u1', title: 'Parliament debates the budget', firstSeen: NOW - 22 * HOUR };
      const archive = archiveOf([liveStory, tier3, unrelated], { h1: { tier: 1, source: 'Reuters' }, c3: { tier: 3, source: 'OilPrice.com' }, u1: { tier: 1, source: 'Reuters' } }, COVERED);
      const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
      const [entry] = Object.values(result.ledger);
      assert.equal(entry.outcome, 'HIT');
      assert.deepEqual(entry.control, { ...CONTROL, outcome: 'MISS' });
    });

    it('skips the control when the archive does not cover its start', async () => {
      const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, CONTROL.start + 1) });
      const [entry] = Object.values(result.ledger);
      assert.equal(entry.outcome, 'MISS');
      assert.deepEqual(entry.control, { ...CONTROL, outcome: 'skipped', reason: 'uncovered' });
    });

    it('skips the control when an alert for the same entity was open during it', async () => {
      const earlier = ingest({}, [marketSignal('silent_divergence', CRUDE)], NOW - 23 * HOUR).ledger;
      const ledger = ingest(earlier, [marketSignal('silent_divergence', CRUDE)], NOW).ledger;
      const result = await resolveDueEntries(ledger, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED) });
      const byEmission = Object.fromEntries(Object.values(result.ledger).map((entry) => [entry.emittedAt, entry]));
      assert.deepEqual(byEmission[NOW].control, { ...CONTROL, outcome: 'skipped', reason: 'overlap' });
      assert.deepEqual(byEmission[NOW - 23 * HOUR].control, { start: NOW - 47 * HOUR, end: NOW - 41 * HOUR, outcome: 'skipped', reason: 'weekend' }, 'the Monday emission\'s control falls on Sunday');
    });

    it('a resolved row for another entity does not count as overlap', async () => {
      const wheat = ingest({}, [marketSignal('silent_divergence', WHEAT)], NOW - 23 * HOUR).ledger;
      const ledger = ingest(wheat, [marketSignal('silent_divergence', CRUDE)], NOW).ledger;
      const result = await resolveDueEntries(ledger, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED) });
      const crude = Object.values(result.ledger).find((entry) => entry.id === 'silent_divergence:CL=F');
      assert.equal(crude.control.outcome, 'HIT');
    });

    it('skips the control when an alert of another type for the same entity was open during it, pending or resolved', async () => {
      const pendingFlow = ingest({}, [marketSignal('flow_price_divergence', CRUDE)], NOW - 23 * HOUR).ledger;
      const resolvedFlow = (await resolveDueEntries(pendingFlow, { nowMs: NOW - 17 * HOUR + 1, archive: archiveOf([], {}, NOW - 48 * HOUR) })).ledger;
      assert.equal(Object.values(resolvedFlow)[0].status, 'resolved');
      for (const earlier of [pendingFlow, resolvedFlow]) {
        const ledger = ingest(earlier, [marketSignal('silent_divergence', CRUDE)], NOW).ledger;
        const result = await resolveDueEntries(ledger, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED) });
        const crude = Object.values(result.ledger).find((entry) => entry.id === 'silent_divergence:CL=F');
        assert.deepEqual(crude.control, { ...CONTROL, outcome: 'skipped', reason: 'overlap' });
      }
    });

    it('skips the control when a closed alert for the entity was still re-emitting during it', async () => {
      const earlierAt = CONTROL.start - MARKET_ALERT_WINDOW_MS - 10 * MIN;
      const earlier = ingest({}, [marketSignal('silent_divergence', CRUDE)], earlierAt).ledger;
      const closedAt = earlierAt + MARKET_ALERT_WINDOW_MS + 1;
      let ledger = (await resolveDueEntries(earlier, { nowMs: closedAt, archive: archiveOf([], {}, earlierAt - HOUR) })).ledger;
      assert.ok(Object.values(ledger)[0].deadline < CONTROL.start, 'the closed window ends before the control starts');
      for (const heldAt of [closedAt + 5 * MIN, CONTROL.start]) {
        ledger = ingest(ledger, [marketSignal('silent_divergence', CRUDE)], heldAt, { marketChanges: { 'CL=F': 3.0 }, emitted: ['silent_divergence:CL=F'] }).ledger;
      }
      assert.equal(Object.values(ledger)[0].lastSeenAt, CONTROL.start, 'each hold inside the gap bumps the closed row');
      ledger = ingest(ledger, [marketSignal('silent_divergence', CRUDE)], NOW).ledger;
      const result = await resolveDueEntries(ledger, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED) });
      const crude = Object.values(result.ledger).find((entry) => entry.emittedAt === NOW);
      assert.deepEqual(crude.control, { ...CONTROL, outcome: 'skipped', reason: 'overlap' });
    });

    it('skips the control when a run of held activity with no row for the entity overlaps it', async () => {
      const activity = { 'CL=F': [{ since: NOW - 26 * HOUR, until: NOW - 23 * HOUR }] };
      const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED), activity });
      assert.deepEqual(Object.values(result.ledger)[0].control, { ...CONTROL, outcome: 'skipped', reason: 'overlap' });
    });

    it('skips the control when the first of two runs overlaps it', async () => {
      const activity = { 'CL=F': [{ since: NOW - 26 * HOUR, until: NOW - 23 * HOUR }, { since: NOW - 10 * HOUR, until: NOW - 9 * HOUR }] };
      const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED), activity });
      assert.deepEqual(Object.values(result.ledger)[0].control, { ...CONTROL, outcome: 'skipped', reason: 'overlap' });
    });

    it('a run that ended before the control window, started after it, or belongs to another entity does not skip it', async () => {
      for (const activity of [
        { 'CL=F': [{ since: NOW - 30 * HOUR, until: CONTROL.start - 1 }] },
        { 'CL=F': [{ since: CONTROL.end + 1, until: NOW - 1 }] },
        { 'ZW=F': [{ since: NOW - 26 * HOUR, until: NOW - 23 * HOUR }] },
      ]) {
        const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED), activity });
        assert.deepEqual(Object.values(result.ledger)[0].control, { ...CONTROL, outcome: 'HIT', storyHash: 'c1' }, JSON.stringify(activity));
      }
    });

    it('an alert of another type for another entity does not count as overlap', async () => {
      const wheat = ingest({}, [marketSignal('flow_price_divergence', WHEAT)], NOW - 23 * HOUR).ledger;
      const ledger = ingest(wheat, [marketSignal('silent_divergence', CRUDE)], NOW).ledger;
      const result = await resolveDueEntries(ledger, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED) });
      const crude = Object.values(result.ledger).find((entry) => entry.id === 'silent_divergence:CL=F');
      assert.equal(crude.control.outcome, 'HIT');
    });

    it('skips the control as weekend when the emission and its control start fall on different sides of a weekend in UTC', async () => {
      const controlFor = async (emittedAt) => {
        const story = { hash: 'c1', title: controlStory.title, firstSeen: emittedAt - 23 * HOUR };
        const ledger = ingest({}, [marketSignal('silent_divergence', CRUDE)], emittedAt).ledger;
        const result = await resolveDueEntries(ledger, { nowMs: emittedAt + MARKET_ALERT_WINDOW_MS + 1, archive: archiveOf([story], { c1: { tier: 1, source: 'Reuters' } }, emittedAt - 25 * HOUR) });
        return Object.values(result.ledger)[0].control;
      };
      const monday = Date.UTC(2026, 9, 5, 14);
      assert.deepEqual(await controlFor(monday), { start: monday - 24 * HOUR, end: monday - 18 * HOUR, outcome: 'skipped', reason: 'weekend' });
      const sunday = Date.UTC(2026, 9, 4, 14);
      assert.equal((await controlFor(sunday)).outcome, 'HIT', 'a Sunday emission and its Saturday control are both weekend');
      const wednesday = Date.UTC(2026, 9, 7, 14);
      assert.equal((await controlFor(wednesday)).outcome, 'HIT');
    });

    it('skips the control as expired once its start is older than the evidence expiry, even with coverage claimed', async () => {
      const archive = () => archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED);
      const stale = await resolveDueEntries(pendingLedger(), { nowMs: CONTROL.start + MARKET_ALERT_EVIDENCE_EXPIRY_MS + 60 * 1000, archive: archive() });
      assert.deepEqual(Object.values(stale.ledger)[0].control, { ...CONTROL, outcome: 'skipped', reason: 'expired' });
      const fresh = await resolveDueEntries(pendingLedger(), { nowMs: CONTROL.start + 5 * 24 * HOUR, archive: archive() });
      assert.deepEqual(Object.values(fresh.ledger)[0].control, { ...CONTROL, outcome: 'HIT', storyHash: 'c1' });
    });
  });

  it('does not touch an already resolved entry', async () => {
    const resolved = (await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([], {}) })).ledger;
    const again = await resolveDueEntries(resolved, { nowMs: dueAt + 2, archive: archiveOf([], {}) });
    assert.equal(again.miss, 0);
    assert.equal(Object.values(again.ledger)[0].resolvedAt, dueAt + 1);
  });
});

describe('pruneLedger', () => {
  it('drops resolved entries older than the retention window and keeps pending ones', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const resolved = (await resolveDueEntries(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, { nowMs: dueAt + 1, archive: archiveOf([], {}) })).ledger;
    const withPending = ingest(resolved, [marketSignal('silent_divergence', WHEAT)], dueAt + 2).ledger;
    const pruned = pruneLedger(withPending, dueAt + 1 + MARKET_ALERT_LEDGER_RETENTION_MS + 1);
    assert.deepEqual(Object.values(pruned).map((entry) => entry.id), ['silent_divergence:ZW=F']);
  });
});

describe('buildScorecard', () => {
  it('lists every alert type in order with null rates when nothing is measurable', () => {
    const card = buildScorecard({}, NOW, { archive: NO_ARCHIVE_PASS });
    assert.equal(card.schemaVersion, 1);
    assert.equal(card.generatedAt, NOW);
    assert.equal(card.windowHours, 6);
    assert.equal(card.rollingWindowDays, 30);
    assert.equal(card.methodology, `${MARKET_ALERT_RESOLUTION_RULE} ${MARKET_ALERT_BASE_RATE_RULE}`);
    assert.deepEqual(card.totals, { entries: 0, pending: 0, resolved: 0, hit: 0, miss: 0, void: 0 });
    assert.deepEqual(card.archive, NO_ARCHIVE_PASS);
    assert.deepEqual(card.byType.map((row) => row.type), [...MARKET_ALERT_TYPES]);
    for (const row of card.byType) {
      assert.deepEqual(row, { type: row.type, pending: 0, resolved: 0, hit: 0, miss: 0, void: 0, n: 0, hitRate: null, pairedHitRate: null, baseN: 0, baseHitRate: null, medianLeadTimeMs: null });
    }
  });

  it('pre-registers the base-rate rule next to the resolution rule', () => {
    assert.equal(
      MARKET_ALERT_BASE_RATE_RULE,
      'The base rate applies the same rule to a control window of the same length for the same entity that starts 24 hours before each scored emission, counted only when the archive covers the control window, no alert for that entity was open during it, and the emission and the control fall on the same side of a weekend in UTC.',
    );
  });

  it('docs/signal-intelligence.mdx quotes both rules verbatim', () => {
    const lines = readFileSync(new URL('../docs/signal-intelligence.mdx', import.meta.url), 'utf8').split('\n');
    const quote = lines.find((line) => line.startsWith('> An emission resolves HIT'));
    assert.equal(quote, `> ${MARKET_ALERT_RESOLUTION_RULE} ${MARKET_ALERT_BASE_RATE_RULE}`);
  });

  it('reports the paired hit rate over the rows whose control scored, beside the base rate', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const two = ingest(ingest({}, [marketSignal('silent_divergence', WHEAT)], NOW - 2 * HOUR).ledger, [marketSignal('silent_divergence', CRUDE)]).ledger;
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 2 * HOUR };
    const { ledger } = await resolveDueEntries(two, { nowMs: dueAt + 1, archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }, NOW - 25 * HOUR) });
    assert.deepEqual(Object.values(ledger).map((entry) => [entry.outcome, entry.control.outcome]), [['HIT', 'MISS'], ['MISS', 'skipped']]);
    const row = buildScorecard(ledger, dueAt + 2, { archive: NO_ARCHIVE_PASS }).byType.find((r) => r.type === 'silent_divergence');
    assert.deepEqual(
      { n: row.n, hitRate: row.hitRate, pairedHitRate: row.pairedHitRate, baseN: row.baseN, baseHitRate: row.baseHitRate },
      { n: 2, hitRate: 0.5, pairedHitRate: 1, baseN: 1, baseHitRate: 0 },
    );
    assert.equal('pairedN' in row, false, 'baseN already counts the paired rows');
  });

  it('computes baseHitRate over the controls that scored HIT or MISS', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const two = ingest(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, [marketSignal('silent_divergence', WHEAT)]).ledger;
    const controlStory = { hash: 'c1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW - 23 * HOUR };
    const { ledger } = await resolveDueEntries(two, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, NOW - 25 * HOUR) });
    const row = buildScorecard(ledger, dueAt + 2, { archive: NO_ARCHIVE_PASS }).byType.find((r) => r.type === 'silent_divergence');
    assert.deepEqual({ n: row.n, hitRate: row.hitRate, baseN: row.baseN, baseHitRate: row.baseHitRate }, { n: 2, hitRate: 0, baseN: 2, baseHitRate: 0.5 });
  });

  it('carries the resolution pass archive status and nothing else from it', () => {
    const archive = { readFailed: true, truncated: true, unproven: 3, coveredFromMs: NOW - HOUR, readAt: NOW - 5 * MIN };
    assert.deepEqual(buildScorecard({}, NOW, { archive: { ...archive, read: true, hit: 2 } }).archive, archive);
  });

  it('computes hitRate = hit / (hit + miss) and the median lead time over HITs', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const two = ingest(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, [marketSignal('silent_divergence', WHEAT)]).ledger;
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 90 * 60 * 1000 };
    const { ledger } = await resolveDueEntries(two, { nowMs: dueAt + 1, archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }) });
    const card = buildScorecard(ledger, dueAt + 2, { archive: NO_ARCHIVE_PASS });
    assert.deepEqual(card.totals, { entries: 2, pending: 0, resolved: 2, hit: 1, miss: 1, void: 0 });
    const row = card.byType.find((r) => r.type === 'silent_divergence');
    assert.deepEqual(row, { type: 'silent_divergence', pending: 0, resolved: 2, hit: 1, miss: 1, void: 0, n: 2, hitRate: 0.5, pairedHitRate: null, baseN: 0, baseHitRate: null, medianLeadTimeMs: 90 * 60 * 1000 });
  });

  it('excludes a VOID from n and counts resolutions only inside the rolling window', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const { ledger } = await resolveDueEntries(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, { nowMs: dueAt + MARKET_ALERT_EVIDENCE_EXPIRY_MS + 1, archive: archiveOf([], {}) });
    const fresh = buildScorecard(ledger, dueAt + MARKET_ALERT_EVIDENCE_EXPIRY_MS + 2, { archive: NO_ARCHIVE_PASS });
    assert.equal(fresh.totals.void, 1);
    assert.equal(fresh.byType[2].n, 0);
    const old = buildScorecard(ledger, dueAt + MARKET_ALERT_EVIDENCE_EXPIRY_MS + 1 + 31 * 24 * HOUR, { archive: NO_ARCHIVE_PASS });
    assert.equal(old.totals.void, 0);
    assert.equal(old.totals.entries, 1);
  });
});
