/**
 * The relay keeps a per-user record of the realtime alerts it delivered, so the
 * dashboard search can find a headline after it left the loaded news.
 *
 * The record is written only for a user who received the alert on at least one
 * channel, under that user's own key, with the title, publisher and link the
 * channels showed.
 *
 * Drives the REAL processEvent. One fetch stub serves Convex, Telegram and a
 * small in-memory Redis.
 *
 * Run: node --test tests/notification-relay-sent-alerts.test.mjs
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
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
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, parent, ...rest);
};

const history = require(resolve(__dirname, '..', 'scripts', 'lib', 'sent-alert-history.cjs'));

let relay;
let originalFetch;
before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let titleSeq = 0;
function rssEvent(payload = {}) {
  titleSeq += 1;
  return {
    eventType: 'rss_alert',
    severity: 'critical',
    payload: {
      title: `Sent alert headline ${titleSeq}`,
      source: 'Reuters',
      link: `https://www.reuters.com/world/story-${titleSeq}`,
      ...payload,
    },
  };
}

function rule(userId, extra = {}) {
  return { userId, digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', channels: ['telegram'], variant: 'full', ...extra };
}

/**
 * `telegramOk(chatId)` decides whether a send succeeds. Each user's Telegram
 * chat id is their user id, so a test can fail one recipient only.
 */
function harness({ rules, telegramOk = () => true, pipelineStatus = 200, held = {} } = {}) {
  const lists = new Map(Object.entries(held).map(([key, events]) => [key, events.map((event) => JSON.stringify(event))]));
  const strings = new Map();
  const pipelines = [];
  const telegramSends = [];

  const command = (parts) => {
    const [cmd, key, ...args] = parts;
    if (cmd === 'SET') {
      if (args.includes('NX') && strings.has(key)) return null;
      strings.set(key, args[0]);
      return 'OK';
    }
    if (cmd === 'GET') return strings.get(key) ?? null;
    if (cmd === 'LLEN') return lists.get(key)?.length ?? 0;
    if (cmd === 'LRANGE') return lists.get(key) ?? [];
    if (cmd === 'LPUSH') {
      lists.set(key, [args[0], ...(lists.get(key) ?? [])]);
      return lists.get(key).length;
    }
    if (cmd === 'LTRIM') {
      lists.set(key, (lists.get(key) ?? []).slice(Number(args[0]), Number(args[1]) + 1));
      return 'OK';
    }
    if (cmd === 'LREM') {
      const list = lists.get(key) ?? [];
      const index = list.indexOf(args[1]);
      if (index >= 0) list.splice(index, 1);
      return index >= 0 ? 1 : 0;
    }
    if (cmd === 'EXPIRE') return 1;
    return null;
  };

  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'stub.upstash.io') {
      if (parsed.pathname === '/pipeline') {
        const commands = JSON.parse(init.body);
        pipelines.push(commands);
        if (pipelineStatus !== 200) return { ok: false, status: pipelineStatus, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => commands.map((parts) => ({ result: command(parts) })) };
      }
      const parts = init?.body
        ? JSON.parse(init.body)
        : parsed.pathname.split('/').slice(1).map(decodeURIComponent);
      return { ok: true, status: 200, json: async () => ({ result: command(parts) }) };
    }
    if (parsed.pathname.includes('/relay/enabled-rules')) return { ok: true, status: 200, json: async () => rules };
    if (parsed.pathname.includes('/relay/entitlement')) return { ok: true, status: 200, json: async () => ({ tier: 1 }) };
    if (parsed.pathname.includes('/relay/channels')) {
      const { userId } = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: userId }],
      };
    }
    if (parsed.hostname === 'api.telegram.org') {
      const { chat_id: chatId, text } = JSON.parse(init.body);
      telegramSends.push({ chatId, text });
      const ok = telegramOk(chatId);
      return { ok, status: ok ? 200 : 500, json: async () => ({}), body: { cancel() {} } };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const sentAlerts = (userId) => (lists.get(history.sentAlertsKey(userId)) ?? []).map((raw) => JSON.parse(raw));
  const historyKeys = () => [...lists.keys()].filter((key) => key.startsWith(history.SENT_ALERTS_KEY_PREFIX));
  return { sentAlerts, historyKeys, pipelines, telegramSends, lists };
}

describe('relay sent-alert history', () => {
  it('records a delivered alert under the recipient key, with the delivered title, publisher and link', async () => {
    const h = harness({ rules: [rule('user-a')] });
    const event = rssEvent();
    const before = Date.now();
    await relay.processEvent(event);

    assert.equal(h.telegramSends.length, 1, 'the alert must have been sent');
    assert.deepEqual(h.historyKeys(), ['wm:notif:sent:v1:user-a']);
    const [record] = h.sentAlerts('user-a');
    assert.equal(record.title, event.payload.title);
    assert.ok(h.telegramSends[0].text.includes(record.title), 'the stored title is the one the channel showed');
    assert.equal(record.source, 'Reuters');
    assert.equal(record.link, event.payload.link);
    assert.equal(record.eventType, 'rss_alert');
    assert.equal(record.severity, 'critical');
    assert.deepEqual(record.channels, ['telegram']);
    assert.ok(record.sentAt >= before && record.sentAt <= Date.now());
  });

  it('bounds the list and gives it a TTL in the same request as the write', async () => {
    const h = harness({ rules: [rule('user-a')] });
    await relay.processEvent(rssEvent());

    const write = h.pipelines.find((commands) => commands.some((parts) => parts[1] === 'wm:notif:sent:v1:user-a'));
    assert.ok(write, 'the history write is one pipeline');
    assert.deepEqual(write.map((parts) => parts[0]), ['LPUSH', 'LTRIM', 'EXPIRE']);
    assert.deepEqual(write[1], ['LTRIM', 'wm:notif:sent:v1:user-a', '0', String(history.SENT_ALERTS_MAX - 1)]);
    assert.deepEqual(write[2], ['EXPIRE', 'wm:notif:sent:v1:user-a', String(history.SENT_ALERTS_TTL_SECONDS)]);
  });

  it('writes one pipeline for the whole fan-out, one key per recipient', async () => {
    const h = harness({ rules: [rule('user-a'), rule('user-b')] });
    const event = rssEvent();
    await relay.processEvent(event);

    assert.deepEqual(h.historyKeys().sort(), ['wm:notif:sent:v1:user-a', 'wm:notif:sent:v1:user-b']);
    assert.equal(h.sentAlerts('user-a').length, 1);
    assert.equal(h.sentAlerts('user-b').length, 1);
    const writes = h.pipelines.filter((commands) => commands.some((parts) => String(parts[1]).startsWith(history.SENT_ALERTS_KEY_PREFIX)));
    assert.equal(writes.length, 1);
  });

  it('records nothing for a user whose every send failed', async () => {
    const h = harness({ rules: [rule('user-a'), rule('user-b')], telegramOk: (chatId) => chatId !== 'user-b' });
    await relay.processEvent(rssEvent());

    assert.equal(h.telegramSends.length, 2, 'both sends were attempted');
    assert.deepEqual(h.historyKeys(), ['wm:notif:sent:v1:user-a']);
    assert.deepEqual(h.sentAlerts('user-b'), []);
  });

  it('records nothing when no rule matched', async () => {
    const h = harness({ rules: [] });
    await relay.processEvent(rssEvent());
    assert.deepEqual(h.historyKeys(), []);
    assert.equal(h.pipelines.length, 0);
  });

  it('stores no link when the event has none, instead of the dashboard fallback', async () => {
    const h = harness({ rules: [rule('user-a')] });
    await relay.processEvent(rssEvent({ link: undefined }));
    assert.equal(h.sentAlerts('user-a')[0].link, '');
  });

  it('a failed history write does not fail the delivery', async () => {
    const h = harness({ rules: [rule('user-a')], pipelineStatus: 500 });
    await assert.doesNotReject(relay.processEvent(rssEvent()));
    assert.equal(h.telegramSends.length, 1);
    assert.deepEqual(h.historyKeys(), []);
  });

  it('records each held alert when the quiet-hours batch is delivered', async () => {
    const first = rssEvent();
    const second = rssEvent();
    const h = harness({
      rules: [rule('user-a')],
      held: { 'digest:quiet-held:user-a:full': [first, second] },
    });
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'user-a', variant: 'full' });

    assert.equal(h.telegramSends.length, 1, 'the batch goes out as one message');
    const titles = h.sentAlerts('user-a').map((record) => record.title);
    assert.deepEqual(titles, [second.payload.title, first.payload.title], 'newest first');
    assert.deepEqual(h.sentAlerts('user-a')[0].channels, ['telegram']);
  });

  it('records no held alert when the batch delivery failed', async () => {
    const h = harness({
      rules: [rule('user-a')],
      telegramOk: () => false,
      held: { 'digest:quiet-held:user-a:full': [rssEvent()] },
    });
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'user-a', variant: 'full' });
    assert.equal(h.telegramSends.length, 1);
    assert.deepEqual(h.historyKeys(), []);
  });
});

describe('sent-alert record shape', () => {
  it('keeps the fields the search result shows and bounds their length', () => {
    const record = history.buildSentAlertRecord({
      title: `  ${'x'.repeat(600)}  `,
      source: 'Reuters',
      link: 'https://example.com/a',
      eventType: 'rss_alert',
      severity: 'high',
      channels: ['email', 'email', 'web_push', 7],
      sentAt: 1_700_000_000_000,
    });
    assert.equal(record.title.length, history.SENT_ALERT_TITLE_MAX);
    assert.deepEqual(record.channels, ['email', 'web_push']);
    assert.equal(record.sentAt, 1_700_000_000_000);
    assert.deepEqual(Object.keys(record).sort(), ['channels', 'eventType', 'link', 'sentAt', 'severity', 'source', 'title']);
  });

  it('refuses a record without a title and drops a link that is not http or https', () => {
    assert.equal(history.buildSentAlertRecord({ title: '   ', sentAt: 1 }), null);
    assert.equal(history.buildSentAlertRecord({ title: 'A headline', link: 'javascript:alert(1)', sentAt: 1 }).link, '');
    assert.equal(history.buildSentAlertRecord({ title: 'A headline', link: 'https://example.com/a', sentAt: 1 }).link, 'https://example.com/a');
  });
});
