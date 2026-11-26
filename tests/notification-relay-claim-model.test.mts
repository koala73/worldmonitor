// Property, bounds and how to read a failure: .agents/skills/verify-relay-claims/SKILL.md.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

import { createModelRedis, currentActor, exploreInterleavings, upstashFetch } from './helpers/interleavings.mjs';

process.env.UPSTASH_REDIS_REST_URL = 'https://model.redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 'model-token';
process.env.CONVEX_URL = 'https://model.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET = 'model-secret';
process.env.TELEGRAM_BOT_TOKEN = 'model-bot-token';

const require = createRequire(import.meta.url);
// Claim tokens are random; replaying an order must send the same commands.
let tokens = 0;
const crypto = { ...require('node:crypto'), randomUUID: () => `token-${++tokens}` };
const originalLoad = (Module as any)._load;
(Module as any)._load = function load(request: string, ...rest: unknown[]) {
  if (request === 'crypto' || request === 'node:crypto') return crypto;
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, ...rest);
};
const relay = require('../scripts/notification-relay.cjs');
const { releaseFailOpenFallback } = require('../scripts/shared/notification-dedup.cjs');

const USERS = ['user-a', 'user-b'];
const EVENT = { eventType: 'rss_alert', severity: 'critical', payload: { title: 'Claim model headline', source: 'Reuters' } };

type Run = Parameters<typeof upstashFetch>[0];

// Clears the in-process relay state this event's path reads: the blocked-link
// cache and the fail-open reservations for these users. Without it one run's
// reservation suppresses the next run's alert.
function resetRelayProcess() {
  tokens = 0;
  relay.__resetBlockedLinkCacheForTests();
  for (const user of USERS) releaseFailOpenFallback(`realtime:${user}:${EVENT.eventType}:${EVENT.payload.title}:`);
}

function setup(run: Run) {
  resetRelayProcess();
  const redis = createModelRedis();
  const sends: string[] = [];
  const unmodelled = new Set<string>();
  const redisFetch = upstashFetch(run, redis, { isShared: (key: string) => key.startsWith('wm:notif:dedup:') || key === relay.EVENT_QUEUE_KEY });
  const convex = (label: string, body: () => unknown, { faulty = true } = {}) => {
    const fault = faulty ? run.fault(currentActor(), label) : 'ok';
    if (fault === 'dropped') throw new TypeError('fetch failed');
    const value = body();
    if (fault === 'lost') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(value), { status: 200 });
  };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'model.redis') return redisFetch(input, init);
    if (url.pathname.endsWith('/relay/enabled-rules')) {
      return convex('POST /relay/enabled-rules', () => USERS.map((userId) => ({
        userId, digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', channels: ['telegram'], variant: 'full',
      })));
    }
    // A failed entitlement read drops that user's alert on purpose (fail-closed paywall, #3485).
    if (url.pathname.endsWith('/relay/entitlement')) return convex('POST /relay/entitlement', () => ({ tier: 1 }), { faulty: false });
    if (url.pathname.endsWith('/relay/channels')) {
      const { userId } = JSON.parse(String(init?.body));
      return convex(`POST /relay/channels ${userId}`, () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: userId }]);
    }
    if (url.hostname === 'api.telegram.org') {
      sends.push(JSON.parse(String(init?.body)).chat_id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    unmodelled.add(`${init?.method ?? 'GET'} ${url.hostname}${url.pathname}`);
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as typeof fetch;
  return { redis, sends, unmodelled };
}

type World = ReturnType<typeof setup>;

const relayActor = {
  name: 'relay',
  start: async ({ redis }: World) => {
    await relay.processEvent(structuredClone(EVENT));
    for (;;) {
      const queue = redis.data.get(relay.EVENT_QUEUE_KEY);
      if (!Array.isArray(queue) || queue.length === 0) return;
      await relay.processEvent(JSON.parse(queue.pop()));
    }
  },
};

function everyUserAlertedOnce(world: World) {
  if (world.unmodelled.size > 0) return `the relay made requests the model does not serve: ${[...world.unmodelled].join(', ')}`;
  const counts = USERS.map((user) => `${user}: ${world.sends.filter((s) => s === user).length}`);
  return USERS.every((user) => world.sends.filter((s) => s === user).length === 1) ? null : `sends per user ${counts.join(', ')}`;
}

// A critical alert is sent when its dedup claim errors, so a retry can alert a user twice.
function everyUserAlerted(world: World) {
  if (world.unmodelled.size > 0) return `the relay made requests the model does not serve: ${[...world.unmodelled].join(', ')}`;
  const missed = USERS.filter((user) => !world.sends.includes(user));
  return missed.length > 0 ? `never alerted: ${missed.join(', ')}` : null;
}

function report(result: Awaited<ReturnType<typeof exploreInterleavings>>) {
  if (!result.violation) return '';
  return `${result.violation.message}\nafter ${result.runs} runs, in this order:\n  ${result.violation.trace.join('\n  ')}`;
}

const saved = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, log: console.log, warn: console.warn, error: console.error };

describe('notification relay dedup claims against failed requests', () => {
  before(() => {
    globalThis.setTimeout = ((fn: () => void) => saved.setTimeout(fn, 0)) as typeof setTimeout;
    console.log = console.warn = console.error = () => {};
  });
  after(() => {
    Object.assign(globalThis, { fetch: saved.fetch, setTimeout: saved.setTimeout });
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
  });

  it('with no failures, each user is alerted once', async () => {
    const result = await exploreInterleavings({ setup, actors: [relayActor], check: everyUserAlertedOnce });
    assert.equal(result.violation, null, report(result));
  });

  it('with one failed or lost request anywhere, each user is still alerted once', async () => {
    const result = await exploreInterleavings({ setup, actors: [relayActor], check: everyUserAlertedOnce, maxFaults: 1 });
    assert.equal(result.violation, null, report(result));
  });

  it('with a failed or lost dedup claim and a failed channel read, every user is still alerted', async () => {
    const result = await exploreInterleavings({
      setup, actors: [relayActor], check: everyUserAlerted, maxFaults: 2,
      faultable: (_actor, label) => label.startsWith('SET wm:notif:dedup:') || label.startsWith('POST /relay/channels'),
    });
    assert.equal(result.violation, null, report(result));
  });
});
