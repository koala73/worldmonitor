/**
 * The relay keeps a per-user record of the realtime alerts it delivered, so the
 * dashboard search can find a headline after it left the loaded news.
 *
 * The record is written only for a user who received the alert on at least one
 * channel, under that user's own key, with the title, publisher and link the
 * channels showed.
 *
 * Drives the REAL processEvent. One fetch stub serves Convex, Telegram and a
 * small in-memory Redis. The history write is a Lua script; the stub runs its
 * real text in a Lua VM (fengari), so the check against the account-deletion
 * marker is the one Redis would make.
 *
 * Run: node --test tests/notification-relay-sent-alerts.test.mjs
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

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

/** Run a script's real text with `redis.call` bound to `call`, as EVAL does. Returns its integer reply. */
function runLua(script, keys, argv, call) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const pushStrings = (values, name) => {
    lua.lua_createtable(L, values.length, 0);
    values.forEach((value, index) => {
      lua.lua_pushstring(L, to_luastring(String(value)));
      lua.lua_seti(L, -2, index + 1);
    });
    lua.lua_setglobal(L, to_luastring(name));
  };
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const parts = [];
    for (let i = 1; i <= lua.lua_gettop(S); i += 1) parts.push(to_jsstring(lua.lua_tostring(S, i)));
    const reply = call(parts);
    if (typeof reply === 'number') lua.lua_pushinteger(S, reply);
    else if (typeof reply === 'string') lua.lua_pushstring(S, to_luastring(reply));
    else lua.lua_pushboolean(S, false);
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));
  pushStrings(keys, 'KEYS');
  pushStrings(argv, 'ARGV');
  const failure = () => to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<no message>'));
  if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) assert.fail(`script failed to compile: ${failure()}`);
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) assert.fail(`script raised: ${failure()}`);
  return Math.trunc(lua.lua_tonumber(L, -1));
}

/**
 * `telegramOk(chatId)` decides whether a send succeeds. Each user's Telegram
 * chat id is their user id, so a test can fail one recipient only.
 */
function harness({ rules, telegramOk = () => true, pipelineStatus = 200, held = {}, lists: seededLists = {} } = {}) {
  const lists = new Map([
    ...Object.entries(held).map(([key, events]) => [key, events.map((event) => JSON.stringify(event))]),
    ...Object.entries(seededLists).map(([key, rows]) => [key, [...rows]]),
  ]);
  const strings = new Map();
  const ttls = new Map();
  const pipelines = [];
  const telegramSends = [];

  const command = (parts) => {
    const [cmd, key, ...args] = parts;
    if (cmd === 'EVAL') {
      const keyCount = Number(args[0]);
      return runLua(key, args.slice(1, 1 + keyCount), args.slice(1 + keyCount), command);
    }
    if (cmd === 'EXISTS') return strings.has(key) || lists.has(key) ? 1 : 0;
    if (cmd === 'DEL') {
      const existed = strings.delete(key) || lists.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    }
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
    if (cmd === 'EXPIRE') {
      ttls.set(key, Number(args[0]));
      return 1;
    }
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
  /** The Redis commands account deletion sends for this user, in its order: marker first, then the history. */
  const deleteAccount = (userId) => {
    command(['SET', `wm:notif:sent-erased:v1:${userId}`, '1', 'EX', String(7 * 24 * 60 * 60)]);
    command(['DEL', `wm:notif:sent:v1:${userId}`]);
  };
  return { sentAlerts, historyKeys, deleteAccount, pipelines, telegramSends, lists, strings, ttls };
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

  it('bounds the list and gives it a TTL in the same command as the write', async () => {
    const key = 'wm:notif:sent:v1:user-a';
    const older = Array.from({ length: history.SENT_ALERTS_MAX }, (_, index) => JSON.stringify({ title: `Older ${index}`, sentAt: 1 }));
    const h = harness({ rules: [rule('user-a')], lists: { [key]: older } });
    const event = rssEvent();
    await relay.processEvent(event);

    const write = h.pipelines.find((commands) => commands.some((parts) => parts.includes(key)));
    assert.ok(write, 'the history write is one pipeline');
    // One script per record: the push, the cap and the TTL cannot be split by another client.
    assert.deepEqual(write.map((parts) => parts[0]), ['EVAL']);
    assert.equal(write[0][1], history.SENT_ALERT_WRITE_SCRIPT);
    assert.deepEqual(write[0].slice(2, 5), ['2', key, history.sentAlertsErasedKey('user-a')]);

    assert.equal(h.lists.get(key).length, history.SENT_ALERTS_MAX, 'the list stays at its cap');
    assert.equal(h.sentAlerts('user-a')[0].title, event.payload.title, 'the new alert is first');
    assert.equal(h.ttls.get(key), history.SENT_ALERTS_TTL_SECONDS);
  });

  it('writes one pipeline for the whole fan-out, one key per recipient', async () => {
    const h = harness({ rules: [rule('user-a'), rule('user-b')] });
    const event = rssEvent();
    await relay.processEvent(event);

    assert.deepEqual(h.historyKeys().sort(), ['wm:notif:sent:v1:user-a', 'wm:notif:sent:v1:user-b']);
    assert.equal(h.sentAlerts('user-a').length, 1);
    assert.equal(h.sentAlerts('user-b').length, 1);
    const writes = h.pipelines.filter((commands) => commands.some((parts) => parts.some((part) => String(part).startsWith(history.SENT_ALERTS_KEY_PREFIX))));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 2, 'one command per recipient');
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

  // Account deletion removes the history while a delivery pass is still running;
  // the pass writes its records when it ends (Greptile, PR #10920).
  it('does not bring back the history of an account deleted while the pass was still delivering', async () => {
    const h = harness({
      rules: [rule('user-a'), rule('user-b')],
      // user-a has already received the alert when the relay reaches user-b.
      telegramOk: (chatId) => {
        if (chatId === 'user-b') h.deleteAccount('user-a');
        return true;
      },
    });
    await relay.processEvent(rssEvent());

    assert.equal(h.telegramSends.length, 2, 'both recipients were sent the alert');
    assert.deepEqual(h.historyKeys(), ['wm:notif:sent:v1:user-b'], 'the deleted account has no history key again');
    assert.equal(h.sentAlerts('user-b').length, 1, 'another recipient in the same pipeline is still recorded');
  });

  it('writes nothing for an account whose deletion marker is set, and does not fail the delivery', async () => {
    const h = harness({ rules: [rule('user-a')] });
    h.deleteAccount('user-a');
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

describe('sent-alert deletion marker', () => {
  it('is a key of its own per user, outside the history prefix', () => {
    assert.equal(history.sentAlertsErasedKey('user-a'), 'wm:notif:sent-erased:v1:user-a');
    assert.ok(!history.sentAlertsErasedKey('user-a').startsWith(history.SENT_ALERTS_KEY_PREFIX));
  });

  it('outlives any delivery pass that could still hold a record for the account', () => {
    assert.equal(history.SENT_ALERTS_ERASED_TTL_SECONDS, history.SENT_ALERTS_TTL_SECONDS);
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
