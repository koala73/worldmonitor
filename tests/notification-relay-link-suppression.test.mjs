/**
 * Failing-first proof for #8401, relay half: an event whose payload link is
 * operator-blocked must not reach any delivery channel.
 *
 * Drives the REAL `processEvent` from scripts/notification-relay.cjs (same
 * loader-stub pattern as notification-relay-telegram-retry.test.mjs) with a
 * stubbed Upstash SMEMBERS snapshot. Asserts:
 *   - blocked exact URL → zero channel sends + a [relay][link-suppressed]
 *     log line + a ZADD record on the suppression log key (blast-radius log);
 *   - blocked host → same;
 *   - unblocked link → delivery proceeds;
 *   - unreadable set (Redis down) → fail-open delivery + loud unreadable log;
 *   - scheme-relative / backslash spellings match host: like the classifier;
 *   - a last-known snapshot is retained through a blip but dropped (with an
 *     error log) past BLOCKED_LINKS_SNAPSHOT_MAX_AGE_MS;
 *   - held quiet-hours events are re-checked when the batch drains.
 *
 * Run: node --test tests/notification-relay-link-suppression.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
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
  for (const name of ['processEvent', 'eventLinks', 'BLOCKED_LINKS_KEY', 'BLOCKED_LINKS_LOG_KEY', '__resetBlockedLinkCacheForTests']) {
    assert.ok(relay[name] !== undefined, `${name} export missing from notification-relay.cjs`);
  }
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  relay.__resetBlockedLinkCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const EVIL = 'https://evil.example/phish?x=1';

// Monotonic nonce so every processEvent call in this file uses a distinct
// title. The relay's per-user dedup keys on eventType+title, and the stub
// Upstash below returns miss/null for every SET NX — but the relay also
// keeps no in-process state across harnesses, so without distinct titles a
// second test replays the first test's dedup key and drops as a duplicate.
let eventSeq = 0;

function makeEvent(link = EVIL) {
  eventSeq++;
  return {
    eventType: 'rss_alert',
    severity: 'critical',
    payload: { title: `Verify your account #${eventSeq}`, source: 'WorldMonitor Security', link },
  };
}

let harnessSeq = 0;

function installHarness({ smembers = [], smembersOk = true, pipelineOk = true, pipelineCommandError = false, held = null, rule = {} } = {}) {
  const calls = { telegram: 0, telegramBodies: [], pipeline: [], smembers: 0, del: [] };
  // Mutable so a test can flip Redis from healthy to down mid-scenario.
  const state = { smembersOk };
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.warn = (...args) => { logs.push(args.join(' ')); };
  // Dedup keys are per-user+title: give each test a unique title so the
  // shared stub-Upstash dedup (which returns miss/null for every SET NX)
  // cannot leak a "hit" across tests. Titles carry a per-harness nonce.
  const nonce = `t${++harnessSeq}`;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // Route the stub by parsed hostname — never by substring. (CodeQL
    // js/incomplete-url-substring-sanitization fires on `includes` checks
    // against URL strings, even in test stubs.)
    let host = '';
    let path = '';
    try {
      const parsed = new URL(u);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname;
    } catch { /* non-absolute URL: falls through to the Upstash default */ }
    if (path.includes('/relay/enabled-rules')) {
      return { ok: true, json: async () => [{ userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'all', countries: [], tickers: [], channels: ['telegram'], variant: 'full', ...rule }] };
    }
    if (path.includes('/relay/entitlement')) {
      return { ok: true, json: async () => ({ tier: 1 }) };
    }
    if (path.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: 'chat-1' }] };
    }
    if (host === 'api.telegram.org') {
      calls.telegram++;
      calls.telegramBodies.push(String(opts.body ?? ''));
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (u.endsWith(`/SMEMBERS/${encodeURIComponent(relay.BLOCKED_LINKS_KEY)}`)) {
      calls.smembers++;
      if (!state.smembersOk) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ result: smembers }) };
    }
    if (u.endsWith('/pipeline')) {
      let body = [];
      try { body = JSON.parse(opts.body); } catch { /* keep empty */ }
      calls.pipeline.push(body);
      return {
        ok: pipelineOk,
        status: pipelineOk ? 200 : 500,
        json: async () => body.map((_, index) => (
          pipelineCommandError && index === 0 ? { error: 'ERR write failed' } : { result: 1 }
        )),
      };
    }
    // Upstash generic REST (GET/SET for entitlement cache, dedup SET NX).
    // Dedup MUST report "new" (Upstash "OK") — the relay's fail-open
    // fallback treats anything else as a duplicate on the second call.
    if (held && path.startsWith('/LLEN/')) return { ok: true, json: async () => ({ result: held.length }) };
    if (held && path.startsWith('/LRANGE/')) return { ok: true, json: async () => ({ result: held }) };
    if (path.startsWith('/DEL/')) {
      calls.del.push(decodeURIComponent(path.slice('/DEL/'.length)));
      return { ok: true, json: async () => ({ result: 1 }) };
    }
    if (u.includes('/SET/')) {
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  const origError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  return {
    calls,
    logs,
    state,
    restore() { console.log = origLog; console.warn = origWarn; console.error = origError; },
  };
}

describe('notification-relay link suppression (#8401)', () => {
  it('drops a blocked exact-URL event before any channel send, and logs the blast radius', async () => {
    const h = installHarness({ smembers: [EVIL] });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 0, 'blocked link must not reach Telegram');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')), 'must log [relay][link-suppressed]');
      const zadds = h.calls.pipeline.flat().filter((cmd) => cmd[0] === 'ZADD' && cmd[1] === relay.BLOCKED_LINKS_LOG_KEY);
      assert.equal(zadds.length, 1, 'must ZADD one suppression record for incident scoping');
      const record = JSON.parse(zadds[0][3]);
      assert.equal(record.eventType, 'rss_alert');
      assert.ok(Array.isArray(record.link) && record.link[0].includes('evil.example'), 'record must carry the suppressed link');
      assert.equal(record.matchedRules, 1);
      assert.equal(record.suppressedChannels, undefined);
      const trims = h.calls.pipeline.flat().filter((cmd) => cmd[0] === 'ZREMRANGEBYSCORE' && cmd[1] === relay.BLOCKED_LINKS_LOG_KEY);
      assert.equal(trims.length, 1, 'must prune incident records older than the retention window');
      assert.equal(trims[0][2], '-inf');
      assert.ok(Number(trims[0][3]) < Number(zadds[0][2]), 'retention cutoff must precede the new record');
    } finally {
      h.restore();
    }
  });

  it('drops events matching a host: entry, including subdomains', async () => {
    const h = installHarness({ smembers: ['host:evil.example'] });
    try {
      await relay.processEvent(makeEvent('https://www.evil.example/other'));
      assert.equal(h.calls.telegram, 0, 'host-blocked link must not reach Telegram');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')));
    } finally {
      h.restore();
    }
  });

  it('drops a host-blocked URL longer than 2,048 characters', async () => {
    const h = installHarness({ smembers: ['host:evil.example'] });
    try {
      await relay.processEvent(makeEvent(`https://www.evil.example/path?payload=${'x'.repeat(2_100)}`));
      assert.equal(h.calls.telegram, 0, 'long host-blocked link must not reach Telegram');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')));
    } finally {
      h.restore();
    }
  });

  it('keeps suppression active and warns when the incident-log request fails', async () => {
    const h = installHarness({ smembers: [EVIL], pipelineOk: false });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 0, 'audit failure must not undo suppression');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppression-log-failed]')));
    } finally {
      h.restore();
    }
  });

  it('warns when Upstash reports a command-level incident-log failure', async () => {
    const h = installHarness({ smembers: [EVIL], pipelineCommandError: true });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 0);
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppression-log-failed]')));
    } finally {
      h.restore();
    }
  });

  it('delivers when the link is not blocked', async () => {
    const h = installHarness({ smembers: ['https://other.example/unrelated'] });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 1, 'unblocked link must still deliver');
      assert.ok(!h.logs.some((l) => l.includes('[relay][link-suppressed]')));
    } finally {
      h.restore();
    }
  });

  it('delivers events with no link without consulting the set', async () => {
    const h = installHarness({ smembers: [EVIL] });
    try {
      const event = makeEvent();
      delete event.payload.link;
      await relay.processEvent(event);
      assert.equal(h.calls.smembers, 0, 'linkless events must skip the SMEMBERS read');
      assert.equal(h.calls.telegram, 1, 'linkless events must still deliver');
    } finally {
      h.restore();
    }
  });

  it('fails open with a loud log when the set is unreadable', async () => {
    const h = installHarness({ smembersOk: false });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 1, 'unreadable set must fail open to delivery');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed-unreadable]')), 'must log the unreadable control loudly');
      assert.ok(!h.logs.some((l) => l.includes('[relay][link-suppressed] ')), 'must not log a suppression that did not happen');
    } finally {
      h.restore();
    }
  });

  it('negative-caches the unreadable set within the TTL window (no hot loop)', async () => {
    const h = installHarness({ smembersOk: false });
    try {
      await relay.processEvent(makeEvent());
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.smembers, 1, 'second event inside the TTL must reuse the negative cache');
      const unreadableLogs = h.logs.filter((l) => l.includes('[relay][link-suppressed-unreadable]'));
      assert.equal(unreadableLogs.length, 1, 'unreadable control must log once per TTL window, not per event');
    } finally {
      h.restore();
    }
  });
  it('drops scheme-relative and backslash spellings of a host-blocked link', async () => {
    // classifyNotificationLink resolves both to https://evil.example/x and the
    // text sinks deliver that, so the matcher must resolve them the same way.
    for (const link of ['//evil.example/x', '/\\evil.example/x']) {
      const h = installHarness({ smembers: ['host:evil.example'] });
      try {
        relay.__resetBlockedLinkCacheForTests();
        await relay.processEvent(makeEvent(link));
        assert.equal(h.calls.telegram, 0, `${link} must not reach Telegram`);
        assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')), link);
      } finally {
        h.restore();
      }
    }
  });

  it('keeps a recent snapshot through an outage but stops trusting it past the max age', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const h = installHarness({ smembers: [EVIL] });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 0, 'healthy read suppresses');

      h.state.smembersOk = false;
      now += 2 * 60 * 1000; // past the 60s re-read TTL, well within the max age
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 0, 'a recent last-known snapshot keeps the incident block during a blip');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed-unreadable]') && /age=\d+s/.test(l)),
        'the unreadable warning must state how old the retained snapshot is');

      now += relay.BLOCKED_LINKS_SNAPSHOT_MAX_AGE_MS;
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 1, 'past the max age the snapshot is dropped and delivery fails open');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed-stale]')),
        'dropping an expired snapshot must be logged loudly');
    } finally {
      Date.now = realNow;
      h.restore();
    }
  });

  it('re-checks held quiet-hours events on drain and drops newly blocked ones', async () => {
    const blocked = JSON.stringify({ eventType: 'rss_alert', severity: 'high', payload: { title: 'Held phishing lure', link: EVIL } });
    const clean = JSON.stringify({ eventType: 'rss_alert', severity: 'high', payload: { title: 'Held clean story', link: 'https://reuters.com/x' } });
    const h = installHarness({ smembers: [EVIL], held: [blocked, clean] });
    try {
      await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'user-1', variant: 'full' });
      assert.equal(h.calls.telegram, 1, 'the clean held event is still delivered');
      const sent = h.calls.telegramBodies.join('\n');
      assert.ok(sent.includes('Held clean story'));
      assert.ok(!sent.includes('Held phishing lure'), 'a link blocked after hold must not ride the batch');
      assert.ok(sent.includes('1 held alert'), 'the batch count excludes the suppressed event');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')), 'drain-time suppression is logged');
    } finally {
      h.restore();
    }
  });

  it('discards a held queue whose every event is now blocked, without sending', async () => {
    const blocked = JSON.stringify({ eventType: 'rss_alert', severity: 'high', payload: { title: 'Only lure', link: EVIL } });
    const h = installHarness({ smembers: [EVIL], held: [blocked] });
    try {
      await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'user-1', variant: 'full' });
      assert.equal(h.calls.telegram, 0);
      assert.deepEqual(h.calls.del, ['digest:quiet-held:user-1:full']);
    } finally {
      h.restore();
    }
  });
});

