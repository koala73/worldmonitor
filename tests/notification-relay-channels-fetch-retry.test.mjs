/**
 * SM-115: the real-time path claims the per-user dedup key (SET NX EX 1800)
 * before it reads the user's channels from Convex /relay/channels. When that
 * read failed, the claim stayed, so the alert was dropped on every channel for
 * that user for 30 minutes although nothing had been sent.
 *
 * A channel-read failure is a pre-send failure: the relay now releases its own
 * claim (compare-and-delete on the token it wrote) and re-queues the event the
 * same way it does after an alert-rules read failure. Send failures keep the
 * documented at-most-once policy: the claim stays and the next delivery of the
 * same event is suppressed.
 *
 * Drives the REAL processEvent. One fetch stub serves Convex, Telegram and a
 * small in-memory Redis that implements SET NX, GET, LPUSH and the pinned
 * compare-and-delete script.
 *
 * Run: node --import tsx --test tests/notification-relay-channels-fetch-retry.test.mjs
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { COMPARE_AND_DELETE_SCRIPT } = require(resolve(__dirname, '..', 'scripts', 'shared', 'compare-and-delete-script.cjs'));

let relay;
let originalFetch;
let originalSetTimeout;
before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  originalFetch = globalThis.fetch;
  originalSetTimeout = globalThis.setTimeout;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

let titleSeq = 0;
function rssEvent(extra = {}) {
  titleSeq += 1;
  return {
    eventType: 'rss_alert',
    severity: 'critical',
    payload: { title: `Channel retry headline ${titleSeq}`, source: 'Reuters' },
    ...extra,
  };
}

function rule(userId) {
  return { userId, digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', channels: ['telegram'], variant: 'full' };
}

const telegramChannel = (chatId) => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId }];

/**
 * A stateful harness: `redis` persists across processEvent calls so a second
 * delivery of the same event sees the claim the first one left behind.
 *
 * `channels(userId)` returns a Response-like object, or throws to model a
 * network error or timeout. `telegram(chatId)` does the same for sends.
 */
function harness({ users = ['user-1'], channels, telegram, dedupDown = () => false, dedupLostResponse = () => false } = {}) {
  const redis = new Map();
  const queue = [];
  const sent = [];
  const evals = [];
  const sleeps = [];
  const logs = [];

  const upstash = (parts) => {
    const [cmd, ...args] = parts;
    if (cmd === 'SET') {
      const [key, value, ...opts] = args;
      if (opts.includes('NX') && redis.has(key)) return null;
      redis.set(key, value);
      return 'OK';
    }
    if (cmd === 'GET') return redis.has(args[0]) ? redis.get(args[0]) : null;
    if (cmd === 'LPUSH') { queue.push(JSON.parse(args[1])); return queue.length; }
    if (cmd === 'EVAL') {
      evals.push(args);
      assert.equal(args[0], COMPARE_AND_DELETE_SCRIPT, 'release must send the pinned compare-and-delete script');
      const [, numKeys, key, token] = args;
      assert.equal(String(numKeys), '1');
      if (redis.get(key) === token) { redis.delete(key); return 1; }
      return 0;
    }
    return null;
  };

  const fetchStub = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'stub.upstash.io') {
      const parts = init?.body
        ? JSON.parse(init.body)
        : parsed.pathname.split('/').slice(1).map(decodeURIComponent);
      if (parts[0] === 'SET' && parts[1].startsWith('wm:notif:dedup:') && dedupDown()) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (parts[0] === 'SET' && parts[1].startsWith('wm:notif:dedup:') && dedupLostResponse()) {
        // Redis commits the write, then the response is lost.
        upstash(parts);
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return { ok: true, status: 200, json: async () => ({ result: upstash(parts) }) };
    }
    if (parsed.pathname.includes('/relay/enabled-rules')) {
      return { ok: true, status: 200, json: async () => users.map(rule) };
    }
    if (parsed.pathname.includes('/relay/entitlement')) return { ok: true, status: 200, json: async () => ({ tier: 1 }) };
    if (parsed.pathname.includes('/relay/channels')) {
      const { userId } = JSON.parse(init.body);
      return channels(userId, { redis });
    }
    if (parsed.hostname === 'api.telegram.org') {
      const { chat_id: chatId } = JSON.parse(init.body);
      const res = await telegram(chatId);
      if (res.ok) sent.push(chatId);
      return res;
    }
    return { ok: true, status: 200, json: async () => ({ result: null }) };
  };

  async function deliver(event) {
    const silence = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...args) => { logs.push(args.join(' ')); };
    globalThis.setTimeout = (fn, ms) => { sleeps.push(ms); return originalSetTimeout(fn, 0); };
    globalThis.fetch = fetchStub;
    try {
      await relay.processEvent(event);
    } finally {
      [console.log, console.warn, console.error] = silence;
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    }
  }

  const dedupKeys = () => [...redis.keys()].filter((k) => k.startsWith('wm:notif:dedup:'));
  return { redis, queue, sent, evals, sleeps, logs, deliver, dedupKeys };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const httpError = (status) => ({ ok: false, status, json: async () => ({}) });
const telegramOk = async () => ok({ ok: true });

describe('relay releases the dedup claim when the channel read fails (SM-115)', () => {
  for (const [label, failure] of [
    ['non-2xx', () => httpError(503)],
    ['network error', () => { throw new TypeError('fetch failed'); }],
    ['timeout', () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }],
  ]) {
    it(`${label}: releases the claim and re-queues, so the retry delivers`, async () => {
      let channelsUp = false;
      const h = harness({
        channels: (userId) => (channelsUp ? ok(telegramChannel(`chat-${userId}`)) : failure()),
        telegram: telegramOk,
      });
      const event = rssEvent();

      await h.deliver(event);
      assert.deepEqual(h.sent, [], 'nothing can be sent without channels');
      assert.deepEqual(h.dedupKeys(), [], `claim must be released, still held: ${h.dedupKeys()}\n${h.logs.join('\n')}`);
      assert.equal(h.queue.length, 1, `event must be re-queued\n${h.logs.join('\n')}`);
      assert.equal(h.queue[0].channelsFetchAttempts, 1);
      assert.deepEqual(h.queue[0].payload, event.payload);
      assert.ok(h.sleeps.some((ms) => ms >= 2000), `expected a back-off sleep, got ${JSON.stringify(h.sleeps)}`);

      channelsUp = true;
      await h.deliver(h.queue.shift());
      assert.deepEqual(h.sent, ['chat-user-1'], 'the retry must deliver, not hit the dedup claim');
      assert.equal(h.dedupKeys().length, 1, 'a delivered retry claims the key again');
      assert.equal(h.queue.length, 0);
    });
  }

  it('a later publish of the same event is not suppressed after a channel-read failure', async () => {
    let channelsUp = false;
    const h = harness({
      channels: (userId) => (channelsUp ? ok(telegramChannel(`chat-${userId}`)) : httpError(500)),
      telegram: telegramOk,
    });
    const event = rssEvent();
    await h.deliver(event);
    h.queue.length = 0; // ignore the re-queue; model an independent re-publish
    channelsUp = true;
    await h.deliver({ ...event });
    assert.deepEqual(h.sent, ['chat-user-1']);
  });

  it('only deletes its own claim (compare-and-delete on the token it wrote)', async () => {
    const h = harness({
      // Another worker replaced the claim between SET NX and the release.
      channels: (_userId, { redis }) => {
        for (const key of redis.keys()) if (key.startsWith('wm:notif:dedup:')) redis.set(key, 'other-worker-token');
        return httpError(503);
      },
      telegram: telegramOk,
    });
    await h.deliver(rssEvent());
    assert.equal(h.evals.length, 1, 'release goes through the compare-and-delete script');
    assert.notEqual(h.evals[0][3], '1', 'claim value must be a per-claim token, not a constant');
    assert.equal(h.dedupKeys().length, 1, "another worker's claim must survive");
    assert.equal(h.redis.get(h.dedupKeys()[0]), 'other-worker-token');
    assert.equal(h.queue.length, 0, 'nothing was released, so a re-queue would only hit the dedup claim');
  });

  it('re-queues once per event and retries only the user whose read failed', async () => {
    let user2Up = false;
    const h = harness({
      users: ['user-1', 'user-2'],
      channels: (userId) => (userId === 'user-2' && !user2Up ? httpError(502) : ok(telegramChannel(`chat-${userId}`))),
      telegram: telegramOk,
    });
    await h.deliver(rssEvent());
    assert.deepEqual(h.sent, ['chat-user-1']);
    assert.equal(h.queue.length, 1);

    user2Up = true;
    await h.deliver(h.queue.shift());
    assert.deepEqual(h.sent, ['chat-user-1', 'chat-user-2'], 'user-1 stays deduped; user-2 gets the retry');
  });

  it('fail-open path (SET NX errored): releases the in-process fallback so the retry delivers', async () => {
    let channelsUp = false;
    const h = harness({
      dedupDown: () => true,
      channels: (userId) => (channelsUp ? ok(telegramChannel(`chat-${userId}`)) : httpError(503)),
      telegram: telegramOk,
    });
    await h.deliver(rssEvent());
    assert.deepEqual(h.sent, []);
    assert.equal(h.evals.length, 1, 'the Redis key is compare-and-deleted in case the SET committed');
    assert.match(h.evals[0][2], /^wm:notif:dedup:user-1:[0-9a-f]{64}$/, 'release targets the user dedup key');
    assert.notEqual(h.evals[0][3], '1', 'release compares against the per-claim token');
    assert.deepEqual(h.dedupKeys(), [], 'no Redis claim was written');
    assert.equal(h.queue.length, 1);

    channelsUp = true;
    await h.deliver(h.queue.shift());
    assert.deepEqual(h.sent, ['chat-user-1'], 'the fail-open fallback must not suppress the retry');
  });

  it('fail-open after a lost SET NX response: also compare-and-deletes the committed Redis claim', async () => {
    let channelsUp = false;
    let lostOnce = true;
    const h = harness({
      dedupLostResponse: () => { const lost = lostOnce; lostOnce = false; return lost; },
      channels: (userId) => (channelsUp ? ok(telegramChannel(`chat-${userId}`)) : httpError(503)),
      telegram: telegramOk,
    });
    await h.deliver(rssEvent());
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.dedupKeys(), [], `the committed claim must be released\n${h.logs.join('\n')}`);
    assert.equal(h.queue.length, 1);

    channelsUp = true;
    await h.deliver(h.queue.shift());
    assert.deepEqual(h.sent, ['chat-user-1'], 'the retry must not hit a claim nobody delivered on');
  });

  it('counts attempts and drops loudly after the cap, leaving the claim released', async () => {
    const h = harness({ channels: () => httpError(503), telegram: telegramOk });
    await h.deliver(rssEvent({ channelsFetchAttempts: relay.CHANNELS_FETCH_RETRY_MAX }));
    assert.equal(h.queue.length, 0);
    assert.deepEqual(h.dedupKeys(), []);
    assert.ok(h.logs.some((l) => /Dropping rss_alert after \d+ channel fetch failures/.test(l)), h.logs.join('\n'));
  });
});

describe('controls: send failures and successful sends keep the dedup claim', () => {
  it('send failure: claim stays and the next delivery is suppressed (at-most-once)', async () => {
    let telegramUp = false;
    const h = harness({
      channels: (userId) => ok(telegramChannel(`chat-${userId}`)),
      telegram: async () => (telegramUp ? ok({ ok: true }) : httpError(500)),
    });
    const event = rssEvent();
    await h.deliver(event);
    assert.deepEqual(h.sent, []);
    assert.equal(h.dedupKeys().length, 1, 'a send failure must not release the claim');
    assert.equal(h.evals.length, 0);
    assert.equal(h.queue.length, 0, 'a send failure must not re-queue');

    telegramUp = true;
    await h.deliver({ ...event });
    assert.deepEqual(h.sent, [], 'same event within the window stays suppressed');
  });

  it('send throws: claim stays and nothing is re-queued', async () => {
    const h = harness({
      channels: (userId) => ok(telegramChannel(`chat-${userId}`)),
      telegram: async () => { throw new TypeError('fetch failed'); },
    });
    await h.deliver(rssEvent());
    assert.equal(h.dedupKeys().length, 1);
    assert.equal(h.queue.length, 0);
  });

  it('success: delivers once and dedups the next delivery of the same event', async () => {
    const h = harness({ channels: (userId) => ok(telegramChannel(`chat-${userId}`)), telegram: telegramOk });
    const event = rssEvent();
    await h.deliver(event);
    await h.deliver({ ...event });
    assert.deepEqual(h.sent, ['chat-user-1']);
    assert.equal(h.evals.length, 0);
    assert.equal(h.queue.length, 0);
  });

  it('an empty but successful channel read keeps the claim (nothing to retry)', async () => {
    const h = harness({ channels: () => ok([]), telegram: telegramOk });
    await h.deliver(rssEvent());
    assert.equal(h.dedupKeys().length, 1);
    assert.equal(h.queue.length, 0);
  });
});
