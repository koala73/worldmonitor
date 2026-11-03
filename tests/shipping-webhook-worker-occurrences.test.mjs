import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { fakeRedis } from './_lib/fake-webhook-redis.mjs';
import {
  BACKFILL_CURSOR_KEY,
  CHOKEPOINT_STATUS_KEY,
  FANOUT_LIST_KEY,
  LOCK_KEY,
  OCCURRENCE_CAP_FIELD,
  OCCURRENCE_RULES,
  WORKER_META_KEY,
  keywordMatches,
  matchOccurrence,
  nextCapState,
  normalizeTeeMessage,
  occurrenceStateField,
  parseStateHash,
  planTick,
  runTick,
  seenKey,
  stateKey,
} from '../scripts/shipping-webhook-worker.mjs';

const require = createRequire(import.meta.url);
const { marketEventId, rssEventId } = require('../scripts/lib/occurrence-events.cjs');
const registry = JSON.parse(readFileSync(new URL('../shared/event-triggers.json', import.meta.url), 'utf8'));

// The occurrence pipeline: the relay tees rss_alert / market_alert queue
// messages onto wm:events:api:v1, the worker drains them, matches each against
// every subscriber's stored scope and delivers once per (subscriber, eventId).
// Threshold events (chokepoint, risk surge) keep tests/shipping-webhook-worker.test.mjs.

const NOW = Date.parse('2026-10-17T18:45:16.000Z');
const HOUR = 3_600_000;
const NEWS_DEFAULTS = { keywords: [], categories: [], countries: [], importanceFloor: 69, severityFloor: 'high' };
const MARKET_DEFAULTS = { assetClasses: [], symbols: [], minAbsPct: 10, direction: 'any' };

function record(overrides = {}) {
  return {
    subscriberId: 'wh_aaaaaaaaaaaaaaaaaaaaaaaa',
    ownerTag: 'owner',
    callbackUrl: 'https://hooks.example.com/wm',
    chokepointIds: ['suez'],
    alertThreshold: 50,
    createdAt: '2026-10-01T00:00:00.000Z',
    active: true,
    secret: 'a'.repeat(64),
    ...overrides,
  };
}
const newsRecord = (scope = {}, overrides = {}) => record({ eventType: 'news.breaking', scope: { ...NEWS_DEFAULTS, ...scope }, ...overrides });
const marketRecord = (scope = {}, overrides = {}) => record({ subscriberId: 'wh_bbbbbbbbbbbbbbbbbbbbbbbb', eventType: 'market.move', scope: { ...MARKET_DEFAULTS, ...scope }, ...overrides });

/** A queue message the way publishNotificationEvent writes it (eventId stamped). */
function rssMessage({ title, link = 'https://www.rferl.org/a/iran-tankers/33560001.html', severity = 'critical', importanceScore = 88, category = 'conflict', countryCodes = ['IR'], variant = 'full', publishedAt = NOW - 10 * 60_000, source = 'RFE/RL', corroborationCount = 3, withId = true } = {}) {
  const payload = { title, source, link, publishedAt, importanceScore, corroborationCount, category, countryCodes };
  if (withId) payload.eventId = rssEventId(link, title);
  return JSON.stringify({ eventType: 'rss_alert', payload, severity, variant, publishedAt: publishedAt + 60_000 });
}

function marketMessage({ assetClass = 'equity', symbol = 'VIX', name = 'CBOE Volatility Index', price = 28.41, changePct = 21.3, severity = 'critical', publishedAt = NOW, source = 'Equity Market', withId = true } = {}) {
  const dir = changePct < 0 ? 'decline' : 'surge';
  const coalesceKey = `market:${assetClass}:${symbol.toLowerCase()}:${dir}:${severity}`;
  const payload = { title: `${symbol}: ${changePct > 0 ? '+' : ''}${Math.round(changePct)}% ${dir}`, source, coalesceKey, assetClass, symbol, name, price, changePct, direction: changePct < 0 ? 'down' : 'up' };
  if (withId) payload.eventId = marketEventId(coalesceKey, publishedAt);
  return JSON.stringify({ eventType: 'market_alert', payload, severity, publishedAt });
}

const occ = (raw) => normalizeTeeMessage(raw, NOW);

describe('normalizeTeeMessage', () => {
  it('turns an rss_alert queue message into a news.breaking occurrence with the documented fields', () => {
    const result = occ(rssMessage({ title: 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz' }));
    assert.equal(result.event, 'news.breaking');
    assert.equal(result.eventId, rssEventId('https://www.rferl.org/a/iran-tankers/33560001.html', ''));
    assert.deepEqual(result.payload, {
      eventId: result.eventId,
      title: 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz',
      source: 'RFE/RL',
      link: 'https://www.rferl.org/a/iran-tankers/33560001.html',
      publishedAt: new Date(NOW - 10 * 60_000).toISOString(),
      severity: 'critical',
      importanceScore: 88,
      corroborationCount: 3,
      category: 'conflict',
      countryCodes: ['IR'],
      variant: 'full',
    });
  });

  it('derives the link id for a pre-upgrade message that carries none, and nulls what the Saudi path lacks', () => {
    const raw = JSON.stringify({ eventType: 'rss_alert', severity: 'high', publishedAt: NOW, payload: { title: 'Civil Defense: sirens in Riyadh', source: 'Saudi Civil Defense', link: '', publishedAt: NOW, importanceScore: 70 } });
    const result = occ(raw);
    assert.equal(result.eventId, rssEventId('', 'Civil Defense: sirens in Riyadh'));
    assert.equal(result.payload.link, null);
    assert.equal(result.payload.category, null);
    assert.deepEqual(result.payload.countryCodes, []);
    assert.equal(result.payload.variant, null);
    assert.equal(result.payload.corroborationCount, 1);
  });

  it('rejects messages that are not a well-formed teed event', () => {
    assert.equal(occ('not json'), null);
    assert.equal(occ(JSON.stringify({ eventType: 'weather_alert', severity: 'critical', payload: { title: 'x' } })), null);
    assert.equal(occ(JSON.stringify({ eventType: 'rss_alert', severity: 'medium', payload: { title: 'x' } })), null);
    assert.equal(occ(JSON.stringify({ eventType: 'rss_alert', severity: 'high', payload: { title: '   ' } })), null);
    assert.equal(occ(JSON.stringify({ eventType: 'market_alert', severity: 'high', publishedAt: NOW, payload: { title: 'VIX: +21% surge', source: 'Equity Market', coalesceKey: 'market:equity:vix:surge:high' } })), null, 'a market message without the quote fields is not deliverable');
  });

  it('turns a market_alert message into a market.move occurrence, upper-casing the symbol', () => {
    const result = occ(marketMessage({ symbol: 'btc', assetClass: 'crypto', changePct: -22.4, name: 'Bitcoin', price: 61000 }));
    assert.equal(result.event, 'market.move');
    assert.deepEqual(result.payload, {
      eventId: result.eventId, assetClass: 'crypto', symbol: 'BTC', name: 'Bitcoin', price: 61000, changePct: -22.4,
      direction: 'down', severity: 'critical', source: 'Equity Market', publishedAt: new Date(NOW).toISOString(),
    });
  });
});

describe('matchOccurrence', () => {
  const news = occ(rssMessage({ title: 'Two tankers hit mines in the Strait of Hormuz, IRGC says', countryCodes: ['IR'], importanceScore: 75, severity: 'high', category: 'conflict' }));
  const unattributed = occ(rssMessage({ title: 'Markets wobble as tanker war fears grow', countryCodes: [], importanceScore: 75, severity: 'high', category: 'economic', link: 'https://example.com/markets' }));

  it('keywords are whole-word and case-insensitive, may contain spaces, and are reported back', () => {
    assert.deepEqual(matchOccurrence(newsRecord({ keywords: ['hormuz', 'strait of hormuz', 'iran'] }), news), { matchedKeywords: ['hormuz', 'strait of hormuz'] });
    assert.equal(matchOccurrence(newsRecord({ keywords: ['tank'] }), news), null, 'tank is not a word in tankers');
    assert.equal(matchOccurrence(newsRecord({ keywords: ['irgc'] }), news).matchedKeywords[0], 'irgc');
    assert.equal(keywordMatches('Gunmen kill four in Plateau', 'plateau'), true);
    assert.equal(keywordMatches('C++ devs', 'c++'), true, 'regex metacharacters are escaped');
  });

  it('an unscoped subscription takes every queued headline above the default floor; no keywords means matchedKeywords []', () => {
    assert.deepEqual(matchOccurrence(newsRecord(), news), { matchedKeywords: [] });
    assert.deepEqual(matchOccurrence(newsRecord(), unattributed), { matchedKeywords: [] });
  });

  it('country scope is strict: an unattributed headline never matches it', () => {
    assert.ok(matchOccurrence(newsRecord({ countries: ['IR', 'UA'] }), news));
    assert.equal(matchOccurrence(newsRecord({ countries: ['UA'] }), news), null);
    assert.equal(matchOccurrence(newsRecord({ countries: ['IR'] }), unattributed), null);
  });

  it('category, importance floor and severity floor each veto', () => {
    assert.ok(matchOccurrence(newsRecord({ categories: ['conflict', 'military'] }), news));
    assert.equal(matchOccurrence(newsRecord({ categories: ['economic'] }), news), null);
    assert.equal(matchOccurrence(newsRecord({ categories: ['economic'] }), occ(rssMessage({ title: 'x', category: null }))), null, 'a null category never satisfies a category scope');
    assert.equal(matchOccurrence(newsRecord({ importanceFloor: 76 }), news), null);
    assert.ok(matchOccurrence(newsRecord({ importanceFloor: 75 }), news));
    assert.equal(matchOccurrence(newsRecord({ severityFloor: 'critical' }), news), null);
    assert.ok(matchOccurrence(newsRecord({ severityFloor: 'critical' }), occ(rssMessage({ title: 'x', severity: 'critical' }))));
  });

  it('market scope: asset class, symbols, |changePct| floor and direction', () => {
    const move = occ(marketMessage({ changePct: -12 }));
    assert.deepEqual(matchOccurrence(marketRecord(), move), {});
    assert.ok(matchOccurrence(marketRecord({ assetClasses: ['equity'], symbols: ['VIX', 'SPY'], direction: 'down' }), move));
    assert.equal(matchOccurrence(marketRecord({ assetClasses: ['crypto'] }), move), null);
    assert.equal(matchOccurrence(marketRecord({ symbols: ['SPY'] }), move), null);
    assert.equal(matchOccurrence(marketRecord({ minAbsPct: 12.5 }), move), null);
    assert.equal(matchOccurrence(marketRecord({ direction: 'up' }), move), null);
    assert.equal(matchOccurrence(newsRecord(), move), null, 'a record never matches another event');
    assert.equal(matchOccurrence(record({ eventType: 'news.breaking' }), news)?.matchedKeywords?.length, 0, 'a record with no stored scope filters nothing');
  });
});

describe('planTick: occurrence records', () => {
  const plan = ({ records, occurrences, states = new Map(), now = NOW, ids = ['whd_1', 'whd_2', 'whd_3'] }) => {
    const queue = [...ids];
    return planTick({ chokepoints: null, riskScores: null, occurrences, records, states, now, scoresFetchedAt: null, makeId: () => queue.shift() ?? 'whd_more' });
  };
  const triggeredAt = new Date(NOW).toISOString();

  it('queues one delivery per matched occurrence under a fresh id, stores the payload pending, and starts the cap counters', () => {
    const rec = newsRecord({ keywords: ['hormuz'] });
    const event = occ(rssMessage({ title: 'Mines in the Strait of Hormuz' }));
    const { deliveries, nextStates, prunes, counters } = plan({ records: [rec], occurrences: [event, occ(rssMessage({ title: 'Unrelated protest', link: 'https://example.com/p' }))] });
    assert.equal(deliveries.length, 1);
    const [delivery] = deliveries;
    assert.equal(delivery.event, 'news.breaking');
    assert.equal(delivery.deliveryId, 'whd_1');
    assert.equal(delivery.stateField, occurrenceStateField(event.eventId));
    assert.deepEqual(Object.keys(delivery.payload).sort(), Object.keys(registry.events['news.breaking'].sample).sort());
    assert.equal(delivery.payload.subscriberId, rec.subscriberId);
    assert.deepEqual(delivery.payload.matchedKeywords, ['hormuz']);
    assert.equal(delivery.payload.reason, 'breaking_news');
    assert.equal(delivery.payload.triggeredAt, triggeredAt);
    const next = nextStates.get(rec.subscriberId);
    assert.deepEqual(next[delivery.stateField], {
      kind: 'occurrence', event: 'news.breaking', eventId: event.eventId, firstSeenAt: triggeredAt, attempts: 1,
      pending: { deliveryId: 'whd_1', triggeredAt }, payload: delivery.payload,
    });
    assert.deepEqual(next[OCCURRENCE_CAP_FIELD], { hour: '2026-10-17T18', hourCount: 1, day: '2026-10-17', dayCount: 1, suppressed: 0 });
    assert.equal(prunes.size, 0);
    assert.equal(counters.matched, 1);
  });

  it('the same eventId twice in one drain (two site variants of one story) is one delivery', () => {
    const a = occ(rssMessage({ title: 'Tankers hit mines in Hormuz', variant: 'full' }));
    const b = occ(rssMessage({ title: 'Two tankers hit mines in Hormuz, IRGC says', variant: 'finance' }));
    assert.equal(a.eventId, b.eventId);
    const { deliveries } = plan({ records: [newsRecord()], occurrences: [a, b] });
    assert.equal(deliveries.length, 1);
  });

  it('five site-variant publishes of one story under reworded headlines and link variants are one delivery', () => {
    const base = 'https://www.rferl.org/a/iran-tankers/33560001.html';
    const copies = [
      ['full', base, 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz'],
      ['tech', `${base}?utm_source=rss`, 'Two tankers hit mines in Hormuz, IRGC says'],
      ['finance', base.replace('https://www.', 'http://'), 'Oil jumps after tankers hit mines in Hormuz'],
      ['happy', `${base}#comments`, 'Tankers hit mines in Hormuz - RFE/RL'],
      ['commodity', `${base}/`, 'IRGC: two tankers struck mines near Hormuz'],
    ].map(([variant, link, title], i) => occ(rssMessage({ variant, link, title, publishedAt: NOW - (20 - i) * 60_000 })));
    assert.equal(new Set(copies.map((m) => m.eventId)).size, 1);
    const { deliveries } = plan({ records: [newsRecord()], occurrences: copies });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.variant, 'full', 'the first copy drained is the one delivered');
  });

  it('an hourly republish of one market move is one event per UTC day, and a new day is a new event', () => {
    const hourly = [0, 1, 2, 3].map((h) => occ(marketMessage({ publishedAt: NOW - 5 * HOUR + h * HOUR })));
    assert.equal(new Set(hourly.map((m) => m.eventId)).size, 1);
    const { deliveries, nextStates } = plan({ records: [marketRecord()], occurrences: hourly });
    assert.equal(deliveries.length, 1);
    assert.deepEqual(Object.keys(deliveries[0].payload).sort(), Object.keys(registry.events['market.move'].sample).sort());
    assert.equal(deliveries[0].payload.reason, 'large_move');
    const tomorrow = occ(marketMessage({ publishedAt: Date.parse('2026-10-18T00:30:00.000Z') }));
    const again = plan({ records: [marketRecord()], occurrences: [tomorrow], states: new Map([[marketRecord().subscriberId, nextStates.get(marketRecord().subscriberId)]]), now: Date.parse('2026-10-18T00:35:00.000Z') });
    assert.equal(again.deliveries.length, 1);
    assert.notEqual(again.deliveries[0].payload.eventId, deliveries[0].payload.eventId);
  });

  it('caps at maxDeliveriesPerHour, counts the overflow as suppressed and never stores it, then reopens next hour up to the day cap', () => {
    const rule = OCCURRENCE_RULES['news.breaking'];
    const rec = newsRecord();
    const burst = Array.from({ length: rule.maxPerHour + 3 }, (_, i) => occ(rssMessage({ title: `Story ${i}`, link: `https://example.com/s/${i}` })));
    const first = plan({ records: [rec], occurrences: burst, ids: [] });
    assert.equal(first.deliveries.length, rule.maxPerHour);
    assert.equal(first.counters.suppressed, 3);
    const next = first.nextStates.get(rec.subscriberId);
    assert.deepEqual(next[OCCURRENCE_CAP_FIELD], { hour: '2026-10-17T18', hourCount: rule.maxPerHour, day: '2026-10-17', dayCount: rule.maxPerHour, suppressed: 3 });
    assert.equal(Object.keys(next).filter((f) => f.startsWith('occ:')).length, rule.maxPerHour, 'suppressed events leave no state');

    const sameHour = plan({ records: [rec], occurrences: [occ(rssMessage({ title: 'Late', link: 'https://example.com/late' }))], states: new Map([[rec.subscriberId, { [OCCURRENCE_CAP_FIELD]: next[OCCURRENCE_CAP_FIELD] }]]), now: NOW + 5 * 60_000 });
    assert.equal(sameHour.deliveries.length, 0);
    assert.equal(sameHour.counters.suppressed, 1);

    const nextHour = plan({ records: [rec], occurrences: [occ(rssMessage({ title: 'Late', link: 'https://example.com/late' }))], states: new Map([[rec.subscriberId, { [OCCURRENCE_CAP_FIELD]: next[OCCURRENCE_CAP_FIELD] }]]), now: NOW + HOUR });
    assert.equal(nextHour.deliveries.length, 1);
    assert.equal(nextHour.nextStates.get(rec.subscriberId)[OCCURRENCE_CAP_FIELD].dayCount, rule.maxPerHour + 1);

    const dayFull = { hour: '2026-10-17T10', hourCount: 0, day: '2026-10-17', dayCount: rule.maxPerDay, suppressed: 0 };
    const atDayCap = plan({ records: [rec], occurrences: [occ(rssMessage({ title: 'Late', link: 'https://example.com/late' }))], states: new Map([[rec.subscriberId, { [OCCURRENCE_CAP_FIELD]: dayFull }]]) });
    assert.equal(atDayCap.deliveries.length, 0);
  });

  it('re-queues a pending delivery from an earlier tick first, with the same id and stored payload, and bumps attempts', () => {
    const rec = newsRecord();
    const earlier = occ(rssMessage({ title: 'Earlier story', link: 'https://example.com/earlier' }));
    const stored = {
      kind: 'occurrence', event: 'news.breaking', eventId: earlier.eventId, firstSeenAt: '2026-10-17T18:30:00.000Z', attempts: 2,
      pending: { deliveryId: 'whd_old', triggeredAt: '2026-10-17T18:30:00.000Z' },
      payload: { subscriberId: rec.subscriberId, ...earlier.payload, matchedKeywords: [], triggeredAt: '2026-10-17T18:30:00.000Z', reason: 'breaking_news' },
    };
    const fresh = occ(rssMessage({ title: 'Fresh story', link: 'https://example.com/fresh' }));
    const { deliveries, nextStates } = plan({ records: [rec], occurrences: [fresh, earlier], states: new Map([[rec.subscriberId, { [occurrenceStateField(earlier.eventId)]: stored }]]) });
    assert.deepEqual(deliveries.map((d) => d.deliveryId), ['whd_old', 'whd_1']);
    assert.deepEqual(deliveries[0].payload, stored.payload, 'a retry resends the payload as first built');
    assert.equal(nextStates.get(rec.subscriberId)[occurrenceStateField(earlier.eventId)].attempts, 3);
  });

  it('drops a pending delivery older than retry.pendingTtlSeconds without sending it, counts it and leaves an expired tombstone', () => {
    const rec = newsRecord();
    const old = occ(rssMessage({ title: 'Old story', link: 'https://example.com/old' }));
    const ttlMs = OCCURRENCE_RULES['news.breaking'].pendingTtlMs;
    const stored = { kind: 'occurrence', event: 'news.breaking', eventId: old.eventId, firstSeenAt: 'x', attempts: 9, pending: { deliveryId: 'whd_old', triggeredAt: new Date(NOW - ttlMs - 1).toISOString() }, payload: { title: 'x' } };
    const { deliveries, prunes, counters, nextStates } = plan({ records: [rec], occurrences: [], states: new Map([[rec.subscriberId, { [occurrenceStateField(old.eventId)]: stored }]]) });
    assert.equal(deliveries.length, 0);
    assert.equal(prunes.size, 0);
    assert.equal(counters.expired, 1);
    assert.deepEqual(nextStates.get(rec.subscriberId)[occurrenceStateField(old.eventId)], { kind: 'occurrence', event: 'news.breaking', eventId: old.eventId, firstSeenAt: 'x', expiredAt: new Date(NOW).toISOString() });
  });

  it('a delivered tombstone blocks re-delivery of the same event and is pruned after a day', () => {
    const rec = newsRecord();
    const event = occ(rssMessage({ title: 'Delivered story', link: 'https://example.com/done' }));
    const field = occurrenceStateField(event.eventId);
    const recent = { kind: 'occurrence', event: 'news.breaking', eventId: event.eventId, firstSeenAt: 'x', deliveredAt: new Date(NOW - HOUR).toISOString() };
    const blocked = plan({ records: [rec], occurrences: [event], states: new Map([[rec.subscriberId, { [field]: recent }]]) });
    assert.equal(blocked.deliveries.length, 0);
    assert.equal(blocked.prunes.size, 0);
    const stale = { ...recent, deliveredAt: new Date(NOW - 25 * HOUR).toISOString() };
    const pruned = plan({ records: [rec], occurrences: [], states: new Map([[rec.subscriberId, { [field]: stale }]]) });
    assert.deepEqual(pruned.prunes.get(rec.subscriberId), [field]);
    assert.equal(pruned.counters.pruned, 1);
  });

  it('leaves occurrence records untouched when the fan-out list was unreadable, while a chokepoint record proceeds', () => {
    const cp = record({ subscriberId: 'wh_cccccccccccccccccccccccc' });
    const { deliveries, nextStates } = planTick({
      chokepoints: [{ id: 'suez', name: 'Suez', disruptionScore: 75, warRiskTier: 'WAR_RISK_TIER_NORMAL' }],
      riskScores: null, occurrences: null, records: [newsRecord(), cp], states: new Map(), now: NOW, scoresFetchedAt: 'x', makeId: () => 'whd_cp',
    });
    assert.deepEqual(deliveries.map((d) => d.event), ['chokepoint.disruption']);
    assert.equal(nextStates.has(newsRecord().subscriberId), false, 'no state write, no pending retry, for a source we did not read');
  });

  it('mixed threshold and occurrence records deliver in one tick, each under its own event header', () => {
    const cp = record({ subscriberId: 'wh_cccccccccccccccccccccccc' });
    const { deliveries } = planTick({
      chokepoints: [{ id: 'suez', name: 'Suez', disruptionScore: 75, warRiskTier: 'WAR_RISK_TIER_NORMAL' }],
      riskScores: null, occurrences: [occ(rssMessage({ title: 'A' })), occ(marketMessage())],
      records: [newsRecord(), marketRecord(), cp], states: new Map(), now: NOW, scoresFetchedAt: 'x', makeId: () => 'whd_x',
    });
    assert.deepEqual(deliveries.map((d) => d.event).sort(), ['chokepoint.disruption', 'market.move', 'news.breaking']);
  });

  it('parseStateHash keeps occurrence fields and the cap field beside the armed entries', () => {
    const flat = ['suez', JSON.stringify({ armed: false, lastScore: 70 }), 'occ:rss_x', JSON.stringify({ kind: 'occurrence', event: 'news.breaking' }), OCCURRENCE_CAP_FIELD, JSON.stringify({ hour: 'h', hourCount: 1 }), 'junk', JSON.stringify({ foo: 1 }), 'occ:bad', JSON.stringify({ kind: 'other' })];
    assert.deepEqual(Object.keys(parseStateHash(flat)).sort(), [OCCURRENCE_CAP_FIELD, 'occ:rss_x', 'suez']);
    assert.deepEqual(nextCapState({ hour: '2026-10-17T18', hourCount: 4, day: '2026-10-17', dayCount: 9, suppressed: 2 }, NOW + HOUR), { hour: '2026-10-17T19', hourCount: 0, day: '2026-10-17', dayCount: 9, suppressed: 2 });
  });
});

// End to end through runTick with the in-memory pipeline.

const TOKEN = 'run-1';
function lockStub(store) {
  return {
    acquire: async () => { store.set(LOCK_KEY, TOKEN); return true; },
    fence: () => ({ key: LOCK_KEY, token: TOKEN }),
    release: async () => {},
  };
}

function seeded({ records = [newsRecord({ keywords: ['hormuz'] }), marketRecord()], messages = [], chokepoints = null } = {}) {
  const initial = { 'webhook:all:v1': new Set(records.map((r) => r.subscriberId)), [BACKFILL_CURSOR_KEY]: 'done' };
  for (const rec of records) initial[`webhook:sub:${rec.subscriberId}:v1`] = JSON.stringify(rec);
  if (chokepoints) initial[CHOKEPOINT_STATUS_KEY] = JSON.stringify({ chokepoints, fetchedAt: 'x' });
  // LPUSH order: the first message is the oldest (tail).
  if (messages.length) initial[FANOUT_LIST_KEY] = [...messages].reverse();
  return fakeRedis(initial);
}

function deliverStub(outcomes = []) {
  const sent = [];
  const deliver = async (rec, payload, deliveryId, event) => {
    sent.push({ rec, payload, deliveryId, event });
    return outcomes.shift() ?? { ok: true, status: 200 };
  };
  return { sent, deliver };
}

const tick = (fake, deliver, now = NOW) => runTick({ redis: fake.redis, lock: lockStub(fake.store), deliver, env: {}, fetchImpl: async () => { throw new Error('unexpected fetch'); }, now: () => now });
const NEWS_SUB = newsRecord().subscriberId;
const MARKET_SUB = marketRecord().subscriberId;

describe('runTick: occurrence deliveries', () => {
  it('drains the list oldest first, delivers once per subscriber and event, marks ids seen, trims the list and writes tombstones', async () => {
    const story = { title: 'Two tankers hit mines in the Strait of Hormuz', link: 'https://www.rferl.org/a/hormuz/1.html' };
    const fake = seeded({ messages: [
      rssMessage({ ...story, variant: 'full' }),
      rssMessage({ ...story, title: 'IRGC: tankers hit mines in Hormuz', variant: 'finance' }),
      rssMessage({ title: 'Protesters clash with police in Belgium', link: 'https://example.com/be', countryCodes: ['BE'], category: 'protest' }),
      marketMessage(),
      'not json at all',
    ] });
    const { sent, deliver } = deliverStub();
    const summary = await tick(fake, deliver);
    assert.deepEqual(sent.map((s) => s.event), ['news.breaking', 'market.move']);
    assert.equal(sent[0].rec.subscriberId, NEWS_SUB);
    assert.deepEqual(sent[0].payload.matchedKeywords, ['hormuz']);
    assert.equal(sent[0].payload.variant, 'full', 'the oldest copy wins');
    assert.equal(sent[1].payload.symbol, 'VIX');
    assert.equal(summary.fanoutState, 'ok');
    assert.deepEqual(summary.occurrences, { drained: 5, unreadable: 1, duplicates: 1, matched: 2, suppressed: 0, deferred: 0, expired: 0, pruned: 0 });
    assert.equal(summary.deliveries, 2);
    assert.equal(fake.store.has(FANOUT_LIST_KEY), false, 'every drained message is trimmed');
    const newsSeen = fake.store.get(seenKey('news.breaking'));
    assert.equal(newsSeen.size, 2, 'both distinct story ids are seen, matched or not');
    assert.equal(fake.store.get(seenKey('market.move')).size, 1);
    const state = fake.store.get(stateKey(NEWS_SUB));
    const tombstone = JSON.parse(state[occurrenceStateField(sent[0].payload.eventId)]);
    assert.deepEqual(tombstone, { kind: 'occurrence', event: 'news.breaking', eventId: sent[0].payload.eventId, firstSeenAt: new Date(NOW).toISOString(), deliveredAt: new Date(NOW).toISOString() });
    assert.equal(JSON.parse(state[OCCURRENCE_CAP_FIELD]).hourCount, 1);
    assert.deepEqual(JSON.parse(fake.store.get(WORKER_META_KEY)).occurrences, summary.occurrences);

    // The relay republishes the same move an hour later and a variant copy of the story: nothing new is delivered.
    fake.store.set(FANOUT_LIST_KEY, [marketMessage({ publishedAt: NOW + HOUR }), rssMessage({ ...story, variant: 'tech' })]);
    const again = await tick(fake, deliver, NOW + HOUR);
    assert.equal(sent.length, 2, 'an hourly republish of one move and another variant of one story deliver nothing');
    assert.equal(again.occurrences.duplicates, 2);
    assert.equal(fake.store.has(FANOUT_LIST_KEY), false);
  });

  it('retries a failed delivery next tick with the same id without re-reading the message, then tombstones it', async () => {
    const fake = seeded({ records: [newsRecord()], messages: [rssMessage({ title: 'Story', link: 'https://example.com/s' })] });
    const { sent, deliver } = deliverStub([{ ok: false, status: 503, error: 'http_503' }]);
    const first = await tick(fake, deliver);
    assert.equal(first.failures, 1);
    assert.equal(fake.store.has(FANOUT_LIST_KEY), false, 'the message is consumed; the pending state carries it now');
    const field = occurrenceStateField(sent[0].payload.eventId);
    const pending = JSON.parse(fake.store.get(stateKey(NEWS_SUB))[field]);
    assert.equal(pending.pending.deliveryId, sent[0].deliveryId);
    assert.equal(pending.attempts, 1);
    assert.equal(JSON.parse(fake.store.get(`webhook:sub:${NEWS_SUB}:v1`)).failureCount, 1);

    const second = await tick(fake, deliver, NOW + 5 * 60_000);
    assert.equal(second.deliveries, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].deliveryId, sent[0].deliveryId, 'same delivery id across the retry');
    assert.deepEqual(sent[1].payload, sent[0].payload, 'same body across the retry');
    const settled = JSON.parse(fake.store.get(stateKey(NEWS_SUB))[field]);
    assert.equal(settled.deliveredAt, new Date(NOW + 5 * 60_000).toISOString());
    assert.equal('payload' in settled, false);
    assert.equal(JSON.parse(fake.store.get(`webhook:sub:${NEWS_SUB}:v1`)).failureCount, 0);
  });

  it('a replayed message after a crash between drain and trim is a no-op, and an expired pending becomes a tombstone that is HDEL\'d a day later', async () => {
    const msg = rssMessage({ title: 'Story', link: 'https://example.com/replay' });
    const fake = seeded({ records: [newsRecord()], messages: [msg] });
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    fake.store.set(FANOUT_LIST_KEY, [msg]);
    const replay = await tick(fake, deliver, NOW + 60_000);
    assert.equal(sent.length, 1);
    assert.equal(replay.occurrences.duplicates, 1);

    const old = occurrenceStateField('rss_' + 'f'.repeat(32));
    const state = fake.store.get(stateKey(NEWS_SUB));
    state[old] = JSON.stringify({ kind: 'occurrence', event: 'news.breaking', eventId: 'rss_' + 'f'.repeat(32), firstSeenAt: 'x', attempts: 3, pending: { deliveryId: 'whd_old', triggeredAt: new Date(NOW - 3 * HOUR).toISOString() }, payload: { title: 'x' } });
    const expired = await tick(fake, deliver, NOW + 2 * 60_000);
    assert.equal(expired.occurrences.expired, 1);
    assert.equal(JSON.parse(fake.store.get(stateKey(NEWS_SUB))[old]).pending, undefined, 'the expired pending is now a tombstone');
    assert.equal(sent.length, 1);
    const pruned = await tick(fake, deliver, NOW + 25 * HOUR);
    assert.ok(pruned.occurrences.pruned >= 1);
    assert.equal(old in fake.store.get(stateKey(NEWS_SUB)), false, 'STATE_HDEL removed the day-old tombstone');
  });

  it('skips occurrence records and reports fanoutState error when the list is unreadable, while a chokepoint still delivers', async () => {
    const cp = record({ subscriberId: 'wh_cccccccccccccccccccccccc' });
    const fake = seeded({ records: [newsRecord(), cp], messages: [rssMessage({ title: 'Story' })], chokepoints: [{ id: 'suez', name: 'Suez', disruptionScore: 75, warRiskTier: 'WAR_RISK_TIER_NORMAL', navigationalWarningsAvailable: true }] });
    const inner = fake.redis;
    const redis = async (commands) => {
      if (commands.some((c) => c[0] === 'LRANGE')) throw new Error('list unreadable');
      return inner(commands);
    };
    const { sent, deliver } = deliverStub();
    const summary = await runTick({ redis, lock: lockStub(fake.store), deliver, env: {}, fetchImpl: async () => { throw new Error('no'); }, now: () => NOW });
    assert.equal(summary.fanoutState, 'error');
    assert.deepEqual(sent.map((s) => s.event), ['chokepoint.disruption']);
    assert.equal(fake.store.has(stateKey(NEWS_SUB)), false);
    assert.equal(fake.store.get(FANOUT_LIST_KEY).length, 1, 'nothing trimmed when nothing was read');
  });

  it('a pre-upgrade rss_alert message without an eventId is delivered under the derived link id', async () => {
    const fake = seeded({ records: [newsRecord()], messages: [rssMessage({ title: 'Legacy', link: 'https://example.com/legacy', withId: false })] });
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.eventId, rssEventId('https://example.com/legacy', 'Legacy'));
  });

  it('a lost lock leaves the list untrimmed and the seen set unwritten', async () => {
    const fake = seeded({ records: [newsRecord()], messages: [rssMessage({ title: 'Story' })] });
    const deliver = async () => {
      fake.store.set(LOCK_KEY, 'someone-else');
      return { ok: true, status: 200 };
    };
    await assert.rejects(tick(fake, deliver), /lock lost/);
    assert.equal(fake.store.get(FANOUT_LIST_KEY).length, 1);
    assert.equal(fake.store.has(seenKey('news.breaking')), false);
  });
});

// PR #9332 review: an eventId is settled per subscriber, not globally, and the
// hourly cap counts every event POSTed in the hour, retries included.
describe('occurrence dedupe is per subscriber; caps count retries', () => {
  const plan = ({ records, occurrences, states = new Map(), now = NOW }) => {
    let n = 0;
    return planTick({ chokepoints: null, riskScores: null, occurrences, records, states, now, scoresFetchedAt: null, makeId: () => `whd_${String(++n).padStart(32, '0')}` });
  };

  it('a later copy of one move that clears a subscriber\'s floor is delivered after an earlier copy that did not (two ticks)', async () => {
    const rec = marketRecord({ minAbsPct: 15 });
    const fake = seeded({ records: [rec], messages: [marketMessage({ changePct: 11, publishedAt: NOW - HOUR })] });
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    assert.equal(sent.length, 0, '11 percent is under the 15 percent floor');
    fake.store.set(FANOUT_LIST_KEY, [marketMessage({ changePct: 16 })]);
    await tick(fake, deliver, NOW + HOUR);
    assert.equal(sent.length, 1, 'the same critical-band move at 16 percent now matches');
    assert.equal(sent[0].payload.changePct, 16);
  });

  it('the same holds within one drain, and the first matching copy is the one delivered', async () => {
    const rec = marketRecord({ minAbsPct: 15 });
    const fake = seeded({ records: [rec, marketRecord({}, { subscriberId: 'wh_cccccccccccccccccccccccc' })], messages: [
      marketMessage({ changePct: 11, publishedAt: NOW - HOUR }),
      marketMessage({ changePct: 16 }),
      marketMessage({ changePct: 17, publishedAt: NOW + 60_000 }),
    ] });
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    const bySub = Object.fromEntries(sent.map((s) => [s.rec.subscriberId, s.payload.changePct]));
    assert.deepEqual(bySub, { [rec.subscriberId]: 16, wh_cccccccccccccccccccccccc: 11 });
  });

  it('a reworded headline of an already-seen story reaches a subscriber whose keyword only the new wording carries', async () => {
    const link = 'https://www.rferl.org/a/iran-tankers/33560001.html';
    const fake = seeded({ records: [newsRecord({ keywords: ['hormuz'] })], messages: [rssMessage({ title: 'Two tankers hit mines in the Gulf', link })] });
    const { sent, deliver } = deliverStub();
    await tick(fake, deliver);
    assert.equal(sent.length, 0);
    fake.store.set(FANOUT_LIST_KEY, [rssMessage({ title: 'Two tankers hit mines in Strait of Hormuz', link, variant: 'finance' })]);
    await tick(fake, deliver, NOW + 10 * 60_000);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload.matchedKeywords, ['hormuz']);
  });

  it('retries carried into a new hour use that hour\'s slots, so no hour sends more than maxDeliveriesPerHour events', () => {
    const rule = OCCURRENCE_RULES['news.breaking'];
    const rec = newsRecord();
    const admittedAt = '2026-10-17T18:55:00.000Z';
    const state = {};
    for (let i = 0; i < rule.maxPerHour; i += 1) {
      const eventId = rssEventId(`https://example.com/p/${i}`, `P${i}`);
      state[occurrenceStateField(eventId)] = {
        kind: 'occurrence', event: 'news.breaking', eventId, firstSeenAt: admittedAt, attempts: 1,
        pending: { deliveryId: `whd_${String(i).padStart(32, 'a')}`, triggeredAt: admittedAt },
        payload: { subscriberId: rec.subscriberId, title: `P${i}` },
      };
    }
    const now = Date.parse('2026-10-17T19:05:00.000Z');
    state[OCCURRENCE_CAP_FIELD] = { hour: '2026-10-17T19', hourCount: 5, day: '2026-10-17', dayCount: rule.maxPerHour + 5, suppressed: 0 };
    const fresh = Array.from({ length: 3 }, (_, i) => normalizeTeeMessage(rssMessage({ title: `New ${i}`, link: `https://example.com/n/${i}`, publishedAt: now - 60_000 }), now));
    const { deliveries, nextStates, counters } = plan({ records: [rec], occurrences: fresh, states: new Map([[rec.subscriberId, state]]), now });
    assert.equal(deliveries.length, rule.maxPerHour - 5, 'only the hour\'s remaining slots are used');
    assert.ok(deliveries.every((d) => d.payload.title.startsWith('P')), 'retries go first');
    const next = nextStates.get(rec.subscriberId);
    assert.equal(next[OCCURRENCE_CAP_FIELD].hourCount, rule.maxPerHour);
    assert.equal(counters.deferred, 5, 'five retries wait for the next hour, still pending');
    const waiting = Object.values(next).filter((s) => s?.pending && s.pending.countedHour !== '2026-10-17T19');
    assert.equal(waiting.length, 5);
    assert.equal(counters.suppressed, 3, 'new events over the cap are dropped as before');

    // Later in the same hour the retries already counted resend without taking a slot.
    const again = plan({ records: [rec], occurrences: [], states: new Map([[rec.subscriberId, next]]), now: now + 5 * 60_000 });
    assert.equal(again.deliveries.length, rule.maxPerHour - 5);
    assert.equal(again.counters.deferred, 5);
  });

  it('an expired pending delivery leaves a tombstone, so a republish of the same event does not fire later', () => {
    const rec = marketRecord();
    const move = occ(marketMessage());
    const field = occurrenceStateField(move.eventId);
    const ttlMs = OCCURRENCE_RULES['market.move'].pendingTtlMs;
    const stored = { kind: 'occurrence', event: 'market.move', eventId: move.eventId, firstSeenAt: 'x', attempts: 20, pending: { deliveryId: 'whd_old', triggeredAt: new Date(NOW - ttlMs - 1).toISOString() }, payload: { symbol: 'VIX' } };
    const expired = plan({ records: [rec], occurrences: [move], states: new Map([[rec.subscriberId, { [field]: stored }]]) });
    assert.equal(expired.deliveries.length, 0);
    assert.equal(expired.counters.expired, 1);
    const tombstone = expired.nextStates.get(rec.subscriberId)[field];
    assert.equal(tombstone.pending, undefined);
    assert.equal(tombstone.expiredAt, new Date(NOW).toISOString());
    const later = plan({ records: [rec], occurrences: [occ(marketMessage({ publishedAt: NOW + HOUR }))], states: new Map([[rec.subscriberId, { [field]: tombstone }]]), now: NOW + HOUR });
    assert.equal(later.deliveries.length, 0);
    const dayLater = plan({ records: [rec], occurrences: [], states: new Map([[rec.subscriberId, { [field]: tombstone }]]), now: NOW + 25 * HOUR });
    assert.deepEqual(dayLater.prunes.get(rec.subscriberId), [field]);
  });
});
