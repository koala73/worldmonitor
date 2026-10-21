/**
 * Failing-first proof for #8401, service-worker half.
 *
 * 1. `api/notification-suppressions.js` splits the Redis set into exact-URL
 *    digests and `host:` entries, serves them anonymously with a 60s shared
 *    cache, and fails open with `unavailable: true` when Redis cannot be read.
 * 2. `public/link-suppression-check.js` matches clicks against that snapshot
 *    (exact + host/subdomain) inside a vm sandbox.
 * 3. `public/push-handler.js` consults the check on notificationclick: a
 *    blocked click shows the blocked notice and never touches clients, while
 *    a clean click (or an unreachable endpoint) navigates as before.
 *
 * Run: node --test tests/notification-sw-link-suppression.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const EVIL = 'https://evil.example/phish?x=1';
const LONG_EVIL = `https://evil.example/phish?payload=${'x'.repeat(2_100)}`;
const digestUrl = (url) => `sha256:${createHash('sha256').update(url).digest('hex')}`;
const EVIL_DIGEST = digestUrl(EVIL);
const LONG_EVIL_DIGEST = digestUrl(LONG_EVIL);

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalEnvUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalEnvToken = process.env.UPSTASH_REDIS_REST_TOKEN;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  if (originalEnvUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalEnvUrl;
  if (originalEnvToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnvToken;
});

// ── Edge endpoint ──────────────────────────────────────────────────────

describe('notification-suppressions edge endpoint (#8401)', () => {
  it('splits exact URLs and host: entries, anonymously, with a 60s cache', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: [EVIL, LONG_EVIL, 'host:evil.example', 'garbage {{{', null, 42] }),
    });
    const { default: handler } = await import('../api/notification-suppressions.js?edge-split');
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.suppressed, [EVIL_DIGEST, LONG_EVIL_DIGEST]);
    assert.ok(!JSON.stringify(body).includes(EVIL), 'anonymous response must not expose exact URLs');
    assert.deepEqual(body.hosts, ['evil.example']);
    assert.ok(typeof body.updatedAt === 'string');
    assert.equal(body.unavailable, undefined);
    assert.match(res.headers.get('Cache-Control') ?? '', /s-maxage=60/);
  });

  it('fails open with unavailable:true when Redis cannot be read', async () => {
    console.warn = () => {};
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const { readSuppressionSnapshot, default: handler } = await import('../api/notification-suppressions.js?edge-unavail');
    // Snapshot helper reports unreadable; the handler maps it to the
    // fail-open shape with no-store (never CDN-cache the fail-open).
    const snap = await readSuppressionSnapshot();
    assert.equal(snap.readable, false);
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.suppressed, []);
    assert.deepEqual(body.hosts, []);
    assert.equal(body.unavailable, true);
    assert.match(res.headers.get('Cache-Control') ?? '', /no-store/);
  });

  it('logs safe reasons for every unreadable Redis shape', async () => {
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    const { readSuppressionSnapshot, default: handler } = await import('../api/notification-suppressions.js?edge-logging');

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await readSuppressionSnapshot();
    await handler(new Request('https://worldmonitor.app/api/notification-suppressions'));

    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
    await readSuppressionSnapshot(async () => ({ ok: false, status: 503 }));
    await readSuppressionSnapshot(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }));
    await readSuppressionSnapshot(async () => ({ ok: true, json: async () => ({ result: null }) }));
    const timeout = new Error(`request failed for ${EVIL}`);
    timeout.name = 'TimeoutError';
    await readSuppressionSnapshot(async () => { throw timeout; });

    assert.ok(warnings.some((line) => line.includes('reason=missing-credentials source=upstash-smembers')));
    assert.ok(warnings.some((line) => line.includes('reason=missing-credentials source=handler')));
    assert.ok(warnings.some((line) => line.includes('reason=redis-http-error source=upstash-smembers status=503')));
    assert.ok(warnings.some((line) => line.includes('reason=malformed-json source=upstash-smembers')));
    assert.ok(warnings.some((line) => line.includes('reason=invalid-result source=upstash-smembers')));
    assert.ok(warnings.some((line) => line.includes('reason=redis-request-error source=upstash-smembers error=TimeoutError')));
    assert.ok(!warnings.join('\n').includes('stub-token'));
    assert.ok(!warnings.join('\n').includes(EVIL));
  });

  it('keeps non-ASCII host entries as the punycode host a URL parses to', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: ['host:b\u00fccher.example'] }) });
    const { default: handler } = await import('../api/notification-suppressions.js?edge-idn');
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions'));
    assert.deepEqual((await res.json()).hosts, ['xn--bcher-kva.example']);
  });

  it('refuses query strings so a random query cannot bypass the shared cache into Redis', async () => {
    let redisReads = 0;
    globalThis.fetch = async () => { redisReads++; return { ok: true, json: async () => ({ result: [] }) }; };
    const { default: handler } = await import('../api/notification-suppressions.js?edge-query');
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions?bust=123'));
    assert.equal(res.status, 400);
    assert.equal(redisReads, 0, 'a cache-busting query must not reach Redis');
    assert.match(res.headers.get('Cache-Control') ?? '', /s-maxage/, 'the refusal itself is cacheable');
  });

  it('rejects non-GET methods', async () => {
    const { default: handler } = await import('../api/notification-suppressions.js?edge-method');
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions', { method: 'POST' }));
    assert.equal(res.status, 405);
  });
});

// ── SW check module in a vm sandbox ────────────────────────────────────

function makeSwSandbox({ snapshot = null, fetchImpl = null, showNotificationImpl = null, cachePutImpl = null } = {}) {
  const listeners = new Map();
  const shown = [];
  const windowClients = [];
  let opened = null;
  const cacheStore = new Map();

  const self = {
    location: { origin: 'https://worldmonitor.app' },
    crypto: globalThis.crypto,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    registration: {
      showNotification(title, opts) {
        shown.push({ title, opts });
        if (showNotificationImpl) return showNotificationImpl(title, opts);
        return Promise.resolve();
      },
    },
  };
  const clients = {
    matchAll: async () => windowClients,
    openWindow: async (url) => { opened = url; return { url }; },
  };
  const caches = {
    async match() { return null; },
    async open() {
      return {
        async put(k, v) {
          if (cachePutImpl) await cachePutImpl(k, v);
          cacheStore.set(k, v);
        },
      };
    },
  };
  const fetchFn = fetchImpl ?? (async () => ({
    ok: true,
    json: async () => snapshot,
  }));
  const ctx = vm.createContext({
    self, clients, caches, fetch: fetchFn, URL, Headers, Response,
    AbortController, TextEncoder, setTimeout, clearTimeout, Date,
  });
  vm.runInContext(readFileSync(resolve(ROOT, 'public', 'link-suppression-check.js'), 'utf-8'), ctx);
  vm.runInContext(readFileSync(resolve(ROOT, 'public', 'push-handler.js'), 'utf-8'), ctx);
  return {
    self, clients, shown, windowClients, cacheStore,
    get opened() { return opened; },
    emit(name, event) {
      for (const fn of listeners.get(name) ?? []) fn(event);
    },
  };
}

function notifClickEvent(data, tag = 'rss:1') {
  const waits = [];
  return {
    notification: { data, tag, close() {} },
    waitUntil(p) { waits.push(Promise.resolve(p)); },
    waits,
  };
}

describe('link-suppression-check.js matcher (#8401)', () => {
  it('matches exact URLs and host subdomains, rejects neighbours', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [EVIL_DIGEST], hosts: [] } });
    const check = box.self.wmLinkSuppression;
    assert.ok(check, 'wmLinkSuppression must be exposed');
    assert.equal(await check.checkLinkSuppressed(EVIL), true);
    assert.equal(await check.checkLinkSuppressed('https://other.example/'), false);
  });

  it('host entries cover subdomains but not sibling domains', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: ['evil.example'] } });
    const check = box.self.wmLinkSuppression;
    assert.equal(await check.checkLinkSuppressed('https://www.evil.example/a'), true);
    assert.equal(await check.checkLinkSuppressed('https://not-evil.example/'), false);
  });

  it('host entries match non-default ports (parity with the relay matcher)', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: ['evil.example'] } });
    const check = box.self.wmLinkSuppression;
    assert.equal(await check.checkLinkSuppressed('https://evil.example:8443/x'), true);
  });

  it('host entries suppress a valid URL longer than 2,048 characters', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: ['evil.example'] } });
    const check = box.self.wmLinkSuppression;
    assert.equal(await check.checkLinkSuppressed(LONG_EVIL), true);
  });

  it('unavailable snapshot fails open to navigation', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: [], unavailable: true } });
    const check = box.self.wmLinkSuppression;
    assert.equal(await check.checkLinkSuppressed(EVIL), false);
  });
});

describe('push-handler.js notificationclick suppression (#8401)', () => {
  it('loads link-suppression-check.js before push-handler.js (order is load-bearing)', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { fileURLToPath: toPath } = await import('node:url');
    const { dirname: dir, resolve: join } = await import('node:path');
    const root = join(dir(toPath(import.meta.url)), '..');
    const vite = read(join(root, 'vite.config.ts'), 'utf-8');
    const match = vite.match(/importScripts:\s*\[([^\]]*)\]/);
    assert.ok(match, 'vite.config.ts must declare workbox importScripts');
    const list = match[1] ?? '';
    const suppIdx = list.indexOf('/link-suppression-check.js');
    const pushIdx = list.indexOf('/push-handler.js');
    assert.ok(suppIdx !== -1, 'importScripts must include /link-suppression-check.js');
    assert.ok(pushIdx !== -1, 'importScripts must include /push-handler.js');
    assert.ok(suppIdx < pushIdx, 'link-suppression-check.js must load BEFORE push-handler.js so notificationclick can consult it');
  });
  it('blocked click shows the blocked notice and never touches clients', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [EVIL_DIGEST], hosts: [] } });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, null, 'blocked click must not openWindow');
    assert.equal(box.shown.length, 1);
    assert.equal(box.shown[0].title, 'Link blocked by WorldMonitor');
  });

  it('never opens a blocked URL when the replacement notice rejects', async () => {
    const box = makeSwSandbox({
      snapshot: { suppressed: [EVIL_DIGEST], hosts: [] },
      showNotificationImpl: async () => { throw new Error('notification permission changed'); },
    });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, null, 'blocked decision must remain terminal');
    assert.equal(box.shown.length, 1, 'replacement notice was attempted');
  });

  it('keeps the click task alive until a fetched snapshot is stored', async () => {
    let markPutStarted;
    let releasePut;
    const putStarted = new Promise((resolveStarted) => { markPutStarted = resolveStarted; });
    const putBlocked = new Promise((resolvePut) => { releasePut = resolvePut; });
    const box = makeSwSandbox({
      snapshot: { suppressed: [EVIL_DIGEST], hosts: [] },
      cachePutImpl: async () => {
        markPutStarted();
        await putBlocked;
      },
    });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    await putStarted;

    let settled = false;
    ev.waits[0].then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'waitUntil must retain the cache write');

    releasePut();
    await ev.waits[0];
    assert.equal(box.cacheStore.has('/api/notification-suppressions'), true);
    assert.equal(box.opened, null);
  });

  it('a suppressed off-origin link never opens its own tab (check precedes the crossOrigin branch)', async () => {
    for (const url of ['https://www.evil.example/a', '//evil.example/x']) {
      const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: ['evil.example'] } });
      let navigated = null;
      box.windowClients.push({
        url: 'https://worldmonitor.app/',
        focus: async () => {},
        navigate: async (to) => { navigated = to; },
      });
      const ev = notifClickEvent({ url });
      box.emit('notificationclick', ev);
      for (const p of ev.waits) await p;
      assert.equal(box.opened, null, `${url}: a blocked off-origin link must not get a new tab`);
      assert.equal(navigated, null, `${url}: nor be handed the dashboard tab`);
      assert.equal(box.shown.length, 1, `${url}: the blocked notice replaces it`);
    }
  });

  it('an unblocked off-origin link still opens its own tab after the check', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: ['evil.example'] } });
    const ev = notifClickEvent({ url: 'https://reuters.com/world/story' });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, 'https://reuters.com/world/story');
  });

  it('clean click opens as before when nothing is blocked', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: [] } });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, EVIL);
    assert.equal(box.shown.length, 0);
  });

  it('unreachable endpoint fails open to navigation', async () => {
    const box = makeSwSandbox({ fetchImpl: async () => { throw new Error('down'); } });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, EVIL, 'endpoint outage must not strand the click');
  });

  it('suppressed-notice clicks bypass the check (no re-entry loop)', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [EVIL], hosts: [] } });
    const waits = [];
    const ev = {
      notification: { data: { url: '/', tag: 'suppressed:rss:1' }, tag: 'suppressed:rss:1', close() {} },
      waitUntil(p) { waits.push(Promise.resolve(p)); },
    };
    box.emit('notificationclick', ev);
    for (const p of waits) await p;
    assert.equal(box.opened, '/', 'notice click must open the dashboard without re-checking');
    assert.equal(box.shown.length, 0, 'notice click must not show another notice');
  });
});
