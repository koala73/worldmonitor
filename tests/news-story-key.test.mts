// The relay's news-alert story key (scripts/lib/news-story-key.cjs).
//
// 2026-11-17: an alerted CNN exclusive alerted a second time nine hours later
// when Egypt Independent republished it under the same headline. The headlines
// below are the four the relay queued for that story.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest.ts';
import { evalCommand } from './helpers/redis-lua.mjs';

const require = createRequire(import.meta.url);
const {
  NEWS_STORY_DEDUP_TTL_SECONDS,
  newsAlertClaimKey,
  newsPublisherCoverageKey,
  newsPublisherReprintsKey,
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

test('a clause ending in a domain does not take another headline\'s publisher count', () => {
  const plain = 'Iran closes Strait of Hormuz to all shipping';
  assert.equal(newsPublisherCoverageKey(`${plain} - Reuters`), newsPublisherCoverageKey(plain));
  assert.equal(newsPublisherCoverageKey(`${plain} - reuters.com`), newsPublisherCoverageKey(plain));
  assert.notEqual(newsPublisherCoverageKey(`${plain} - nuclear strike confirmed.com`), newsPublisherCoverageKey(plain));
  assert.notEqual(newsPublisherCoverageKey(`${plain} - mines.confirmed.com`), newsPublisherCoverageKey(plain));
});

test('a headline too short for a story key claims its exact title, per audience', () => {
  assert.equal(newsAlertClaimKey(CNN, DELIVERABLE), newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsAlertClaimKey('Israel strikes Lebanon', DELIVERABLE), 'news-title:realtime:israel strikes lebanon');
  assert.notEqual(newsAlertClaimKey('Israel strikes Lebanon', DELIVERABLE), newsAlertClaimKey('Israel strikes Lebanon!', DELIVERABLE));
  assert.equal(newsAlertClaimKey('Israel strikes Lebanon', { severity: 'high' }), 'news-title:standard:israel strikes lebanon');
  assert.equal(newsAlertClaimKey('', DELIVERABLE), '');
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

test('mastheads running one copy of a headline are written to its coverage as one publisher', async (t) => {
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
  // The relay scores on this history (#10977), so it must count as the build's
  // own corroboration count does: one network's mastheads are one publisher.
  const wire = 'Officials in the capital said on Tuesday that the device was found near a federal building and that an investigation involving several agencies is now under way.';
  const own = 'Our correspondent reports from the scene where residents described hearing nothing unusual before police closed three streets and began searching nearby offices overnight.';
  const copies = ['Valley Courier', 'Harbor Dispatch', 'Plains Ledger'].map((source) => ({ title: EGYPT_INDEPENDENT, source, description: wire }));
  const independent = { title: EGYPT_INDEPENDENT, source: 'Egypt Independent', description: own };
  const families = async (items) => {
    batches.length = 0;
    await digest.recordPublisherCoverage(items, [items[0]], Date.now(), Infinity);
    const [, , , ...scored] = batches.flat().find((cmd) => cmd[0] === 'ZADD');
    return scored.filter((_, i) => i % 2 === 1).sort();
  };
  assert.deepEqual(await families([...copies, independent]), ['label:egypt independent', 'label:harbor dispatch']);
  // The same member whatever order a build lists the mastheads in, so builds
  // and editions do not add one family each.
  assert.deepEqual(await families([independent, ...copies.reverse()]), ['label:egypt independent', 'label:harbor dispatch']);
});

test('an outlet running the wire headline is written to its coverage as the wire', async (t) => {
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
  const families = async (items) => {
    batches.length = 0;
    await digest.recordPublisherCoverage(items, [items[0]], Date.now(), Infinity);
    const [, , , ...scored] = batches.flat().find((cmd) => cmd[0] === 'ZADD');
    return scored.filter((_, i) => i % 2 === 1).sort();
  };
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  assert.deepEqual(await families([wire, { title: EGYPT_INDEPENDENT, source: 'Arab Times' }]), ['reuters']);
  assert.deepEqual(await families([{ title: EGYPT_INDEPENDENT, source: 'Arab Times' }, wire]), ['reuters']);
});

test('a reprint folds into its wire across coverage keys and across builds', async (t) => {
  const sets = new Map<string, Map<string, number>>();
  const apply = ([op, key, ...args]: (string | number)[]) => {
    if (op === 'MULTI' || op === 'EXEC') return { result: 'OK' };
    const members = sets.get(String(key)) ?? new Map<string, number>();
    sets.set(String(key), members);
    if (op === 'ZADD') {
      assert.equal(args.shift(), 'GT');
      for (let i = 0; i < args.length; i += 2) {
        const family = String(args[i + 1]);
        members.set(family, Math.max(Number(args[i]), members.get(family) ?? 0));
      }
    } else if (op === 'ZREM') {
      for (const family of args) members.delete(String(family));
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
  const stored = (title: string) => [...(sets.get(newsPublisherCoverageKey(title))?.keys() ?? [])].sort();
  const reprint = (source: string) => ({ title: EGYPT_INDEPENDENT, source });

  // "<headline> - AFP" keeps its credit in the coverage key, so the reprints' key holds no AFP item.
  const afp = { title: `${EGYPT_INDEPENDENT} - AFP`, source: 'Google News', originPublisher: 'AFP', originPublisherTrusted: true };
  const build = [afp, reprint('Arab Times'), reprint('Kansas City Star')];
  await digest.recordPublisherCoverage(build, build, Date.now(), Infinity);
  assert.deepEqual(stored(EGYPT_INDEPENDENT), ['afp']);

  // A build that sees the wire removes the outlet an earlier build wrote.
  sets.clear();
  await digest.recordPublisherCoverage([reprint('Arab Times')], [reprint('Arab Times')], Date.now() - 60_000, Infinity);
  assert.deepEqual(stored(EGYPT_INDEPENDENT), ['label:arab times']);
  const later = [{ title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' }, reprint('Arab Times')];
  await digest.recordPublisherCoverage(later, later, Date.now(), Infinity);
  assert.deepEqual(stored(EGYPT_INDEPENDENT), ['reuters']);
});

// A sorted-set store for the coverage writer and its readers.
function coverageStore() {
  const sets = new Map<string, Map<string, number>>();
  const expired: string[] = [];
  const run = ([op, key, ...args]: (string | number)[]) => {
    if (op === 'MULTI' || op === 'EXEC') return { result: 'OK' };
    if (op === 'EVAL') return { result: evalCommand([op, key, ...args], (verb: string, callArgs: string[]) => run([verb, ...callArgs]).result) };
    const members = sets.get(String(key)) ?? new Map<string, number>();
    if (op === 'ZSCORE') return { result: members.has(String(args[0])) ? String(members.get(String(args[0]))) : null };
    if (op === 'ZADD') {
      sets.set(String(key), members);
      assert.equal(args.shift(), 'GT');
      for (let i = 0; i < args.length; i += 2) {
        const family = String(args[i + 1]);
        members.set(family, Math.max(Number(args[i]), members.get(family) ?? 0));
      }
    } else if (op === 'ZREM') {
      for (const family of args) members.delete(String(family));
    } else if (op === 'ZRANGEBYSCORE') {
      const whole = args[0] === '-inf' && args[1] === '+inf';
      const after = whole ? -Infinity : Number(String(args[0]).slice(1));
      const until = whole ? Infinity : Number(args[1]);
      const hits = [...members].filter(([, seen]) => seen > after && seen <= until);
      return { result: args.includes('WITHSCORES') ? hits.flatMap(([family, seen]) => [family, String(seen)]) : hits.map(([family]) => family) };
    } else {
      assert.equal(op, 'EXPIRE');
      expired.push(`${key} ${args[0]}`);
    }
    return { result: 1 };
  };
  const pipeline = async (commands: (string | number)[][]) => commands.map(run);
  return { sets, run, pipeline, expired };
}

function useRedisEnv(t) {
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
}

test('an edition build without the wire copy does not add a folded reprint back to the count (#11434)', async (t) => {
  const { refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  const outlet = { title: EGYPT_INDEPENDENT, source: 'Arab Times' };
  const write = (at: number, ...items: object[]) => digest.recordPublisherCoverage(items, items, at, Infinity);
  const count = async (now: number) => {
    const event = { eventType: 'rss_alert', variant: 'full', payload: { title: EGYPT_INDEPENDENT, corroborationCount: 0 } };
    await refreshPublisherCounts([event], now, store.pipeline);
    return event.observedPublisherCount;
  };
  const start = Date.now() - 3_600_000;

  // The wire-aware build first, then an edition that carries only the outlet.
  await write(start, wire, outlet);
  await write(start + 60_000, outlet);
  assert.equal(await count(start + 120_000), 1);

  // The other order: the outlet-only build, then the wire-aware one.
  store.sets.clear();
  await write(start, outlet);
  await write(start + 60_000, wire, outlet);
  await write(start + 120_000, outlet);
  assert.equal(await count(start + 180_000), 1);

  // A second outlet that wrote its own copy of no wire still counts.
  await write(start + 240_000, { title: EGYPT_INDEPENDENT, source: 'Kansas City Star' });
  assert.equal(await count(start + 300_000), 2);

  // A day after the last wire build the wire leaves the window and its record
  // expires (EXPIRE, which this store does not model), so the outlet counts
  // again, beside the Kansas City Star.
  store.sets.delete(newsPublisherReprintsKey(newsPublisherCoverageKey(EGYPT_INDEPENDENT)));
  assert.equal(await count(start + 60_000 + 86_400_000 + 1), 2);
});

test('the reprint record lives while builds keep carrying the wire, without the reprint (#11434)', async (t) => {
  const { refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  const outlet = { title: EGYPT_INDEPENDENT, source: 'Arab Times' };
  const hour = 3_600_000;
  const start = Date.now() - 30 * hour;
  await digest.recordPublisherCoverage([wire, outlet], [wire, outlet], start, Infinity);
  // One edition carries only the wire, another only the outlet, every hour.
  const reprints = newsPublisherReprintsKey(newsPublisherCoverageKey(EGYPT_INDEPENDENT));
  const renewals: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const commands = JSON.parse(init.body);
    renewals.push(...commands.filter(([op, key]) => op === 'EXPIRE' && key === reprints).map(() => 'renewed'));
    return Response.json(commands.map(store.run));
  });
  for (let h = 1; h <= 26; h++) {
    const before = renewals.length;
    await digest.recordPublisherCoverage([wire], [wire], start + h * hour, Infinity);
    assert.equal(renewals.length, before + 1, 'a wire-only build renews the record');
    await digest.recordPublisherCoverage([outlet], [outlet], start + h * hour + 60_000, Infinity);
    assert.equal(renewals.length, before + 1, 'an outlet-only build does not');
  }
  const event = { eventType: 'rss_alert', variant: 'full', payload: { title: EGYPT_INDEPENDENT, corroborationCount: 0 } };
  await refreshPublisherCounts([event], start + 26 * hour + 120_000, store.pipeline);
  assert.equal(event.observedPublisherCount, 1);
});

test('each headline read together drops only its own reprints (#11434)', async (t) => {
  const { refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const now = Date.now();
  const plain = [{ title: SUN_ONLINE, source: 'SunOnline International' }, { title: SUN_ONLINE, source: 'Arab Times' }];
  await digest.recordPublisherCoverage(plain, plain, now - 120_000, Infinity);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  const outlet = { title: EGYPT_INDEPENDENT, source: 'Arab Times' };
  await digest.recordPublisherCoverage([wire, outlet], [wire, outlet], now - 120_000, Infinity);
  await digest.recordPublisherCoverage([outlet], [outlet], now - 60_000, Infinity);
  const events = [SUN_ONLINE, EGYPT_INDEPENDENT].map(title => ({ eventType: 'rss_alert', variant: 'full', payload: { title, corroborationCount: 0 } }));
  await refreshPublisherCounts(events, now, store.pipeline);
  assert.deepEqual(events.map(event => event.observedPublisherCount), [2, 1]);
});

test('identical short headlines from two outlets are not taken for a reprint (#11434)', async (t) => {
  const { refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  // Under four words the headline shares a coverage key but never folds.
  const SHORT = 'Gaza ceasefire collapses';
  const items = [{ title: SHORT, source: 'Reuters World' }, { title: SHORT, source: 'Arab Times' }];
  await digest.recordPublisherCoverage(items, items, Date.now() - 60_000, Infinity);
  await digest.recordPublisherCoverage([items[1]], [items[1]], Date.now() - 30_000, Infinity);
  const event = { eventType: 'rss_alert', variant: 'full', payload: { title: SHORT, corroborationCount: 0 } };
  await refreshPublisherCounts([event], Date.now(), store.pipeline);
  assert.equal(event.observedPublisherCount, 2);
});

test('a rewrite merge carries the reprint record with the coverage it copies (#11434)', async (t) => {
  const { mergeStoryCoverage, refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  const outlet = { title: EGYPT_INDEPENDENT, source: 'Arab Times' };
  const now = Date.now();
  await digest.recordPublisherCoverage([wire, outlet], [wire, outlet], now - 120_000, Infinity);
  await digest.recordPublisherCoverage([outlet], [outlet], now - 60_000, Infinity);
  // Another wording, carried by an outlet that wrote its own headline.
  await digest.recordPublisherCoverage([{ title: NDTV, source: 'NDTV' }], [{ title: NDTV, source: 'NDTV' }], now - 60_000, Infinity);
  const ndtv = { eventType: 'rss_alert', variant: 'full', severity: 'critical', payload: { title: NDTV, importanceScore: 82, corroborationCount: 0 } };
  const anchorId = `full:${newsPublisherCoverageKey(EGYPT_INDEPENDENT).split(':').pop()}`;
  assert.equal(await mergeStoryCoverage(ndtv, anchorId, store.pipeline), true);
  await refreshPublisherCounts([ndtv], now, store.pipeline);
  // Reuters and NDTV: the Arab Times reprint stays folded on the merged wording.
  assert.equal(ndtv.observedPublisherCount, 2);
});

test('a rewrite merge counts an outlet where it wrote its own wording, never where it reprinted (#11434)', async (t) => {
  const { mergeStoryCoverage, refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  const now = Date.now();
  await digest.recordPublisherCoverage([wire, { title: EGYPT_INDEPENDENT, source: 'Arab Times' }], [wire], now - 120_000, Infinity);
  // Arab Times also ran the story under its own headline.
  const own = { title: NDTV, source: 'Arab Times' };
  await digest.recordPublisherCoverage([own], [own], now - 60_000, Infinity);
  const event = { eventType: 'rss_alert', variant: 'full', severity: 'critical', payload: { title: NDTV, importanceScore: 82, corroborationCount: 0 } };
  const anchorId = `full:${newsPublisherCoverageKey(EGYPT_INDEPENDENT).split(':').pop()}`;
  assert.equal(await mergeStoryCoverage(event, anchorId, store.pipeline), true);
  await refreshPublisherCounts([event], now, store.pipeline);
  // Reuters, and Arab Times for its own wording.
  assert.equal(event.observedPublisherCount, 2);
  // On the wire's headline Arab Times stays folded: its score there may come
  // from a reprint, which must never count once its own wording expires.
  const anchor = { ...event, payload: { ...event.payload, title: EGYPT_INDEPENDENT } };
  await refreshPublisherCounts([anchor], now, store.pipeline);
  assert.equal(anchor.observedPublisherCount, 1);
});

test('a rewrite merge that copies a wire in renews that wording\'s reprint record (#11434)', async (t) => {
  const { mergeStoryCoverage } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const now = Date.now();
  // NDTV's wording holds a folded reprint from an earlier wire build, and now
  // only NDTV; the wire's wording carries Reuters.
  const ndtvWire = [{ title: `${NDTV} - Reuters`, source: 'Reuters World' }, { title: NDTV, source: 'Kansas City Star' }];
  await digest.recordPublisherCoverage(ndtvWire, ndtvWire, now - 20 * 3_600_000, Infinity);
  await digest.recordPublisherCoverage([{ title: NDTV, source: 'NDTV' }], [{ title: NDTV, source: 'NDTV' }], now - 60_000, Infinity);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  await digest.recordPublisherCoverage([wire], [wire], now - 60_000, Infinity);
  const reprints = (title: string) => newsPublisherReprintsKey(newsPublisherCoverageKey(title));
  assert.deepEqual([...(store.sets.get(reprints(NDTV))?.keys() ?? [])], ['label:kansas city star']);
  const event = { eventType: 'rss_alert', variant: 'full', severity: 'critical', payload: { title: NDTV, importanceScore: 82, corroborationCount: 0 } };
  const anchorId = `full:${newsPublisherCoverageKey(EGYPT_INDEPENDENT).split(':').pop()}`;
  store.expired.length = 0;
  assert.equal(await mergeStoryCoverage(event, anchorId, store.pipeline, now), true);
  // Reuters crossed both ways (NDTV's wording still holds the earlier wire
  // sighting), so each record gets the writer's full day, and none is cleared.
  const renewed = () => store.expired.filter(entry => entry.startsWith('news:publisher-reprints:')).sort();
  assert.deepEqual(renewed(), [`${reprints(NDTV)} 86400`, `${reprints(EGYPT_INDEPENDENT)} 86400`].sort());
  assert.deepEqual([...(store.sets.get(reprints(NDTV))?.keys() ?? [])], ['label:kansas city star']);

  // A merge that copies no wire renews no record.
  const plain = [{ title: SUN_ONLINE, source: 'SunOnline International' }];
  await digest.recordPublisherCoverage(plain, plain, now - 60_000, Infinity);
  const sun = { ...event, payload: { ...event.payload, title: SUN_ONLINE } };
  const ndtvId = `full:${newsPublisherCoverageKey(NDTV).split(':').pop()}`;
  store.sets.delete(newsPublisherCoverageKey(NDTV));
  await digest.recordPublisherCoverage([{ title: NDTV, source: 'NDTV' }], [{ title: NDTV, source: 'NDTV' }], now - 60_000, Infinity);
  store.expired.length = 0;
  assert.equal(await mergeStoryCoverage(sun, ndtvId, store.pipeline, now), true);
  assert.deepEqual(renewed(), []);
});

test('an expired sighting on the other wording does not clear a current reprint record (#11434)', async (t) => {
  const { mergeStoryCoverage, refreshPublisherCounts } = await import('../scripts/lib/news-alert-coverage.mjs');
  const store = coverageStore();
  t.mock.method(globalThis, 'fetch', async (_url, init) => Response.json(JSON.parse(init.body).map(store.run)));
  useRedisEnv(t);
  const wire = { title: `${EGYPT_INDEPENDENT} - Reuters`, source: 'Reuters World' };
  const reprint = { title: EGYPT_INDEPENDENT, source: 'Arab Times' };
  const now = Date.now();
  // Arab Times wrote its own wording 25 hours ago; NDTV keeps that key alive.
  await digest.recordPublisherCoverage([{ title: NDTV, source: 'Arab Times' }], [{ title: NDTV, source: 'Arab Times' }], now - 25 * 3_600_000, Infinity);
  await digest.recordPublisherCoverage([{ title: NDTV, source: 'NDTV' }], [{ title: NDTV, source: 'NDTV' }], now - 60_000, Infinity);
  // Today Arab Times reprints Reuters, and an edition without the wire writes it back.
  await digest.recordPublisherCoverage([wire, reprint], [wire, reprint], now - 120_000, Infinity);
  await digest.recordPublisherCoverage([reprint], [reprint], now - 60_000, Infinity);
  const event = { eventType: 'rss_alert', variant: 'full', severity: 'critical', payload: { title: NDTV, importanceScore: 82, corroborationCount: 0 } };
  const anchorId = `full:${newsPublisherCoverageKey(EGYPT_INDEPENDENT).split(':').pop()}`;
  assert.equal(await mergeStoryCoverage(event, anchorId, store.pipeline, now), true);
  const anchor = { ...event, payload: { ...event.payload, title: EGYPT_INDEPENDENT } };
  await refreshPublisherCounts([anchor, event], now, store.pipeline);
  // Reuters and NDTV on both wordings: the reprint stays folded.
  assert.deepEqual([anchor.observedPublisherCount, event.observedPublisherCount], [2, 2]);
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

test('a rejected copy cannot claim the key a local copy needs (#10977)', () => {
  // Country-scoped rules take local news from 78. An earlier copy at 77 reaches
  // nobody, so it must not claim the key of a copy at 78, and a later copy at
  // 82 or more still gets its own key for global delivery.
  const local = newsStoryKey(CNN, { severity: 'critical', importanceScore: 78, primaryCountryCode: 'US' });
  assert.notEqual(newsStoryKey(CNN, { severity: 'critical', importanceScore: 77, primaryCountryCode: 'US' }), local);
  assert.equal(newsStoryKey(CNN, { severity: 'critical', importanceScore: 81, primaryCountryCode: 'US' }), local);
  assert.notEqual(local, newsStoryKey(CNN, DELIVERABLE));
});

test('a local-band copy that names no single country cannot claim the local key (#10977)', () => {
  const TOKYO = 'Missile strike hits Tokyo port as Japan scrambles jets';
  const twoCountries = newsStoryKey(`${TOKYO} - France 24`, { severity: 'critical', importanceScore: 79 });
  const local = newsStoryKey(`${TOKYO} - Reuters`, { severity: 'critical', importanceScore: 79, primaryCountryCode: 'JP' });
  assert.ok(local.startsWith('news-story:local:'));
  assert.notEqual(twoCountries, local);
});
