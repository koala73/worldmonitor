/**
 * Strix pentest 2026-10-27 ("unbounded notification/alert rules"), relay half:
 * when /relay/enabled-rules fails — the shared cross-tenant read tripped the
 * Convex limit, or Convex is down — processEvent used to drop the event. It
 * now re-queues the event (LPUSH behind the backlog) with an attempt counter
 * and drops only after RULES_FETCH_RETRY_MAX attempts, loudly.
 *
 * Drives the REAL processEvent with the loader stubs of the sibling relay
 * suites; Upstash and Convex are both served by one fetch stub.
 *
 * Run: node --import tsx --test tests/notification-relay-rules-requeue.test.mjs
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

function rssEvent(extra = {}) {
  return { eventType: 'rss_alert', severity: 'critical', payload: { title: 'Headline', source: 'Reuters' }, ...extra };
}

/**
 * Runs processEvent with /relay/enabled-rules answering `rulesStatus` and
 * records every Upstash LPUSH onto the event queue plus Telegram sends.
 */
async function run(event, { rulesStatus = 500, upstashOk = true, upstashStalls = false } = {}) {
  const requeued = [];
  const requeueInits = [];
  const sleeps = [];
  let telegram = 0;
  const silence = [console.log, console.warn, console.error];
  const logs = [];
  console.log = console.warn = console.error = (...args) => { logs.push(args.join(' ')); };
  // Back-off sleeps must not slow the suite; record them instead.
  globalThis.setTimeout = (fn, ms) => { sleeps.push(ms); return originalSetTimeout(fn, 0); };
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    const parsed = new URL(str);
    if (parsed.pathname.includes('/relay/enabled-rules')) {
      if (rulesStatus === 200) {
        return { ok: true, status: 200, json: async () => [{ userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', channels: ['telegram'], variant: 'full' }] };
      }
      return { ok: false, status: rulesStatus, json: async () => ({}) };
    }
    if (parsed.pathname.includes('/relay/entitlement')) return { ok: true, json: async () => ({ tier: 1 }) };
    if (parsed.pathname.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: 'chat-1' }] };
    }
    if (parsed.hostname === 'api.telegram.org') { telegram += 1; return { status: 200, ok: true, json: async () => ({ ok: true }) }; }
    if (parsed.hostname === 'stub.upstash.io') {
      const parts = parsed.pathname.split('/').slice(1).map(decodeURIComponent);
      if (parts[0] === 'LPUSH' && parts[1] === relay.EVENT_QUEUE_KEY) {
        requeueInits.push(init);
        if (upstashStalls) {
          // What a timed-out request surfaces: an AbortError from fetch.
          const abort = new Error('This operation was aborted');
          abort.name = 'AbortError';
          throw abort;
        }
        if (!upstashOk) return { ok: false, status: 503 };
        requeued.push(JSON.parse(parts[2]));
      }
      return { ok: true, json: async () => ({ result: 1 }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await relay.processEvent(event);
  } finally {
    [console.log, console.warn, console.error] = silence;
  }
  return { requeued, requeueInits, sleeps, telegram, logs };
}

describe('relay re-queues an event when the alert-rules read fails', () => {
  it('re-queues with attempt 1 and backs off instead of dropping', async () => {
    const { requeued, sleeps, telegram, logs } = await run(rssEvent());
    assert.equal(telegram, 0);
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].rulesFetchAttempts, 1);
    assert.equal(requeued[0].eventType, 'rss_alert');
    assert.deepEqual(requeued[0].payload, { title: 'Headline', source: 'Reuters' });
    assert.ok(sleeps.some((ms) => ms >= 2000), `expected a back-off sleep, got ${JSON.stringify(sleeps)}`);
    assert.ok(logs.some((l) => /re-queued rss_alert/.test(l)), logs.join('\n'));
  });

  it('counts attempts across retries and keeps re-queuing below the cap', async () => {
    const { requeued, sleeps } = await run(rssEvent({ rulesFetchAttempts: relay.RULES_FETCH_RETRY_MAX - 1 }));
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].rulesFetchAttempts, relay.RULES_FETCH_RETRY_MAX);
    assert.ok(Math.max(...sleeps) <= 10000, 'back-off is capped');
  });

  it('drops loudly after the last attempt', async () => {
    const { requeued, logs } = await run(rssEvent({ rulesFetchAttempts: relay.RULES_FETCH_RETRY_MAX }));
    assert.deepEqual(requeued, []);
    assert.ok(logs.some((l) => /Dropping rss_alert after \d+ alert-rules fetch failures/.test(l)), logs.join('\n'));
  });

  it('logs the drop when Upstash refuses the re-queue', async () => {
    const { requeued, logs } = await run(rssEvent(), { upstashOk: false });
    assert.deepEqual(requeued, []);
    assert.ok(logs.some((l) => /could not re-queue rss_alert/.test(l)), logs.join('\n'));
  });

  it('bounds the re-queue write with a timeout and reports a stalled write as a re-queue failure', async () => {
    const { requeued, requeueInits, logs } = await run(rssEvent(), { upstashStalls: true });
    assert.equal(requeueInits.length, 1);
    assert.ok(requeueInits[0]?.signal instanceof AbortSignal, 'LPUSH must carry an AbortSignal');
    assert.deepEqual(requeued, []);
    assert.ok(logs.some((l) => /re-queue of rss_alert failed \(This operation was aborted\) — dropped/.test(l)), logs.join('\n'));
  });

  it('a re-queued event delivers normally once the read recovers (attempt counter is not a dedup key)', async () => {
    const { requeued, telegram } = await run(rssEvent({ rulesFetchAttempts: 2 }), { rulesStatus: 200 });
    assert.deepEqual(requeued, []);
    assert.equal(telegram, 1);
  });
});
