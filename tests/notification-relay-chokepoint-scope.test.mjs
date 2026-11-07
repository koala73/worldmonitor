/**
 * #9217 item 6: `chokepoint_disruption` reaches only rules that opt in, may be
 * narrowed by `rule.chokepoints`, and is not dropped by country scope (it
 * carries no country).
 *
 * Drives the REAL processEvent from scripts/notification-relay.cjs with the
 * loader stubs of notification-relay-link-suppression.test.mjs and counts
 * Telegram sends.
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
before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let seq = 0;
function chokepointEvent(chokepointId = 'hormuz_strait') {
  seq += 1;
  return {
    eventType: 'chokepoint_disruption',
    severity: 'critical',
    payload: {
      title: `Strait of Hormuz: disruption score 72/100 #${seq}`,
      source: 'Chokepoint Monitor',
      chokepointId,
      disruptionScore: 72,
      status: 'red',
      coalesceKey: `chokepoint_disruption:${chokepointId}:${seq}`,
    },
  };
}

function rssEvent() {
  seq += 1;
  return { eventType: 'rss_alert', severity: 'critical', payload: { title: `Headline #${seq}`, source: 'Reuters' } };
}

async function deliveries(rule, event) {
  let telegram = 0;
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path.includes('/relay/enabled-rules')) {
      return { ok: true, json: async () => [{ userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', countries: [], tickers: [], channels: ['telegram'], variant: 'full', ...rule }] };
    }
    if (path.includes('/relay/entitlement')) return { ok: true, json: async () => ({ tier: 1 }) };
    if (path.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: 'chat-1' }] };
    }
    if (parsed.hostname === 'api.telegram.org') {
      telegram += 1;
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (path.endsWith('/pipeline')) return { ok: true, json: async () => [] };
    if (String(url).includes('/SET/')) return { ok: true, json: async () => ({ result: 'OK' }) };
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await relay.processEvent(event);
  } finally {
    [console.log, console.warn, console.error] = silence;
  }
  return telegram;
}

describe('chokepoint_disruption rule matching', () => {
  it('is opt-in: a wildcard rule does not receive it', async () => {
    assert.equal(await deliveries({ eventTypes: [] }, chokepointEvent()), 0);
  });

  it('reaches a rule that opts in, with no chokepoint list meaning every chokepoint', async () => {
    assert.equal(await deliveries({ eventTypes: ['chokepoint_disruption'] }, chokepointEvent()), 1);
  });

  it('honours the rule chokepoint list', async () => {
    const rule = { eventTypes: ['chokepoint_disruption'], chokepoints: ['suez', 'hormuz_strait'] };
    assert.equal(await deliveries(rule, chokepointEvent('hormuz_strait')), 1);
    assert.equal(await deliveries(rule, chokepointEvent('panama')), 0);
  });

  it('is not dropped by country scope', async () => {
    const rule = { eventTypes: ['chokepoint_disruption'], countries: ['FR'] };
    assert.equal(await deliveries(rule, chokepointEvent()), 1);
  });

  it('does not restrict the other alerts of a rule that opts in', async () => {
    const rule = { eventTypes: ['chokepoint_disruption'] };
    assert.equal(await deliveries(rule, rssEvent()), 1);
  });

  it('drops an event without a chokepoint id when the rule names chokepoints', async () => {
    const event = chokepointEvent();
    delete event.payload.chokepointId;
    assert.equal(await deliveries({ eventTypes: ['chokepoint_disruption'], chokepoints: ['suez'] }, event), 0);
  });
});

describe('chokepoint_disruption delivery shape', () => {
  it('keeps its source and fields through the webhook formatter', async () => {
    const { buildEvent } = require(resolve(__dirname, '..', 'scripts', 'lib', 'chokepoint-disruption-alerts.cjs'));
    const event = buildEvent({ id: 'hormuz_strait', name: 'Strait of Hormuz', disruptionScore: 72, activeWarnings: 2, congestionLevel: 'elevated' }, '2026-10-17T12:00:00.000Z');
    const { payload } = relay.shapeEventForWebhook(event);
    assert.equal(payload.source, 'Chokepoint Monitor', 'a first-party-looking source is rewritten to "Community alert"');
    assert.equal(payload.title, 'Strait of Hormuz: disruption score 72/100');
    assert.equal(payload.chokepointId, 'hormuz_strait');
    assert.equal(payload.disruptionScore, 72);
  });
});

describe('web push tag', () => {
  it('keeps two chokepoint alerts apart and leaves other tags unchanged', () => {
    const a = relay.webPushTagFor(chokepointEvent('suez'), 'u1');
    const b = relay.webPushTagFor(chokepointEvent('bab_el_mandeb'), 'u1');
    assert.notEqual(a, b);
    assert.equal(relay.webPushTagFor(rssEvent(), 'u1'), 'rss_alert:u1');
  });
});

describe('eventMatchesChokepointScope', () => {
  it('passes every other event type through', () => {
    assert.equal(relay.eventMatchesChokepointScope(rssEvent(), { chokepoints: ['suez'] }), true);
  });
});
