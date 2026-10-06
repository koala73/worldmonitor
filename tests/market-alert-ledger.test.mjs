import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
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
const HOUR = 60 * 60 * 1000;

const CRUDE = { symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 80, change: 3.1 };
const WHEAT = { symbol: 'ZW=F', name: 'Wheat', display: 'Wheat', price: 600, change: 2.4 };
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

const QUIET_BASELINE = { marketChanges: { 'CL=F': 1.0, 'ZW=F': 1.0 }, emitted: [] };

function ingest(ledger, signals, nowMs = NOW, baseline = QUIET_BASELINE) {
  return ingestSignals(ledger, signals, { nowMs, runtimeMode: 'legacy', markets: [CRUDE, WHEAT], predictions: [RATE_CUT], baseline });
}

function archiveOf(stories, tiers, coveredFromMs = NOW - HOUR, truncated = false) {
  return {
    readStories: async () => ({ coveredFromMs, truncated, stories }),
    readSourceTiers: async (hashes) => new Map(hashes.map((hash) => [hash, tiers[hash] ?? { tier: 4, source: 'unknown' }])),
  };
}

const NO_ARCHIVE_PASS = { readFailed: false, truncated: false, unproven: 0, coveredFromMs: null };

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

  it('opens a new window once the previous deadline has passed', () => {
    const first = ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger;
    const later = NOW + MARKET_ALERT_WINDOW_MS + 1;
    const { ledger, created } = ingest(first, [marketSignal('silent_divergence', CRUDE)], later);
    assert.equal(created, 1);
    assert.equal(Object.keys(ledger).length, 2);
  });

  it('a market signal opens a row only when it was not emitted on the previous tick', () => {
    const crude = [marketSignal('silent_divergence', CRUDE), marketSignal('flow_price_divergence', CRUDE)];
    const fresh = ingest({}, crude, NOW, { marketChanges: { 'CL=F': 3.0 }, emitted: [] });
    assert.deepEqual({ created: fresh.created, held: fresh.held }, { created: 2, held: 0 });

    const partlyEmitted = ingest({}, crude, NOW, { marketChanges: { 'CL=F': 3.0 }, emitted: ['silent_divergence:CL=F'] });
    assert.deepEqual(Object.values(partlyEmitted.ledger).map((entry) => entry.type), ['flow_price_divergence']);
    assert.deepEqual({ created: partlyEmitted.created, held: partlyEmitted.held }, { created: 1, held: 1 });

    const unseen = ingest({}, crude, NOW, { marketChanges: { 'ZW=F': 3.0 }, emitted: [] });
    assert.deepEqual({ ledger: unseen.ledger, created: unseen.created, held: unseen.held }, { ledger: {}, created: 0, held: 2 }, 'a symbol absent from the previous marketChanges is held');
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

  it('a closed window does not reopen while the alert keeps re-emitting', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const closed = (await resolveDueEntries(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, { nowMs: dueAt + 1, archive: archiveOf([], {}) })).ledger;
    const { ledger, created, held } = ingest(closed, [marketSignal('silent_divergence', CRUDE)], dueAt + 2, { marketChanges: { 'CL=F': 3.0 }, emitted: ['silent_divergence:CL=F'] });
    assert.deepEqual({ created, held }, { created: 0, held: 1 });
    assert.deepEqual(Object.values(ledger).map((entry) => entry.status), ['resolved']);
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

  it('leaves every due entry pending when the story read fails', async () => {
    const archive = { readStories: async () => null, readSourceTiers: async () => new Map() };
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
    assert.deepEqual({ readFailed: result.readFailed, truncated: result.truncated, coveredFromMs: result.coveredFromMs }, { readFailed: true, truncated: false, coveredFromMs: null });
    assert.equal(result.hit + result.miss + result.void, 0);
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
  });

  it('leaves every due entry pending when the source read fails', async () => {
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + HOUR };
    const archive = { readStories: async () => ({ coveredFromMs: NOW - HOUR, truncated: false, stories: [story] }), readSourceTiers: async () => null };
    const result = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive });
    assert.equal(result.readFailed, true);
    assert.equal(Object.values(result.ledger)[0].status, 'pending');
  });

  it('reports the archive coverage and truncation of the pass', async () => {
    const nothingDue = await resolveDueEntries(pendingLedger(), { nowMs: dueAt - 1, archive: archiveOf([], {}, NOW - 2 * HOUR, true) });
    assert.deepEqual({ truncated: nothingDue.truncated, coveredFromMs: nothingDue.coveredFromMs }, { truncated: false, coveredFromMs: null });
    const truncated = await resolveDueEntries(pendingLedger(), { nowMs: dueAt + 1, archive: archiveOf([], {}, NOW - 2 * HOUR, true) });
    assert.deepEqual({ miss: truncated.miss, truncated: truncated.truncated, coveredFromMs: truncated.coveredFromMs }, { miss: 1, truncated: true, coveredFromMs: NOW - 2 * HOUR });
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
      assert.deepEqual(byEmission[NOW - 23 * HOUR].control, { start: NOW - 47 * HOUR, end: NOW - 41 * HOUR, outcome: 'skipped', reason: 'uncovered' });
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

    it('an alert of another type for another entity does not count as overlap', async () => {
      const wheat = ingest({}, [marketSignal('flow_price_divergence', WHEAT)], NOW - 23 * HOUR).ledger;
      const ledger = ingest(wheat, [marketSignal('silent_divergence', CRUDE)], NOW).ledger;
      const result = await resolveDueEntries(ledger, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, COVERED) });
      const crude = Object.values(result.ledger).find((entry) => entry.id === 'silent_divergence:CL=F');
      assert.equal(crude.control.outcome, 'HIT');
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
      assert.deepEqual(row, { type: row.type, pending: 0, resolved: 0, hit: 0, miss: 0, void: 0, n: 0, hitRate: null, baseN: 0, baseHitRate: null, medianLeadTimeMs: null });
    }
  });

  it('pre-registers the base-rate rule next to the resolution rule', () => {
    assert.equal(
      MARKET_ALERT_BASE_RATE_RULE,
      'The base rate applies the same rule to a control window of the same length for the same entity that starts 24 hours before each scored emission, counted only when the archive covers the control window and no alert for that entity was open during it.',
    );
  });

  it('computes baseHitRate over the controls that scored HIT or MISS', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const two = ingest(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, [marketSignal('silent_divergence', WHEAT)]).ledger;
    const controlStory = { hash: 'c1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW - 23 * HOUR };
    const { ledger } = await resolveDueEntries(two, { nowMs: dueAt + 1, archive: archiveOf([controlStory], { c1: { tier: 1, source: 'Reuters' } }, NOW - 25 * HOUR) });
    const row = buildScorecard(ledger, dueAt + 2, { archive: NO_ARCHIVE_PASS }).byType.find((r) => r.type === 'silent_divergence');
    assert.deepEqual({ n: row.n, hitRate: row.hitRate, baseN: row.baseN, baseHitRate: row.baseHitRate }, { n: 2, hitRate: 0, baseN: 2, baseHitRate: 0.5 });
  });

  it('carries the resolution pass archive status', () => {
    const archive = { readFailed: true, truncated: true, unproven: 3, coveredFromMs: NOW - HOUR };
    assert.deepEqual(buildScorecard({}, NOW, { archive }).archive, archive);
  });

  it('computes hitRate = hit / (hit + miss) and the median lead time over HITs', async () => {
    const dueAt = NOW + MARKET_ALERT_WINDOW_MS;
    const two = ingest(ingest({}, [marketSignal('silent_divergence', CRUDE)]).ledger, [marketSignal('silent_divergence', WHEAT)]).ledger;
    const story = { hash: 'h1', title: 'Oil prices jump as OPEC cuts output', firstSeen: NOW + 90 * 60 * 1000 };
    const { ledger } = await resolveDueEntries(two, { nowMs: dueAt + 1, archive: archiveOf([story], { h1: { tier: 1, source: 'Reuters' } }) });
    const card = buildScorecard(ledger, dueAt + 2, { archive: NO_ARCHIVE_PASS });
    assert.deepEqual(card.totals, { entries: 2, pending: 0, resolved: 2, hit: 1, miss: 1, void: 0 });
    const row = card.byType.find((r) => r.type === 'silent_divergence');
    assert.deepEqual(row, { type: 'silent_divergence', pending: 0, resolved: 2, hit: 1, miss: 1, void: 0, n: 2, hitRate: 0.5, baseN: 0, baseHitRate: null, medianLeadTimeMs: 90 * 60 * 1000 });
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
