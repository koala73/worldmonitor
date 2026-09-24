import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildEnvelope } from '../scripts/_seed-envelope-source.mjs';
import { withRetry } from '../scripts/_seed-utils.mjs';
import {
  CANONICAL_KEY,
  LAST_GOOD_MAX_AGE_MS,
  LIVE_VIDEO_ACTIVATION_KEY,
  MAX_CHANNELS,
  declareRecords,
  guardRedisReadOnly,
  loadRefreshChannels,
  makeFetchAll,
  markLiveVideoActivated,
  mergeResolved,
  resolveRunProxy,
  validateResolvedPayload,
} from '../scripts/seed-live-video-resolved.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEEDER = resolve(repoRoot, 'scripts/seed-live-video-resolved.mjs');
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const ID = (n) => `UC${String(n).padStart(22, '0')}`;
const VIDEO = (n) => `vid${String(n).padStart(8, '0')}`;

const live = (id, videoId) => ({ status: 'live', reason: null, videoId, channelId: id, title: 'News live', playableInEmbed: true });
const notLive = (id, reason = 'not-live') => ({ status: 'not-live', reason, videoId: null, channelId: id, title: null });
const unreadable = (id, reason = 'timeout', extra = {}) => ({ status: 'unreadable', reason, videoId: null, channelId: id, title: null, ...extra });

describe('mergeResolved (AE3)', () => {
  const merge = (previous, results, listedIds = [...results.keys()]) => mergeResolved(previous, results, { now: NOW, listedIds });

  it('keeps an unreadable channel\'s previous id while it is at most 36 h old', () => {
    const out = merge({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - 10 * HOUR) } }, new Map([[ID(1), unreadable(ID(1))]]));
    assert.deepEqual(out.channels, { [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - 10 * HOUR) } });
    assert.equal(out.stats.keptLastGood, 1);
  });

  it('retains last-good for 36 h (the player ignores entries past the same age; PR3 pins the two equal)', () => {
    assert.equal(LAST_GOOD_MAX_AGE_MS, 36 * HOUR);
  });

  it('drops the previous id once it is older than 36 h, keeps it at exactly 36 h', () => {
    const at = (age) => merge({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - age) } }, new Map([[ID(1), unreadable(ID(1))]]));
    assert.deepEqual(at(40 * HOUR).channels, {});
    assert.equal(at(40 * HOUR).stats.dropped, 1);
    assert.deepEqual(at(LAST_GOOD_MAX_AGE_MS + 1).channels, {});
    assert.equal(Object.keys(at(LAST_GOOD_MAX_AGE_MS).channels).length, 1);
  });

  it('drops a channel that read cleanly as not live, even with a fresh previous id', () => {
    const out = merge({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - HOUR) } }, new Map([[ID(1), notLive(ID(1), 'upcoming')]]));
    assert.deepEqual(out.channels, {});
    assert.deepEqual(out.stats, { attempted: 1, live: 0, notLive: 1, unreadable: 0, keptLastGood: 0, dropped: 1 });
  });

  it('replaces the previous id with today\'s live id at resolvedAt = now', () => {
    const out = merge({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - HOUR) } }, new Map([[ID(1), live(ID(1), VIDEO(2))]]));
    assert.deepEqual(out.channels, { [ID(1)]: { videoId: VIDEO(2), resolvedAt: iso(NOW) } });
    assert.equal(out.resolvedAt, iso(NOW));
  });

  it('drops a channel the generated list no longer names', () => {
    const out = merge(
      { [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - HOUR) }, [ID(9)]: { videoId: VIDEO(9), resolvedAt: iso(NOW - HOUR) } },
      new Map([[ID(1), unreadable(ID(1))]]),
    );
    assert.deepEqual(Object.keys(out.channels), [ID(1)]);
    assert.equal(out.stats.dropped, 1);
  });

  it('publishes only videoId and resolvedAt, and ignores a malformed previous entry', () => {
    const out = merge(
      { [ID(1)]: { videoId: 'https://evil/x.m3u8', resolvedAt: iso(NOW - HOUR) }, [ID(2)]: { videoId: VIDEO(2), resolvedAt: 'yesterday' } },
      new Map([[ID(1), unreadable(ID(1))], [ID(2), unreadable(ID(2))], [ID(3), live(ID(3), VIDEO(3))]]),
    );
    assert.deepEqual(out.channels, { [ID(3)]: { videoId: VIDEO(3), resolvedAt: iso(NOW) } });
    assert.ok(validateResolvedPayload(out));
    assert.equal(merge(null, new Map([[ID(1), unreadable(ID(1))]])).stats.unreadable, 1);
  });
});

describe('validateResolvedPayload', () => {
  const payload = (channels, stats = {}) => ({
    resolvedAt: iso(NOW),
    channels,
    stats: { attempted: 1, live: 1, notLive: 0, unreadable: 0, keptLastGood: 0, dropped: 0, ...stats },
  });
  const one = { [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW) } };

  it('accepts the merged shape', () => {
    assert.equal(validateResolvedPayload(payload(one)), true);
  });

  it('rejects a short video id, a key that is not a channel id, and a resolvedAt that is not a date', () => {
    assert.equal(validateResolvedPayload(payload({ [ID(1)]: { videoId: 'abcdefghij', resolvedAt: iso(NOW) } })), false);
    assert.equal(validateResolvedPayload(payload({ '@handle': { videoId: VIDEO(1), resolvedAt: iso(NOW) } })), false);
    assert.equal(validateResolvedPayload(payload({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: 'yesterday' } })), false);
  });

  it('rejects anything that would widen the public payload (title, slots, extra top-level fields)', () => {
    assert.equal(validateResolvedPayload(payload({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW), title: 'x' } })), false);
    assert.equal(validateResolvedPayload(payload({ [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW), slots: ['live-news/x'] } })), false);
    assert.equal(validateResolvedPayload({ ...payload(one), titles: {} }), false);
    assert.equal(validateResolvedPayload(payload(one, { live: 1.5 })), false);
  });

  it('rejects an empty map when channels were attempted, accepts it when none were', () => {
    assert.equal(validateResolvedPayload(payload({})), false);
    assert.equal(validateResolvedPayload(payload({}, { attempted: 0, live: 0 })), true);
  });

  it('declareRecords counts channels with a video id', () => {
    assert.equal(declareRecords(payload(one)), 1);
    assert.equal(declareRecords(payload({})), 0);
    assert.equal(declareRecords(null), 0);
  });
});

describe('makeFetchAll', () => {
  const channels = [ID(1), ID(2), ID(3)].map((channelId) => ({ channelId, slots: ['live-news/x'] }));
  const previousChannels = {
    [ID(1)]: { videoId: VIDEO(1), resolvedAt: iso(NOW - 10 * HOUR) },
    [ID(2)]: { videoId: VIDEO(2), resolvedAt: iso(NOW - 10 * HOUR) },
  };
  const previousPayload = { resolvedAt: iso(NOW - 10 * HOUR), channels: previousChannels, stats: { attempted: 3, live: 2, notLive: 1, unreadable: 0, keptLastGood: 0, dropped: 0 } };
  const quiet = () => {};

  describe('last-good read through a real seed envelope (fake Upstash)', () => {
    const env = {};
    let realFetch;
    beforeEach(() => {
      realFetch = globalThis.fetch;
      for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WM_SEED_RETRY_DELAY_MS']) env[name] = process.env[name];
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.test';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
      process.env.WM_SEED_RETRY_DELAY_MS = '1';
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const fakeUpstash = (respond) => {
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET' });
        return respond(String(url));
      };
      return requests;
    };

    it('keeps the previous ids of unreadable channels (the reader must not unwrap twice)', async () => {
      const envelope = buildEnvelope({ fetchedAt: NOW - 10 * HOUR, recordCount: 2, sourceVersion: 'youtube-channel-live-page-v1', schemaVersion: 1, state: 'OK', data: previousPayload });
      const requests = fakeUpstash(() => new Response(JSON.stringify({ result: JSON.stringify(envelope) }), { status: 200 }));
      const fetchAll = makeFetchAll({
        channels,
        fetchPage: async (id) => (id === ID(3) ? live(id, VIDEO(3)) : unreadable(id)),
        now: () => NOW,
        log: quiet,
      });
      const payload = await fetchAll();
      assert.deepEqual(requests, [{ url: `https://fake-upstash.test/get/${encodeURIComponent(CANONICAL_KEY)}`, method: 'GET' }]);
      assert.deepEqual(payload.channels, { ...previousChannels, [ID(3)]: { videoId: VIDEO(3), resolvedAt: iso(NOW) } });
      assert.equal(payload.stats.keptLastGood, 2);
      assert.ok(validateResolvedPayload(payload));
    });

    it('rejects when Redis answers HTTP 500, instead of publishing a map without last-good', async () => {
      fakeUpstash(() => new Response('upstream down', { status: 500 }));
      let pages = 0;
      const fetchAll = makeFetchAll({ channels, fetchPage: async (id) => {
        pages++;
        return live(id, VIDEO(3));
      }, now: () => NOW, log: quiet });
      await assert.rejects(fetchAll(), /HTTP 500/);
      assert.equal(pages, 0, 'no channel page is fetched before last-good is known');
    });
  });

  it('AE4: every page unreadable throws once, nonRetryable, and withRetry makes one pass', async () => {
    const calls = new Map();
    const fetchAll = makeFetchAll({
      channels,
      readPrevious: async () => previousPayload,
      fetchPage: async (id) => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        return unreadable(id, 'http-429');
      },
      now: () => NOW,
      log: quiet,
    });
    const error = await withRetry(fetchAll, 3, 1).then(() => null, (err) => err);
    assert.ok(error, 'fetchAll must throw');
    assert.equal(error.nonRetryable, true);
    assert.match(error.message, /every channel page was unreadable \(3\)/);
    assert.deepEqual([...calls.values()], [1, 1, 1], 'one pass, not four');
  });

  it('passes the proxy attempt through, so a dead sticky exit rotates to the next session', async () => {
    const attempts = [];
    const session = { current: 0 };
    const fetchAll = makeFetchAll({
      channels: channels.slice(0, 1),
      readPrevious: async () => null,
      fetchPage: async (id, { attempt }) => {
        attempts.push(attempt);
        return attempt === 0 ? unreadable(id, 'fetch-error', { proxyFailure: true }) : live(id, VIDEO(1));
      },
      session,
      now: () => NOW,
      log: quiet,
    });
    const payload = await fetchAll();
    assert.deepEqual(attempts, [0, 1]);
    assert.equal(session.current, 1);
    assert.deepEqual(Object.keys(payload.channels), [ID(1)]);
  });

  it('logs titles and slots but never puts them in the payload', async () => {
    const lines = [];
    const fetchAll = makeFetchAll({ channels, readPrevious: async () => null, fetchPage: async (id) => live(id, VIDEO(7)), now: () => NOW, log: (line) => lines.push(line) });
    const payload = await fetchAll();
    assert.ok(lines.some((line) => line.includes('"News live"') && line.includes('live-news/x')));
    assert.doesNotMatch(JSON.stringify(payload), /News live|live-news/);
  });
});

describe('resolveRunProxy', () => {
  it('returns the parseProxyConfig route for the raw value, host not rewritten to the curl endpoint', () => {
    assert.deepEqual(resolveRunProxy('gate.decodo.com:7000:u:p'), {
      proxyUrl: 'gate.decodo.com:7000:u:p',
      route: { host: 'gate.decodo.com', port: 7000, auth: 'u:p', tls: true },
    });
    assert.deepEqual(resolveRunProxy('http://u:p@gate.decodo.com:7000').route, { host: 'gate.decodo.com', port: 7000, auth: 'u:p', tls: false });
  });

  it('returns no route for an unset or unparseable value', () => {
    assert.deepEqual(resolveRunProxy(undefined), { proxyUrl: null, route: null });
    assert.deepEqual(resolveRunProxy('  '), { proxyUrl: null, route: null });
    assert.equal(resolveRunProxy('garbage').route, null);
  });

  it('reads LIVE_VIDEO_PROXY_URL first and falls back to PROXY_URL, in the shape the registry test derives', () => {
    const source = readFileSync(SEEDER, 'utf8');
    assert.match(source, /resolveRunProxy\(process\.env\.LIVE_VIDEO_PROXY_URL \|\| process\.env\.PROXY_URL\)/);
    assert.match(source, /fetchChannelLivePage\(id, \{ proxyUrl, attempt \}\)/, 'the raw value and the attempt reach the resolver, so sticky sessions rotate');
  });

  it('exits 0 with NO SOURCE on Railway when neither variable is set, before touching Redis', () => {
    const env = { PATH: process.env.PATH, RAILWAY_ENVIRONMENT: 'production', NODE_TEST_CONTEXT: 'child-v8' };
    const child = spawnSync(process.execPath, [SEEDER], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /NO SOURCE: LIVE_VIDEO_PROXY_URL\/PROXY_URL unset/);
  });
});

describe('guardRedisReadOnly (--dry-run)', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('lets key reads through and refuses every other Redis request', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response('{}');
    };
    const counts = { reads: 0, blocked: 0 };
    guardRedisReadOnly('https://fake-upstash.test', counts);
    await globalThis.fetch(`https://fake-upstash.test/get/${encodeURIComponent(CANONICAL_KEY)}`);
    await assert.rejects(globalThis.fetch('https://fake-upstash.test/pipeline', { method: 'POST', body: '[]' }), /dry run: refused a Redis write/);
    await assert.rejects(globalThis.fetch('https://fake-upstash.test/set/k/v'), /dry run: refused/);
    await globalThis.fetch('https://www.youtube.com/channel/x/live');
    assert.deepEqual(counts, { reads: 1, blocked: 2 });
    assert.deepEqual(seen, [`GET https://fake-upstash.test/get/${encodeURIComponent(CANONICAL_KEY)}`, 'GET https://www.youtube.com/channel/x/live']);
  });
});

describe('loadRefreshChannels', () => {
  it('reads the committed generated list', () => {
    const channels = loadRefreshChannels();
    assert.ok(channels.length > 0 && channels.length <= MAX_CHANNELS);
    assert.ok(channels.every((entry) => /^UC[A-Za-z0-9_-]{22}$/.test(entry.channelId) && entry.slots.length > 0));
  });

  it('refuses a list above the cap or with a malformed id', () => {
    const many = Array.from({ length: MAX_CHANNELS + 1 }, (_, n) => ({ channelId: ID(n), slots: [] }));
    assert.throws(() => loadRefreshChannels(JSON.stringify({ channels: many })), /more than 60/);
    assert.throws(() => loadRefreshChannels(JSON.stringify({ channels: [{ channelId: '@handle' }] })), /not a channel id/);
  });
});

describe('activation marker (health deployment-order bridge)', () => {
  let realFetch;
  const env = {};
  beforeEach(() => {
    realFetch = globalThis.fetch;
    for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) env[name] = process.env[name];
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('SETs the durable marker health reads, with no TTL', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };
    await markLiveVideoActivated();
    assert.equal(LIVE_VIDEO_ACTIVATION_KEY, 'seed-activated:live-video:resolved');
    assert.deepEqual(bodies, [{ url: 'https://fake-upstash.test', body: ['SET', LIVE_VIDEO_ACTIVATION_KEY, '1'] }]);
  });

  it('never fails a run that already published when the marker write fails', async () => {
    globalThis.fetch = async () => new Response('down', { status: 500 });
    await markLiveVideoActivated();
  });

  it('is wired as the runSeed afterPublish hook', () => {
    assert.match(readFileSync(SEEDER, 'utf8'), /afterPublish: markLiveVideoActivated,/);
  });
});
