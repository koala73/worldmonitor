import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DIGEST_KEY,
  MARKET_ALERT_WINDOW_MS,
  SNAPSHOT_KEY,
  MARKET_ALERT_LEDGER_KEY,
  buildTick,
} from '../scripts/seed-market-alert-ledger.mjs';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const STOCKS_KEY = 'market:stocks-bootstrap:v1';
const COMMODITIES_KEY = 'market:commodities-bootstrap:v1';
const CRYPTO_KEY = 'market:crypto:v1';
const PREDICTIONS_KEY = 'prediction:markets-bootstrap:v1';
const RUNTIME_MODE_KEY = 'correlation:runtime-mode:v1';

const FED_CUT = { title: 'Will the Fed cut rates in December?', yesPrice: 30, volume: 1000, url: 'https://polymarket.com/event/fed-cut', source: 'polymarket' };
const FED_CUT_KEY = `${FED_CUT.url}|${FED_CUT.title}`;

function envelope(data, fetchedAt = NOW - 2 * MIN) {
  return { _seed: { fetchedAt, recordCount: 1, sourceVersion: 'fixture', schemaVersion: 1, state: 'OK' }, data };
}

function digestOf(items, generatedAt = NOW - 5 * MIN) {
  return envelope({
    generatedAt: new Date(generatedAt).toISOString(),
    categories: { markets: { items } },
  });
}

const QUIET_NEWS = [
  { title: 'Parliament debates the autumn budget timetable', source: 'BBC', link: 'https://example.test/budget', published_at: new Date(NOW - 40 * MIN).toISOString(), isAlert: false },
  { title: 'City council approves new tram line', source: 'The Guardian', link: 'https://example.test/tram', published_at: new Date(NOW - 50 * MIN).toISOString(), isAlert: false },
];

function rawInputs(overrides = {}) {
  return {
    [STOCKS_KEY]: envelope({ quotes: [{ symbol: '^GSPC', name: 'S&P 500', display: 'SPX', price: 5000, change: 0.2 }] }),
    [COMMODITIES_KEY]: envelope({ quotes: [{ symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 80, change: 3.1 }] }),
    [CRYPTO_KEY]: envelope({ quotes: [{ name: 'Bitcoin', symbol: 'BTC', price: 60000, change: 0.5 }] }),
    [PREDICTIONS_KEY]: envelope({ geopolitical: [], tech: [], finance: [FED_CUT] }),
    [DIGEST_KEY]: digestOf(QUIET_NEWS),
    [RUNTIME_MODE_KEY]: { mode: 'exact' },
    [MARKET_ALERT_LEDGER_KEY]: envelope({}),
    [SNAPSHOT_KEY]: envelope({ timestamp: NOW - 5 * MIN, predictionChanges: { [FED_CUT_KEY]: 40 } }),
    ...overrides,
  };
}

const EMPTY_ARCHIVE = { readStories: async () => [], readSourceTiers: async () => new Map() };

function byType(ledger, type) {
  return Object.values(ledger).filter((entry) => entry.type === type);
}

describe('buildTick runs the shared detectors under Node', () => {
  it('emits silent_divergence and flow_price_divergence for a +3.1% crude move with no oil news', async () => {
    const tick = await buildTick(rawInputs(), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    const silent = byType(tick.ledger, 'silent_divergence');
    const flow = byType(tick.ledger, 'flow_price_divergence');
    assert.equal(silent.length, 1);
    assert.equal(flow.length, 1);
    for (const entry of [...silent, ...flow]) {
      assert.deepEqual(entry.entity, { kind: 'market', symbol: 'CL=F', name: 'Crude Oil', entityId: 'CL=F' });
      assert.equal(entry.observedChange, 3.1);
      assert.equal(entry.emittedAt, NOW);
      assert.equal(entry.deadline, NOW + MARKET_ALERT_WINDOW_MS);
      assert.equal(entry.runtimeMode, 'exact');
    }
    assert.equal(byType(tick.ledger, 'explained_market_move').length, 0);
  });

  it('emits explained_market_move instead when a Tier-1 oil story is in the digest', async () => {
    const oilNews = [
      { title: 'Oil prices jump as OPEC cuts output', source: 'Reuters', link: 'https://example.test/opec', published_at: new Date(NOW - 30 * MIN).toISOString(), isAlert: false },
      ...QUIET_NEWS,
    ];
    const tick = await buildTick(rawInputs({ [DIGEST_KEY]: digestOf(oilNews) }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(byType(tick.ledger, 'silent_divergence').length, 0);
    const [explained] = byType(tick.ledger, 'explained_market_move');
    assert.ok(explained, 'expected an explained_market_move row');
    assert.equal(explained.entity.symbol, 'CL=F');
    assert.equal(explained.newsVelocity, 1);
  });

  it('emits prediction_leads_news for a 40 -> 30 move against the carried snapshot', async () => {
    const tick = await buildTick(rawInputs(), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    const [entry] = byType(tick.ledger, 'prediction_leads_news');
    assert.ok(entry, 'expected a prediction_leads_news row');
    assert.equal(entry.observedChange, -10);
    assert.equal(entry.entity.kind, 'prediction');
    assert.equal(entry.entity.title, FED_CUT.title);
    assert.equal(entry.entity.url, FED_CUT.url);
    assert.ok(entry.entity.relatedTopics.includes('fed'));
    assert.deepEqual(tick.snapshot, { timestamp: NOW, predictionChanges: { [FED_CUT_KEY]: 30, [`\u0000title:${FED_CUT.title}`]: 30 } });
  });

  it('discards a market payload whose fetchedAt is 45 minutes old', async () => {
    const stale = envelope({ quotes: [{ symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 80, change: 3.1 }] }, NOW - 45 * MIN);
    const tick = await buildTick(rawInputs({ [COMMODITIES_KEY]: stale }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(byType(tick.ledger, 'silent_divergence').length, 0);
    assert.equal(byType(tick.ledger, 'flow_price_divergence').length, 0);
    assert.deepEqual(tick.summary.discarded, [{ key: COMMODITIES_KEY, reason: 'stale' }]);
  });

  it('skips the prediction detector and carries the snapshot forward when predictions are stale', async () => {
    const stale = envelope({ geopolitical: [], tech: [], finance: [FED_CUT] }, NOW - 91 * MIN);
    const tick = await buildTick(rawInputs({ [PREDICTIONS_KEY]: stale }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(byType(tick.ledger, 'prediction_leads_news').length, 0);
    assert.equal(byType(tick.ledger, 'silent_divergence').length, 1);
    assert.deepEqual(tick.snapshot, { timestamp: NOW - 5 * MIN, predictionChanges: { [FED_CUT_KEY]: 40 } });
  });

  it('skips emission without a fresh digest but still resolves a due entry', async () => {
    const emittedAt = NOW - MARKET_ALERT_WINDOW_MS - 10 * MIN;
    const key = `silent_divergence:CL=F@${emittedAt + MARKET_ALERT_WINDOW_MS}`;
    const pending = {
      [key]: {
        id: 'silent_divergence:CL=F', key, type: 'silent_divergence',
        entity: { kind: 'market', symbol: 'CL=F', name: 'Crude Oil', entityId: 'CL=F' },
        emittedAt, deadline: emittedAt + MARKET_ALERT_WINDOW_MS, observedChange: 2.5, newsVelocity: 0, confidence: 0.65,
        runtimeMode: 'legacy', description: 'Crude Oil moved +2.50%', firstSeenAt: emittedAt, lastSeenAt: emittedAt, samples: 0, status: 'pending',
      },
    };
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: emittedAt + HOUR };
    const archive = {
      readStories: async () => [story],
      readSourceTiers: async (hashes) => new Map(hashes.map((hash) => [hash, { tier: 1, source: 'Reuters' }])),
    };
    const tick = await buildTick(rawInputs({ [DIGEST_KEY]: null, [MARKET_ALERT_LEDGER_KEY]: envelope(pending) }), { nowMs: NOW, archive });
    assert.deepEqual(Object.keys(tick.ledger), [key]);
    assert.equal(tick.ledger[key].outcome, 'HIT');
    assert.equal(tick.ledger[key].evidence.leadTimeMs, HOUR);
    assert.equal(tick.summary.emitted.total, 0);
    assert.deepEqual(tick.snapshot, { timestamp: NOW - 5 * MIN, predictionChanges: { [FED_CUT_KEY]: 40 } });
    assert.equal(tick.scorecard.totals.hit, 1);
  });

  it('treats a digest older than an hour as absent', async () => {
    const tick = await buildTick(rawInputs({ [DIGEST_KEY]: digestOf(QUIET_NEWS, NOW - 61 * MIN) }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.deepEqual(tick.ledger, {});
    assert.deepEqual(tick.summary.discarded, [{ key: DIGEST_KEY, reason: 'stale' }]);
  });

  it('records the legacy runtime mode when the control key is missing or malformed', async () => {
    for (const value of [null, 'nonsense', { mode: 'turbo' }]) {
      const tick = await buildTick(rawInputs({ [RUNTIME_MODE_KEY]: value }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
      for (const entry of Object.values(tick.ledger)) assert.equal(entry.runtimeMode, 'legacy');
    }
  });

  it('summarizes the tick for the log line', async () => {
    const tick = await buildTick(rawInputs(), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.deepEqual(tick.summary.inputs, { stocks: 1, commodities: 1, crypto: 1, predictions: 1, digestItems: 2, runtimeMode: 'exact' });
    assert.equal(tick.summary.emitted.total, 3);
    assert.deepEqual(tick.summary.resolved, { hit: 0, miss: 0, void: 0 });
    assert.equal(tick.summary.pending, 3);
  });
});
