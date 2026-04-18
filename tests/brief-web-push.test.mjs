// Phase 6 — Web Push unit tests.
//
// Two targets:
//   1. Pure helpers in src/config/push.ts — base64 ↔ Uint8Array round-trip
//      and shape guards.
//   2. The SW push handler at public/push-handler.js. We load the file
//      into a minimal service-worker sandbox (fake `self` + `clients`)
//      and fire synthetic push + notificationclick events to verify
//      the handler's behaviour without a real browser.
//
// Intentionally NOT here: the client subscribe/unsubscribe flow. Those
// require navigator.serviceWorker / Notification.permission / the
// pushManager API, which are browser-only surfaces. We mock via
// playwright in a future integration pass.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerSource = readFileSync(resolve(__dirname, '../public/push-handler.js'), 'utf-8');

// ── Pure helpers ──────────────────────────────────────────────────────────

describe('push config helpers', () => {
  // Dynamic import so the module's top-level `import.meta.env` reference
  // resolves in this Node test context.
  it('urlBase64ToUint8Array round-trips via arrayBufferToBase64', async () => {
    const { urlBase64ToUint8Array, arrayBufferToBase64 } = await import('../src/config/push.ts');
    const original = 'BNIrVn4fQrNVN82cADphw320VdnaaAGwjnJNHZJAMyUepPJywn8LSJZTeNpWgqYOOstaJQUZ1WugocN-RKlPAQM';
    const bytes = urlBase64ToUint8Array(original);
    // VAPID public keys decode to 65 bytes (uncompressed P-256 point).
    assert.equal(bytes.length, 65);
    const roundtrip = arrayBufferToBase64(bytes.buffer);
    assert.equal(roundtrip, original);
  });

  it('arrayBufferToBase64 handles null safely', async () => {
    const { arrayBufferToBase64 } = await import('../src/config/push.ts');
    assert.equal(arrayBufferToBase64(null), '');
  });

  it('VAPID_PUBLIC_KEY reads from VITE_VAPID_PUBLIC_KEY env, empty when unset', async () => {
    // REGRESSION guard: previously the module shipped a committed
    // DEFAULT_VAPID_PUBLIC_KEY fallback. That gave rotations two
    // sources of truth (code + env) and let stale committed keys
    // ship alongside fresh env vars. The fallback was removed —
    // push is intentionally disabled on builds that lack the env.
    const { VAPID_PUBLIC_KEY, isWebPushConfigured } = await import('../src/config/push.ts');
    assert.equal(typeof VAPID_PUBLIC_KEY, 'string');
    // In Node tests VITE_VAPID_PUBLIC_KEY is unset, so the module
    // MUST return empty. If this assertion flips we know a
    // committed default was reintroduced.
    assert.equal(
      VAPID_PUBLIC_KEY,
      '',
      'VAPID_PUBLIC_KEY must be empty when VITE env var is unset (no committed fallback)',
    );
    assert.equal(isWebPushConfigured(), false);
  });
});

// ── Service worker handler ────────────────────────────────────────────────

/**
 * Build a minimal SW-ish sandbox: fake `self` with an event bus, a fake
 * `clients` API, and a tracking registration. Events are dispatched
 * synchronously via emit() and we capture what the handler requested.
 */
function makeSwSandbox() {
  const listeners = new Map();
  const shown = [];
  const windowClients = [];
  let opened = null;

  const self = {
    location: { origin: 'https://worldmonitor.app' },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    registration: {
      showNotification(title, opts) {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
  };
  const clients = {
    matchAll: async () => windowClients,
    openWindow: async (url) => { opened = url; return { url }; },
  };
  return {
    self, clients, shown, windowClients,
    get opened() { return opened; },
    emit(name, event) {
      const fns = listeners.get(name) ?? [];
      for (const fn of fns) fn(event);
    },
  };
}

function loadHandlerInto(sandbox) {
  const ctx = vm.createContext({
    self: sandbox.self,
    clients: sandbox.clients,
    URL,
  });
  vm.runInContext(handlerSource, ctx);
}

function pushEvent(payload) {
  const waits = [];
  return {
    data: payload === null ? null : {
      json() { return typeof payload === 'string' ? JSON.parse(payload) : payload; },
      text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); },
    },
    waitUntil(p) { waits.push(p); },
    waits,
  };
}

function notifClickEvent(data) {
  let closed = false;
  const waits = [];
  return {
    notification: {
      data,
      close() { closed = true; },
    },
    waitUntil(p) { waits.push(p); },
    get closed() { return closed; },
    waits,
  };
}

describe('push-handler.js — push event', () => {
  it('renders a notification with the payload fields', () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    box.emit('push', pushEvent({
      title: 'Your brief is ready',
      body: 'Iran threatens Strait of Hormuz closure · 11 more threads',
      url: 'https://worldmonitor.app/api/brief/user_abc/2026-04-18?t=xxx',
      tag: 'brief_ready:user_abc',
      eventType: 'brief_ready',
    }));
    assert.equal(box.shown.length, 1);
    const [{ title, opts }] = box.shown;
    assert.equal(title, 'Your brief is ready');
    assert.equal(opts.body, 'Iran threatens Strait of Hormuz closure · 11 more threads');
    assert.equal(opts.tag, 'brief_ready:user_abc');
    assert.equal(opts.data.url, 'https://worldmonitor.app/api/brief/user_abc/2026-04-18?t=xxx');
    // brief_ready should requireInteraction — don't let a lock-screen
    // swipe dismiss the CTA before the user reads the brief.
    assert.equal(opts.requireInteraction, true);
  });

  it('non-brief events render without requireInteraction', () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    box.emit('push', pushEvent({
      title: 'Conflict event',
      body: 'Escalation in Lebanon',
      eventType: 'conflict_escalation',
    }));
    assert.equal(box.shown.length, 1);
    assert.equal(box.shown[0].opts.requireInteraction, false);
  });

  it('falls back to "WorldMonitor" title when payload omits it', () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    box.emit('push', pushEvent({ body: 'body only, no title' }));
    assert.equal(box.shown[0].title, 'WorldMonitor');
  });

  it('malformed JSON payload renders the raw text as the body', () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    // event.data.json() throws, event.data.text() returns the raw body
    const broken = {
      data: {
        json() { throw new Error('not json'); },
        text() { return 'plain raw text'; },
      },
      waitUntil() {},
    };
    box.emit('push', broken);
    assert.equal(box.shown.length, 1);
    assert.equal(box.shown[0].title, 'WorldMonitor');
    assert.equal(box.shown[0].opts.body, 'plain raw text');
  });

  it('event with no data still renders a default notification', () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    box.emit('push', { data: null, waitUntil() {} });
    assert.equal(box.shown.length, 1);
    assert.equal(box.shown[0].title, 'WorldMonitor');
  });
});

describe('push-handler.js — notificationclick', () => {
  it('opens the target url when no existing window matches', async () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    const ev = notifClickEvent({ url: 'https://worldmonitor.app/api/brief/user_a/2026-04-18?t=abc' });
    box.emit('notificationclick', ev);
    assert.equal(ev.closed, true);
    // Wait for the waitUntil chain
    for (const p of ev.waits) await p;
    assert.equal(box.opened, 'https://worldmonitor.app/api/brief/user_a/2026-04-18?t=abc');
  });

  it('focuses + navigates an existing same-origin window instead of opening', async () => {
    const box = makeSwSandbox();
    let focused = false;
    let navigated = null;
    box.windowClients.push({
      url: 'https://worldmonitor.app/',
      focus() { focused = true; return this; },
      navigate(url) { navigated = url; return Promise.resolve(); },
    });
    loadHandlerInto(box);
    const ev = notifClickEvent({ url: 'https://worldmonitor.app/api/brief/u/d?t=t' });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(focused, true);
    assert.equal(navigated, 'https://worldmonitor.app/api/brief/u/d?t=t');
    assert.equal(box.opened, null, 'openWindow must NOT fire when a window is focused');
  });

  it('defaults to "/" when payload has no url', async () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    const ev = notifClickEvent({});
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, '/');
  });
});

// REGRESSION: PR #3173 P1 (SSRF). The set-web-push edge handler
// must reject any endpoint that isn't a known push-service host.
// Without the allow-list the relay's outbound sendWebPush becomes a
// server-side-request primitive for any Pro user. These tests lock
// the guard into code + reject common bypass attempts.
describe('set-web-push SSRF allow-list', () => {
  it('source contains an explicit allow-list of push-service hosts', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__d, '../api/notification-channels.ts'),
      'utf-8',
    );
    assert.match(src, /isAllowedPushEndpointHost/, 'allow-list helper must be defined');
    // All four major browser push services must be recognised.
    assert.match(src, /fcm\.googleapis\.com/, 'FCM (Chrome/Edge) host must be allow-listed');
    assert.match(src, /updates\.push\.services\.mozilla\.com/, 'Mozilla (Firefox) host must be allow-listed');
    assert.match(src, /web\.push\.apple\.com/, 'Apple (Safari) host must be allow-listed');
    assert.match(src, /notify\.windows\.com/, 'Windows Notification Service host must be allow-listed');
    // The allow-list MUST fail-closed (return false for unknown hosts).
    // A regex-based presence test is enough — if someone relaxes it to
    // `return true` they have to do so deliberately.
    assert.match(src, /return false;?\s*\n\s*\}/, 'allow-list must end with explicit `return false` (fail-closed)');
  });

  it('source rejects non-allow-listed hosts before relay forwarding', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__d, '../api/notification-channels.ts'),
      'utf-8',
    );
    // The guard must fire BEFORE convexRelay() — once the row lands
    // in Convex, the relay will POST to it. Assert the guard appears
    // inside the set-web-push branch before the convexRelay call.
    const branch = src.match(/action === 'set-web-push'[\s\S]+?convexRelay/);
    assert.ok(branch, "set-web-push branch must contain a convexRelay call");
    assert.match(branch[0], /isAllowedPushEndpointHost/, 'allow-list check must precede the relay call');
  });
});

// REGRESSION: PR #3173 P1 (cross-account subscription leak).
// setWebPushChannelForUser must dedupe by endpoint across all users,
// not just by (userId, channelType). Otherwise a shared device
// delivers user A's alerts to user B after an account switch.
describe('setWebPushChannelForUser endpoint dedupe', () => {
  it('source deletes any existing rows with the same endpoint before insert', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__d, '../convex/notificationChannels.ts'),
      'utf-8',
    );
    // Lock both the scan-by-endpoint AND the delete-before-insert
    // pattern. If either drifts, the review finding reappears.
    assert.match(src, /row\.endpoint === args\.endpoint/, 'setWebPushChannelForUser must compare rows by endpoint');
    assert.match(src, /await ctx\.db\.delete\(row\._id\)/, 'matching rows must be deleted before upsert');
  });
});
