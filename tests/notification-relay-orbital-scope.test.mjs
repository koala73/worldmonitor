/**
 * Watched-site alerts reach only rules that opt in to the event type and list
 * the site, and only that rule owner's own channels.
 *
 * Drives the REAL processEvent from scripts/notification-relay.cjs with the
 * loader stubs of notification-relay-chokepoint-scope.test.mjs and records
 * Telegram sends per chat.
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
let alerts;
let originalFetch;
before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  alerts = require(resolve(__dirname, '..', 'scripts', 'lib', 'orbital-site-alerts.cjs'));
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
let seq = 0;
function siteEvent(siteId = 'hotspot:a', eventType = 'orbital_site_change') {
  seq += 1;
  return {
    eventType,
    severity: 'critical',
    payload: {
      title: `Site ${siteId}: radar imagery statistics changed (confirmed) #${seq}`,
      source: 'Orbital Watch',
      siteId,
      coalesceKey: `${eventType}:${siteId}:${seq}`,
    },
  };
}

const rule = (userId, overrides = {}) => ({
  userId, digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', countries: [], tickers: [], channels: ['telegram'], variant: 'full', ...overrides,
});

/** Returns the Telegram chat ids that received a message. Each user's chat id is `chat-<userId>`. */
async function deliveries(rules, event, { tiers = {} } = {}) {
  const chats = [];
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (path.includes('/relay/enabled-rules')) return { ok: true, json: async () => rules };
    if (path.includes('/relay/entitlement')) return { ok: true, json: async () => ({ tier: tiers[body?.userId] ?? 1 }) };
    if (path.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: `chat-${body?.userId}` }] };
    }
    if (parsed.hostname === 'api.telegram.org') {
      chats.push(body?.chat_id);
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
  return chats;
}

describe('watched-site alert rule matching', () => {
  for (const eventType of ['orbital_site_change', 'orbital_imaging_window']) {
    it(`${eventType} is opt-in: a wildcard rule listing the site receives nothing`, async () => {
      assert.deepEqual(await deliveries([rule('user-1', { orbitalSites: ['hotspot:a'] })], siteEvent('hotspot:a', eventType)), []);
    });

    it(`${eventType} reaches a rule that opts in and lists the site`, async () => {
      const rules = [rule('user-1', { eventTypes: [eventType], orbitalSites: ['hotspot:a'] })];
      assert.deepEqual(await deliveries(rules, siteEvent('hotspot:a', eventType)), ['chat-user-1']);
    });
  }

  it('a rule scoped to site A receives nothing for site B', async () => {
    const rules = [rule('user-1', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:a'] })];
    assert.deepEqual(await deliveries(rules, siteEvent('hotspot:b')), []);
  });

  it('an empty site list means no watched-site alerts', async () => {
    const rules = [rule('user-1', { eventTypes: ['orbital_site_change'], orbitalSites: [] }), rule('user-2', { eventTypes: ['orbital_site_change'] })];
    assert.deepEqual(await deliveries(rules, siteEvent()), []);
  });

  it("one user's sites never deliver to another user's channels", async () => {
    const rules = [
      rule('user-1', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:a'] }),
      rule('user-2', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:b'] }),
    ];
    assert.deepEqual(await deliveries(rules, siteEvent('hotspot:a')), ['chat-user-1']);
    assert.deepEqual(await deliveries(rules, siteEvent('hotspot:b')), ['chat-user-2']);
  });

  it('a free account receives nothing even with a matching rule', async () => {
    const rules = [rule('user-free', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:a'] })];
    assert.deepEqual(await deliveries(rules, siteEvent(), { tiers: { 'user-free': 0 } }), []);
  });

  it('is not dropped by country scope', async () => {
    const rules = [rule('user-1', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:a'], countries: ['FR'] })];
    assert.deepEqual(await deliveries(rules, siteEvent()), ['chat-user-1']);
  });

  it('does not restrict the other alerts of a rule that opts in', async () => {
    seq += 1;
    const rss = { eventType: 'rss_alert', severity: 'critical', payload: { title: `Headline #${seq}`, source: 'Reuters' } };
    assert.deepEqual(await deliveries([rule('user-1', { eventTypes: ['orbital_site_change'] })], rss), ['chat-user-1']);
  });

  it('tags web pushes per site', () => {
    assert.equal(relay.webPushTagFor(siteEvent('hotspot:a'), 'u1'), 'orbital_site_change:hotspot:a:u1');
  });
});

describe('watched-site alert end to end', () => {
  it('a fixture transition to confirmed delivers one notification to the subscribed test channel', async () => {
    const events = [];
    let state = null;
    const record = {
      siteId: 'hotspot:a',
      name: 'Fixture site',
      nextWindows: [],
      flag: { state: 'confirmed', events: [{ kind: 'confirmed', itemId: 'S1A_fixture', datetime: new Date(NOW - 3_600_000).toISOString(), platform: 'sentinel-1a' }] },
    };
    const run = () => alerts.publishOrbitalSiteAlerts([record], {
      shadow: false,
      now: () => NOW,
      readState: async () => state,
      writeState: async (_key, next) => { state = structuredClone(next); return true; },
      publish: async (event) => { events.push(event); return true; },
    });
    await run();
    await run();
    assert.equal(events.length, 1, 'one event for one transition');
    const rules = [
      rule('user-1', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:a'] }),
      rule('user-2', { eventTypes: ['orbital_site_change'], orbitalSites: ['hotspot:b'] }),
    ];
    assert.deepEqual(await deliveries(rules, events[0]), ['chat-user-1']);
    const { payload } = relay.shapeEventForWebhook(events[0]);
    assert.equal(payload.source, 'Orbital Watch');
    assert.equal(payload.siteId, 'hotspot:a');
  });
});
