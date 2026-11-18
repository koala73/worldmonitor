// The relay's news-alert story key (scripts/lib/news-story-key.cjs).
//
// 2026-11-17: an alerted CNN exclusive alerted a second time nine hours later
// when Egypt Independent republished it under the same headline. The headlines
// below are the four the relay queued for that story.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest.ts';

const require = createRequire(import.meta.url);
const {
  NEWS_STORY_DEDUP_TTL_SECONDS,
  REALTIME_CRITICAL_IMPORTANCE_SCORE,
  newsStoryKey,
  newsStoryKeyLoadError,
  normalizeNewsStoryTitle,
} = require('../scripts/lib/news-story-key.cjs');
const { NEWS_GLOBAL_IMPORTANCE_SCORE } = require('../scripts/lib/notification-delivery-tiers.cjs');

// A sighting a realtime rule delivers, and two it does not.
const DELIVERABLE = { severity: 'critical', importanceScore: 83 };
const LOW_SCORE_CRITICAL = { severity: 'critical', importanceScore: 73 };
const HIGH = { severity: 'high', importanceScore: 69 };

const CNN = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say - CNN';
const EGYPT_INDEPENDENT = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say';
const SUN_ONLINE = 'Iran plots dirty bomb or chemical attack on US capital —report - SunOnline International';
const NDTV = "Iran Plans To Detonate 'Dirty Bomb' In Washington, Warns US Intel: Report";

test('the shared normalizer loads', () => {
  assert.equal(newsStoryKeyLoadError(), null);
});

test('a headline repeated by a second publisher has the story key of the first', () => {
  assert.ok(newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(CNN.replace(/ - CNN$/, ''), DELIVERABLE), newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(EGYPT_INDEPENDENT, DELIVERABLE), newsStoryKey(CNN, DELIVERABLE));
});

test('case and punctuation do not change the key', () => {
  assert.equal(
    newsStoryKey('EXCLUSIVE - US intel indicates Iran developing plans to potentially detonate a "dirty bomb" in Washington; sources say', DELIVERABLE),
    newsStoryKey(EGYPT_INDEPENDENT, DELIVERABLE),
  );
});

test('differently worded reports of one event keep separate keys', () => {
  const keys = new Set([CNN, SUN_ONLINE, NDTV].map((title) => newsStoryKey(title, HIGH)));
  assert.equal(keys.size, 3);
});

test('a sighting no realtime rule delivers does not share a key with one that is delivered', () => {
  // Realtime rules deliver critical events at or above the score bar. A
  // sighting below either reaches nobody, so it must not claim the story
  // before a later one that would be delivered.
  assert.notEqual(newsStoryKey(CNN, HIGH), newsStoryKey(CNN, DELIVERABLE));
  assert.notEqual(newsStoryKey(CNN, LOW_SCORE_CRITICAL), newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(CNN, LOW_SCORE_CRITICAL), newsStoryKey(CNN, HIGH));
  assert.equal(newsStoryKey(CNN, { severity: 'critical', importanceScore: 82 }), newsStoryKey(CNN, DELIVERABLE));
});

test('a critical sighting without a score counts as delivered, as the relay treats it', () => {
  assert.equal(newsStoryKey(CNN, { severity: 'critical' }), newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(CNN), newsStoryKey(CNN, HIGH));
});

test('the score bar is the one realtime delivery uses', () => {
  assert.equal(REALTIME_CRITICAL_IMPORTANCE_SCORE, NEWS_GLOBAL_IMPORTANCE_SCORE);
});

test('a headline too short to stand for one story keeps the exact-title identity', () => {
  assert.equal(newsStoryKey('Israel strikes Lebanon', DELIVERABLE), '');
  assert.equal(newsStoryKey('Wind', DELIVERABLE), '');
  assert.equal(newsStoryKey('', DELIVERABLE), '');
  assert.equal(newsStoryKey(undefined, DELIVERABLE), '');
  assert.ok(newsStoryKey('Iran closes Strait of Hormuz', DELIVERABLE));
});

test('the key normalizes a headline as digest story tracking does, without its 120-character cut', () => {
  for (const title of [
    CNN,
    EGYPT_INDEPENDENT,
    SUN_ONLINE,
    NDTV,
    'Tankers hit in Strait of Hormuz as drone raises alarm at Iraq gas field - Al Jazeera',
    'Ukraine’s Ust-Luga strike destroyed five fuel tanks | Reuters',
    'Séisme de magnitude 7,1 au large du Chili – Le Monde',
    `Long headline ${'word '.repeat(60)}`,
  ]) {
    const tracked = digest.normalizeTitle(title);
    // The one other difference: punctuation inside a number becomes a space
    // in the key, where tracking drops it (see the next test).
    const keyed = normalizeNewsStoryTitle(title).replace(/(?<=\p{N}) (?=\p{N})/gu, '');
    if (keyed.length <= 120) assert.equal(keyed, tracked, title);
    else assert.equal(keyed.slice(0, 120).trim(), tracked.trim(), title);
  }
});

test('numbers that differ only by a separator keep separate keys', () => {
  // Dropping the point would make these one story, held for a day, so the
  // second would never alert. Tracking drops it; the key keeps the numbers apart.
  const pairs = [
    ['Fighting displaces 1.5 million people in Sudan, UN says', 'Fighting displaces 15 million people in Sudan, UN says'],
    ['Magnitude 7.1 earthquake strikes off the coast of Chile', 'Magnitude 71 earthquake strikes off the coast of Chile'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(digest.normalizeTitle(a), digest.normalizeTitle(b));
    assert.notEqual(newsStoryKey(a, DELIVERABLE), newsStoryKey(b, DELIVERABLE), a);
  }
  // A comma or point between words still goes, so attribution and quoting do
  // not split a repeated headline.
  assert.equal(
    newsStoryKey('Iran warns U.S. over strikes, officials say', DELIVERABLE),
    newsStoryKey('Iran warns US over strikes officials say', DELIVERABLE),
  );
});

test('long headlines that part only at the end keep separate keys', () => {
  const lead = 'Russia launches a major overnight missile and drone attack on energy infrastructure across Ukraine as authorities report';
  const kyiv = `${lead} three people killed in Kyiv`;
  const odesa = `${lead} twenty people killed in Odesa`;
  // Story tracking cuts both to the same 120 characters.
  assert.equal(digest.normalizeTitle(kyiv), digest.normalizeTitle(odesa));
  assert.notEqual(newsStoryKey(kyiv, DELIVERABLE), newsStoryKey(odesa, DELIVERABLE));
  assert.equal(newsStoryKey(`${kyiv} - Reuters`, DELIVERABLE), newsStoryKey(kyiv, DELIVERABLE));
});

test('a story is claimed for the day an exact repeat is already held for', () => {
  assert.equal(NEWS_STORY_DEDUP_TTL_SECONDS, 24 * 60 * 60);
});

test('digest sightings retain trusted families under the delivery headline across builds', async (t) => {
  const { refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const sets = new Map<string, Map<string, number>>();
  const day = 86_400_000;
  const start = Date.now() - day;
  const apply = ([op, key, ...args]: (string | number)[]) => {
    const members = sets.get(String(key)) ?? new Map<string, number>();
    sets.set(String(key), members);
    if (op === 'ZADD') {
      assert.equal(args.shift(), 'GT');
      for (let i = 0; i < args.length; i += 2) {
        const family = String(args[i + 1]);
        members.set(family, Math.max(Number(args[i]), members.get(family) ?? 0));
      }
    } else if (op === 'ZRANGEBYSCORE') {
      const after = Number(String(args[0]).slice(1));
      return { result: [...members].filter(([, seen]) => seen > after && seen <= Number(args[1])).map(([family]) => family) };
    } else assert.equal(op, 'EXPIRE');
    return { result: 1 };
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(apply)));
  const saved = { ...process.env };
  t.after(() => {
    for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  const write = (at, ...items) => digest.recordPublisherCoverage(items, items, at, Infinity);
  const first = { title: CNN, source: 'CNN World', originPublisherTrusted: false };
  const later = { title: EGYPT_INDEPENDENT, source: 'Egypt Independent' };
  await write(start, first, { ...first, originPublisher: 'Forged source' });
  await write(start + 3_600_000, later, { ...later, source: 'Google News', originPublisher: later.source, originPublisherTrusted: true });
  await write(start, later); // an earlier build finishing late
  await write(start, { ...later, source: 'Another feed' }); // another edition's build counts too (#10977)
  await write(start, { ...later, title: SUN_ONLINE, source: 'Other headline feed' });
  const event = { eventType: 'rss_alert', variant: 'full', payload: { title: CNN, corroborationCount: 1 } };
  const read = (now, transport = async commands => commands.map(apply)) => refreshPublisherCounts([event], now, transport);
  await read(start + 4_000_000);
  assert.equal(event.observedPublisherCount, 3);
  assert.equal(event.payload.corroborationCount, 1);
  // One family left in the window is no more than the producer counted, so
  // the event keeps rendering its own count.
  await read(start + day);
  assert.equal(event.observedPublisherCount, undefined);
  await read(start + day, async () => null);
  assert.equal(event.observedPublisherCount, undefined);
});

test('coverage writes key only served headlines, two commands each, with families from below the cap', async (t) => {
  const batches: unknown[][][] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const commands = JSON.parse(init.body);
    batches.push(commands);
    return Response.json(commands.map(() => ({ result: 1 })));
  });
  const saved = { ...process.env };
  t.after(() => {
    for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  const served = { title: CNN, source: 'CNN World' };
  const belowCapRepeat = { title: EGYPT_INDEPENDENT, source: 'Egypt Independent' };
  const belowCapOnly = { title: SUN_ONLINE, source: 'SunOnline International' };
  await digest.recordPublisherCoverage([served, belowCapRepeat, belowCapOnly], [served], Date.now(), Infinity);
  const commands = batches.flat().filter((cmd) => cmd[0] !== 'MULTI' && cmd[0] !== 'EXEC');
  assert.deepEqual(commands.map((cmd) => cmd[0]), ['ZADD', 'EXPIRE']);
  const [, , gt, ...scored] = commands[0];
  assert.equal(gt, 'GT');
  assert.equal(scored.length / 2, 2, 'the below-cap repeat adds its publisher to the served headline');
});

test('the coverage ledger write stops waiting at its deadline when Redis stalls', async (t) => {
  // The ledger runs after the coverage and history writes join, which may hold
  // until the tracking deadline; a 5 s Redis wait past that loses the digest.
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const warn = t.mock.method(console, 'warn', () => {});
  const saved = { ...process.env };
  t.after(() => {
    for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const started = Date.now();
  await digest.writeCoverageLedger('news:coverage-ledger:v1:full:en', { v: 1 }, started + 50);
  const waited = Date.now() - started;
  assert.ok(waited < 1_000, `waited ${waited} ms`);
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('abandoned at the response deadline')));
});
