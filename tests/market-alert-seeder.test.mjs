import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ACCUMULATOR_KEY,
  DIGEST_KEY,
  MARKET_ALERT_WINDOW_MS,
  MAX_ARCHIVE_HASHES,
  READ_KEYS,
  SNAPSHOT_KEY,
  MARKET_ALERT_LEDGER_KEY,
  buildTick,
  createRedisArchive,
  formatSummary,
  readRawInputs,
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
const LIVE_SNAPSHOT = { timestamp: NOW - 5 * MIN, predictionChanges: { [FED_CUT_KEY]: 40 }, marketChanges: { 'CL=F': 0.4 } };
const OBSERVED_PREDICTIONS = { [FED_CUT_KEY]: 30, [`\u0000title:${FED_CUT.title}`]: 30 };
const OBSERVED_MARKETS = { '^GSPC': 0.2, 'CL=F': 3.1, BTC: 0.5 };

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
    [SNAPSHOT_KEY]: envelope(LIVE_SNAPSHOT),
    ...overrides,
  };
}

const EMPTY_ARCHIVE = { readStories: async () => ({ coveredFromMs: NOW - 24 * HOUR, stories: [] }), readSourceTiers: async () => new Map() };

function byType(ledger, type) {
  return Object.values(ledger).filter((entry) => entry.type === type);
}

function pendingCrude(emittedAt) {
  const key = `silent_divergence:CL=F@${emittedAt + MARKET_ALERT_WINDOW_MS}`;
  return {
    [key]: {
      id: 'silent_divergence:CL=F', key, type: 'silent_divergence',
      entity: { kind: 'market', symbol: 'CL=F', name: 'Crude Oil', entityId: 'CL=F' },
      emittedAt, deadline: emittedAt + MARKET_ALERT_WINDOW_MS, observedChange: 2.5, newsVelocity: 0, confidence: 0.65,
      runtimeMode: 'legacy', description: 'Crude Oil moved +2.50%', lastSeenAt: emittedAt, samples: 0, status: 'pending',
    },
  };
}

function fakePipeline(rowFor) {
  const sent = [];
  const pipeline = async (commands) => {
    sent.push(commands);
    return commands.map((command) => rowFor(command));
  };
  pipeline.sent = sent;
  return pipeline;
}

const ARCHIVE_SINCE = NOW - 7 * HOUR;
const OIL_STORY = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW - 5 * HOUR };

function archiveRows(overrides = {}) {
  const rows = {
    ZRANGE: () => ({ result: ['h0', String(NOW - 8 * HOUR)] }),
    ZRANGEBYSCORE: () => ({ result: [OIL_STORY.hash] }),
    HGETALL: () => ({ result: ['title', OIL_STORY.title, 'firstSeen', String(OIL_STORY.firstSeen)] }),
    SMEMBERS: () => ({ result: ['OilPrice.com', 'Reuters'] }),
    ...overrides,
  };
  return (command) => rows[command[0]]?.(command) ?? { result: null };
}

async function captureWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
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
    assert.deepEqual(tick.snapshot, { timestamp: NOW, predictionChanges: OBSERVED_PREDICTIONS, marketChanges: OBSERVED_MARKETS });
  });

  it('a snapshot older than 15 minutes is a stale baseline', async () => {
    const stale = envelope({ ...LIVE_SNAPSHOT, timestamp: NOW - 16 * MIN });
    const tick = await buildTick(rawInputs({ [SNAPSHOT_KEY]: stale }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.deepEqual(tick.ledger, {});
    assert.deepEqual(tick.summary.emitted, { total: 2, byType: { silent_divergence: 1, flow_price_divergence: 1 }, gated: 0, held: 2 });
    assert.deepEqual(tick.snapshot, { timestamp: NOW, predictionChanges: OBSERVED_PREDICTIONS, marketChanges: OBSERVED_MARKETS });
  });

  it('a 5-minute-old snapshot is a live baseline', async () => {
    const tick = await buildTick(rawInputs(), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.deepEqual(
      Object.values(tick.ledger).map((entry) => entry.id).sort(),
      ['flow_price_divergence:CL=F', `prediction_leads_news:${FED_CUT_KEY}`, 'silent_divergence:CL=F'],
    );
    assert.equal(tick.summary.emitted.held, 0);
  });

  it('a first tick without a digest records the observed prices as the baseline', async () => {
    const tick = await buildTick(rawInputs({ [DIGEST_KEY]: null, [SNAPSHOT_KEY]: null }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.deepEqual(tick.ledger, {});
    assert.deepEqual(tick.snapshot, { timestamp: NOW, predictionChanges: OBSERVED_PREDICTIONS, marketChanges: OBSERVED_MARKETS });
  });

  it('discards a market payload whose fetchedAt is 45 minutes old', async () => {
    const stale = envelope({ quotes: [{ symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 80, change: 3.1 }] }, NOW - 45 * MIN);
    const tick = await buildTick(rawInputs({ [COMMODITIES_KEY]: stale }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(byType(tick.ledger, 'silent_divergence').length, 0);
    assert.equal(byType(tick.ledger, 'flow_price_divergence').length, 0);
    assert.deepEqual(tick.summary.discarded, [{ key: COMMODITIES_KEY, reason: 'stale' }]);
  });

  it('skips the prediction detector and writes an empty prediction baseline when predictions are stale', async () => {
    const stale = envelope({ geopolitical: [], tech: [], finance: [FED_CUT] }, NOW - 100 * MIN);
    const tick = await buildTick(rawInputs({ [PREDICTIONS_KEY]: stale }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(byType(tick.ledger, 'prediction_leads_news').length, 0);
    assert.deepEqual(tick.snapshot, { timestamp: NOW, predictionChanges: {}, marketChanges: OBSERVED_MARKETS });
  });

  it('market rows still open during a prediction outage', async () => {
    const stalePredictions = envelope({ geopolitical: [], tech: [], finance: [FED_CUT] }, NOW - 100 * MIN);
    const quietCrude = envelope({ quotes: [{ symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 78, change: 0.4 }] });
    const outageTick = await buildTick(
      rawInputs({ [PREDICTIONS_KEY]: stalePredictions, [COMMODITIES_KEY]: quietCrude }),
      { nowMs: NOW, archive: EMPTY_ARCHIVE },
    );
    assert.deepEqual(outageTick.ledger, {});
    const tick = await buildTick(
      rawInputs({ [PREDICTIONS_KEY]: stalePredictions, [SNAPSHOT_KEY]: envelope(outageTick.snapshot) }),
      { nowMs: NOW + 15 * MIN, archive: EMPTY_ARCHIVE },
    );
    assert.deepEqual(Object.values(tick.ledger).map((entry) => entry.id).sort(), ['flow_price_divergence:CL=F', 'silent_divergence:CL=F']);
    assert.equal(tick.summary.emitted.held, 0);
  });

  it('the first fresh prediction poll after an outage opens no shift row', async () => {
    const afterOutage = envelope({ ...LIVE_SNAPSHOT, predictionChanges: {} });
    const tick = await buildTick(rawInputs({ [SNAPSHOT_KEY]: afterOutage }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(byType(tick.ledger, 'prediction_leads_news').length, 0);
    assert.equal(tick.snapshot.predictionChanges[FED_CUT_KEY], 30);
  });

  it('skips emission without a fresh digest but still resolves a due entry', async () => {
    const emittedAt = NOW - MARKET_ALERT_WINDOW_MS - 10 * MIN;
    const pending = pendingCrude(emittedAt);
    const [key] = Object.keys(pending);
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: emittedAt + HOUR };
    const archive = {
      readStories: async () => ({ coveredFromMs: emittedAt - HOUR, stories: [story] }),
      readSourceTiers: async (hashes) => new Map(hashes.map((hash) => [hash, { tier: 1, source: 'Reuters' }])),
    };
    const tick = await buildTick(rawInputs({ [DIGEST_KEY]: null, [MARKET_ALERT_LEDGER_KEY]: envelope(pending) }), { nowMs: NOW, archive });
    assert.deepEqual(Object.keys(tick.ledger), [key]);
    assert.equal(tick.ledger[key].outcome, 'HIT');
    assert.equal(tick.ledger[key].evidence.leadTimeMs, HOUR);
    assert.equal(tick.summary.emitted.total, 0);
    assert.deepEqual(tick.snapshot, LIVE_SNAPSHOT);
    assert.equal(tick.scorecard.totals.hit, 1);
  });

  it('keeps a due entry pending and reports it unproven when the archive starts after its window opened', async () => {
    const emittedAt = NOW - MARKET_ALERT_WINDOW_MS - 10 * MIN;
    const pending = pendingCrude(emittedAt);
    const [key] = Object.keys(pending);
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: emittedAt + HOUR };
    const archive = {
      readStories: async () => ({ coveredFromMs: emittedAt + 1, stories: [story] }),
      readSourceTiers: async (hashes) => new Map(hashes.map((hash) => [hash, { tier: 1, source: 'Reuters' }])),
    };
    const tick = await buildTick(rawInputs({ [DIGEST_KEY]: null, [MARKET_ALERT_LEDGER_KEY]: envelope(pending) }), { nowMs: NOW, archive });
    assert.equal(tick.ledger[key].status, 'pending');
    assert.deepEqual(tick.summary.resolved, { hit: 0, miss: 0, void: 0, unproven: 1 });
    assert.equal(tick.summary.readFailed, false);
    assert.match(formatSummary(tick.summary), / void=0 unproven=1 \| /);
  });

  it('refuses a malformed ledger instead of starting an empty one', async () => {
    for (const value of [envelope([]), 'not-json', envelope('text')]) {
      await assert.rejects(
        buildTick(rawInputs({ [MARKET_ALERT_LEDGER_KEY]: value }), { nowMs: NOW, archive: EMPTY_ARCHIVE }),
        { message: `${MARKET_ALERT_LEDGER_KEY} holds a malformed ledger; refusing to overwrite it` },
      );
    }
  });

  it('starts an empty ledger only when the key is missing', async () => {
    const tick = await buildTick(rawInputs({ [MARKET_ALERT_LEDGER_KEY]: null }), { nowMs: NOW, archive: EMPTY_ARCHIVE });
    assert.equal(tick.summary.created, 3);
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
    assert.deepEqual(tick.summary.emitted, { total: 3, byType: { prediction_leads_news: 1, silent_divergence: 1, flow_price_divergence: 1 }, gated: 0, held: 0 });
    assert.deepEqual(tick.summary.resolved, { hit: 0, miss: 0, void: 0, unproven: 0 });
    assert.equal(tick.summary.pending, 3);
    assert.match(formatSummary(tick.summary), / gated=0 held=0 new=3 re-emitted=0 \| resolved hit=0 miss=0 void=0 unproven=0 \| pending=3 /);
  });
});

describe('readRawInputs', () => {
  it('throws naming the key when a GET row carries a command-level error', async () => {
    const pipeline = fakePipeline(([, key]) => (key === MARKET_ALERT_LEDGER_KEY ? { error: 'ERR max requests limit exceeded' } : { result: null }));
    await assert.rejects(readRawInputs(pipeline), { message: `Redis GET ${MARKET_ALERT_LEDGER_KEY} failed: ERR max requests limit exceeded` });
  });

  it('parses JSON strings and maps a missing key to null', async () => {
    const pipeline = fakePipeline(([, key]) => (key === STOCKS_KEY ? { result: JSON.stringify(envelope({ quotes: [] })) } : { result: null }));
    const raw = await readRawInputs(pipeline);
    assert.deepEqual(pipeline.sent, [READ_KEYS.map((key) => ['GET', key])]);
    assert.deepEqual(raw[STOCKS_KEY], envelope({ quotes: [] }));
    assert.equal(raw[MARKET_ALERT_LEDGER_KEY], null);
  });
});

describe('createRedisArchive', () => {
  it('reads the oldest score and the window members in one pipeline', async () => {
    const pipeline = fakePipeline(archiveRows());
    const result = await createRedisArchive(pipeline).readStories(ARCHIVE_SINCE);
    assert.deepEqual(pipeline.sent[0], [
      ['ZRANGE', ACCUMULATOR_KEY, '0', '0', 'WITHSCORES'],
      ['ZRANGEBYSCORE', ACCUMULATOR_KEY, String(ARCHIVE_SINCE), '+inf', 'LIMIT', '0', String(MAX_ARCHIVE_HASHES + 1)],
    ]);
    assert.deepEqual(result, { coveredFromMs: NOW - 8 * HOUR, stories: [OIL_STORY] });
  });

  it('reports an empty accumulator as covering nothing', async () => {
    const pipeline = fakePipeline(archiveRows({ ZRANGE: () => ({ result: [] }), ZRANGEBYSCORE: () => ({ result: [] }) }));
    assert.deepEqual(await createRedisArchive(pipeline).readStories(ARCHIVE_SINCE), { coveredFromMs: null, stories: [] });
  });

  it('skips an expired story:track row', async () => {
    const pipeline = fakePipeline(archiveRows({ HGETALL: () => ({ result: [] }) }));
    assert.deepEqual(await createRedisArchive(pipeline).readStories(ARCHIVE_SINCE), { coveredFromMs: NOW - 8 * HOUR, stories: [] });
  });

  it('returns null on a ZRANGE row error', async () => {
    const pipeline = fakePipeline(archiveRows({ ZRANGE: () => ({ error: 'ERR' }) }));
    const { value } = await captureWarnings(() => createRedisArchive(pipeline).readStories(ARCHIVE_SINCE));
    assert.equal(value, null);
  });

  it('returns null on an HGETALL row error', async () => {
    const pipeline = fakePipeline(archiveRows({ HGETALL: () => ({ error: 'ERR' }) }));
    const { value } = await captureWarnings(() => createRedisArchive(pipeline).readStories(ARCHIVE_SINCE));
    assert.equal(value, null);
  });

  it('returns null and leaves the due entries pending when the window overflows', async () => {
    const members = Array.from({ length: MAX_ARCHIVE_HASHES + 1 }, (_, i) => `h${i}`);
    const pipeline = fakePipeline(archiveRows({ ZRANGEBYSCORE: () => ({ result: members }) }));
    const { value, warnings } = await captureWarnings(() => createRedisArchive(pipeline).readStories(ARCHIVE_SINCE));
    assert.equal(value, null);
    assert.equal(pipeline.sent.length, 1);
    assert.match(warnings.join('\n'), /due entries stay pending/);
  });

  it('reads the best source tier per hash', async () => {
    const pipeline = fakePipeline(archiveRows());
    const tiers = await createRedisArchive(pipeline).readSourceTiers(['h1']);
    assert.deepEqual(pipeline.sent, [[['SMEMBERS', 'story:sources:v1:h1']]]);
    assert.deepEqual([...tiers], [['h1', { tier: 1, source: 'Reuters' }]]);
  });

  it('returns null on a SMEMBERS row error or a non-array result', async () => {
    for (const row of [{ error: 'ERR' }, { result: null }]) {
      const pipeline = fakePipeline(archiveRows({ SMEMBERS: () => row }));
      const { value } = await captureWarnings(() => createRedisArchive(pipeline).readSourceTiers(['h1']));
      assert.equal(value, null);
    }
  });
});

describe('derived-signals bundle section', () => {
  it('names the ledger and completion keys as literals that match the module constants', async () => {
    const { readFileSync } = await import('node:fs');
    const { MARKET_ALERT_COMPLETION_META_KEY } = await import('../scripts/_market-alert-ledger.mjs');
    const line = readFileSync(new URL('../scripts/seed-bundle-derived-signals.mjs', import.meta.url), 'utf8')
      .split('\n')
      .find((text) => text.includes("label: 'Market-Alert-Ledger'"));
    assert.ok(line, 'the derived-signals bundle must keep a Market-Alert-Ledger section');
    assert.match(line, new RegExp(`canonicalKey: '${MARKET_ALERT_LEDGER_KEY}'`));
    assert.match(line, new RegExp(`completionMetaKey: '${MARKET_ALERT_COMPLETION_META_KEY}'`));
    assert.doesNotMatch(line, /MARKET_ALERT_[A-Z_]+,/, 'tests/cross-strait-activity-shipping evaluates this array with only MIN, HOUR and CHINA_DECISION_SIGNALS_KEY in scope');
  });
});
