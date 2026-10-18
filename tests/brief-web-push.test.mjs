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
import {
  makeSwSandbox,
  loadHandlerInto,
  pushEvent,
  notifClickEvent,
  addWindowClient,
  clickNotification,
  PRIMARY_ORIGIN,
  VERTICAL_ORIGIN,
  SERVING_ORIGINS,
} from './helpers/sw-sandbox.mjs';
import {
  FIRST_PARTY_PATH_LAUNDERING,
  ORIGIN_SPOOFING_SCHEMES,
  LOOKALIKE_HOSTS,
  UNPARSEABLE,
  HOSTILE_SCHEMES,
  rawsOf,
} from './fixtures/hostile-push-urls.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Sandbox, handler loader, and event factories live in ./helpers/sw-sandbox.mjs
// so the relay suite can drive the same handler (see the cross-module test there).

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
    // classifyClickTarget also runs on the push event, so an apex-absolute
    // payload is normalized onto the serving origin before it is stored.
    assert.equal(opts.data.url, `${box.origin}/api/brief/user_abc/2026-04-18?t=xxx`);
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
    assert.equal(box.opened, `${box.origin}/api/brief/user_a/2026-04-18?t=abc`);
  });

  it('focuses + navigates an existing same-origin window instead of opening', async () => {
    const box = makeSwSandbox();
    let focused = false;
    let navigated = null;
    box.windowClients.push({
      url: `${box.origin}/`,
      focus() { focused = true; return this; },
      navigate(url) { navigated = url; return Promise.resolve(); },
    });
    loadHandlerInto(box);
    const ev = notifClickEvent({ url: 'https://worldmonitor.app/api/brief/u/d?t=t' });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(focused, true);
    assert.equal(navigated, `${box.origin}/api/brief/u/d?t=t`);
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

// REGRESSION: off-origin notification click targets.
//
// Push payload URLs come from event.payload.link — published verbatim by Pro
// accounts through /api/notify or ingested verbatim from external RSS feeds.
// The article must stay reachable, so an off-origin https link is kept and
// opened in its OWN tab. What must never happen is navigating the
// already-open dashboard tab there: that replaces a trusted surface with a
// page WorldMonitor does not control (phishing pivot / tab-nabbing).
// Relay-side scheme discipline: tests/notification-relay-push-click-origin.test.mjs.
describe('push-handler.js — off-origin click targets', () => {
  const OFF_ORIGIN = [
    ['https://example.com/wm-verify-account', 'https://example.com/wm-verify-account'],
    ['//example.com/wm-verify-account', 'https://example.com/wm-verify-account'],
    ['https://worldmonitor.app.evil.com/', 'https://worldmonitor.app.evil.com/'],
  ];
  // Not same-origin, not plain https, or carrying credentials purely to make a
  // hostile host read as ours — these can never become a navigation. Taken from
  // the shared corpus, not copied: this suite introduced that fixture to stop
  // the two suites drifting, so keeping a local list here would preserve
  // exactly the drift the fixture exists to remove.
  const REJECTED = rawsOf(HOSTILE_SCHEMES);

  it('opens an off-origin article in a NEW tab instead of navigating the dashboard', async () => {
    for (const [raw, expected] of OFF_ORIGIN) {
      const box = makeSwSandbox();
      let navigated = null;
      let focused = false;
      // The client must sit on the origin actually serving the worker,
      // otherwise it is never same-origin, the reuse branch is unreachable,
      // and "we did not navigate the dashboard" passes because there was no
      // dashboard tab to navigate.
      box.windowClients.push({
        url: `${box.origin}/`,
        focus() { focused = true; return this; },
        navigate(url) { navigated = url; return Promise.resolve(); },
      });
      loadHandlerInto(box);
      const ev = notifClickEvent({ url: raw });
      box.emit('notificationclick', ev);
      for (const p of ev.waits) await p;
      assert.equal(navigated, null, `must NOT navigate the dashboard tab to ${raw}`);
      assert.equal(focused, false, `must NOT steal focus for ${raw}`);
      assert.equal(box.opened, expected, `must open ${raw} in a new tab`);
    }
  });

  it('collapses non-https, non-same-origin targets to the dashboard', async () => {
    for (const hostile of REJECTED) {
      const box = makeSwSandbox();
      loadHandlerInto(box);
      box.emit('push', pushEvent({ title: 'Security notice', body: 'b', url: hostile }));
      assert.equal(box.shown[0].opts.data.url, '/', `must not store ${hostile}`);

      const ev = notifClickEvent({ url: hostile });
      box.emit('notificationclick', ev);
      for (const p of ev.waits) await p;
      assert.equal(box.opened, '/', `must not open ${hostile}`);
    }
  });

  it('never navigates an existing window off-origin, whatever the payload', async () => {
    for (const [raw] of [...OFF_ORIGIN, ...REJECTED.map(r => [r])]) {
      const box = makeSwSandbox();
      let navigated = null;
      box.windowClients.push({
        url: `${box.origin}/`,
        focus() { return this; },
        navigate(url) { navigated = url; return Promise.resolve(); },
      });
      loadHandlerInto(box);
      const ev = notifClickEvent({ url: raw });
      box.emit('notificationclick', ev);
      for (const p of ev.waits) await p;
      assert.ok(
        navigated === null || new URL(navigated, box.origin).origin === box.origin,
        `navigate() must stay on-origin, got ${navigated} for ${raw}`,
      );
    }
  });

  it('still reuses the dashboard tab for same-origin targets', async () => {
    const box = makeSwSandbox();
    let navigated = null;
    let focused = false;
    box.windowClients.push({
      url: `${box.origin}/`,
      focus() { focused = true; return this; },
      navigate(url) { navigated = url; return Promise.resolve(); },
    });
    loadHandlerInto(box);
    box.emit('push', pushEvent({ title: 't', url: 'https://worldmonitor.app/dashboard?x=1' }));
    assert.equal(box.shown[0].opts.data.url, `${box.origin}/dashboard?x=1`);
    const ev = notifClickEvent({ url: '/settings' });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(navigated, '/settings', 'the open dashboard tab is reused');
    assert.equal(focused, true);
    assert.equal(box.opened, null, 'openWindow must NOT fire when a window is reused');
  });

  // openWindow rejects with InvalidAccessError when no window in the origin
  // has transient activation. `return clients.openWindow(...)` inside the
  // try block hands that rejection straight to event.waitUntil() instead of
  // the local catch, which surfaces an unhandled rejection in the SW.
  it('swallows an openWindow rejection instead of rejecting waitUntil', async () => {
    for (const url of ['https://example.com/article', '/settings']) {
      const box = makeSwSandbox();
      box.clients.openWindow = async () => { throw new Error('InvalidAccessError'); };
      loadHandlerInto(box);
      const ev = notifClickEvent({ url });
      box.emit('notificationclick', ev);
      await assert.doesNotReject(
        Promise.all(ev.waits),
        `waitUntil must not reject when openWindow fails for ${url}`,
      );
    }
  });

  // A focus rejection after a SUCCESSFUL navigate must not also open a tab.
  //
  // #8384 changed `return c.focus()` to `return await c.focus()`, which
  // correctly stops the rejection escaping into waitUntil() — but it also
  // routes that rejection into the inner catch, so the loop falls through and
  // openWindow fires for a URL the dashboard tab was already navigated to. The
  // user gets two tabs on the same page: exactly the duplicated app state this
  // branch's own comment says it exists to avoid.
  //
  // Asserting only doesNotReject cannot see that. Mutating the catch to an
  // early `return` — which disables the fallback entirely — left the old
  // assertion green.
  it('does not open a duplicate tab when focus rejects after a successful navigate', async () => {
    const box = makeSwSandbox();
    let navigated = null;
    box.windowClients.push({
      url: `${box.origin}/`,
      focus() { return Promise.reject(new Error('focus denied')); },
      navigate(url) { navigated = url; return Promise.resolve(); },
    });
    loadHandlerInto(box);
    const ev = notifClickEvent({ url: '/settings' });
    box.emit('notificationclick', ev);
    await assert.doesNotReject(Promise.all(ev.waits));
    assert.equal(navigated, '/settings', 'the open tab is still navigated');
    assert.equal(box.opened, null, 'content was already delivered — no second tab');
  });

  // The fallback itself must stay intact: when NO same-origin client exists,
  // openWindow is still the right outcome.
  it('still opens a window when no same-origin client exists', async () => {
    const box = makeSwSandbox();
    loadHandlerInto(box);
    const ev = notifClickEvent({ url: '/settings' });
    box.emit('notificationclick', ev);
    await Promise.all(ev.waits);
    assert.equal(box.opened, '/settings');
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

// REGRESSION: the service worker must be origin-agnostic.
//
// The worker is served from www.worldmonitor.app and from five vertical
// subdomains; the apex only ever 301s. But the relay stamps apex-absolute URLs
// into payloads, so an origin comparison classifies them cross-origin and opens
// a duplicate tab instead of reusing the dashboard — the row PR #8384's own
// table calls "unchanged". Already-displayed notifications never expire and are
// dispatched to whatever worker is active at click time, so the worker is the
// only half that can fix payloads already sitting in notification centers.
//
// The rewrite that fixes that is also the riskiest line here: re-attaching a
// preserved path to self.location.origin is a relativization, and a first-party
// URL whose pathname begins `//` turns into an off-origin destination on the
// dashboard tab. That is the exact attack the click guard exists to stop, so it
// gets its own named case below.
describe('push-handler.js — origin-agnostic click targets', () => {
  const brief = '/api/brief/u/2026-09-19?t=signed-token';

  for (const origin of SERVING_ORIGINS) {
    it(`reuses the open dashboard tab for an apex-absolute target on ${origin}`, async () => {
      const box = makeSwSandbox(origin);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: 'https://worldmonitor.app/dashboard' });
      assert.equal(box.opened, null, 'must not open a second tab');
      assert.ok(client.navigated, 'must navigate the open tab');
      assert.equal(
        new URL(client.navigated, origin).href,
        `${origin}/dashboard`,
        'must land on the serving origin',
      );
    });

    it(`reuses the open dashboard tab for a www-absolute target on ${origin}`, async () => {
      const box = makeSwSandbox(origin);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: `${PRIMARY_ORIGIN}/settings` });
      assert.equal(box.opened, null);
      assert.equal(new URL(client.navigated, origin).href, `${origin}/settings`);
    });

    it(`preserves query and fragment when rewriting on ${origin}`, async () => {
      const box = makeSwSandbox(origin);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: `https://worldmonitor.app${brief}` });
      assert.equal(
        new URL(client.navigated, origin).href,
        `${origin}${brief}`,
        'a signed brief token must survive the rewrite',
      );
    });
  }

  it('never navigates the dashboard tab off-origin for a laundered first-party path', async () => {
    for (const origin of SERVING_ORIGINS) {
      for (const { raw, why } of FIRST_PARTY_PATH_LAUNDERING) {
        const box = makeSwSandbox(origin);
        const client = addWindowClient(box);
        loadHandlerInto(box);
        await clickNotification(box, { url: raw });
        // The round-trip origin check fails for these, so they collapse to the
        // dashboard rather than being rewritten. Asserting the destination's
        // ORIGIN — not that the string lacks a `//` prefix — is the point: the
        // backslash spelling passes a prefix check and still resolves to
        // evil.com, so only re-resolution proves the guard held.
        assert.equal(box.opened, null, `${raw} must not open a tab (${why})`);
        assert.equal(client.navigated, '/', `${raw} must collapse to the dashboard (${why})`);
        assert.equal(
          new URL(client.navigated, origin).origin,
          origin,
          `navigate() must stay on-origin for ${raw}`,
        );
      }
    }
  });

  it('does not rewrite a sibling vertical target onto the current origin', async () => {
    const box = makeSwSandbox(PRIMARY_ORIGIN);
    const client = addWindowClient(box);
    loadHandlerInto(box);
    await clickNotification(box, { url: `${VERTICAL_ORIGIN}/dashboard` });
    assert.equal(client.navigated, null, 'a different surface is not ours to rewrite');
    assert.equal(box.opened, `${VERTICAL_ORIGIN}/dashboard`, 'it gets its own tab');
  });

  it('does not rewrite apex-exempt paths that Cloudflare serves on the apex', async () => {
    // Matched against the NORMALIZED pathname, so a dot-segment escaping an
    // exempt prefix is classified by where it actually lands, not how it reads.
    {
      const box = makeSwSandbox(PRIMARY_ORIGIN);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: 'https://worldmonitor.app/oauth/../dashboard' });
      assert.equal(box.opened, null, 'a dot-segment escaping /oauth/ is not apex-served');
      assert.equal(client.navigated, `${PRIMARY_ORIGIN}/dashboard`);
    }
    for (const path of ['/oauth/register', '/mcp', '/.well-known/api-catalog']) {
      const box = makeSwSandbox(PRIMARY_ORIGIN);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: `https://worldmonitor.app${path}` });
      assert.equal(client.navigated, null, `${path} must not be navigated onto www`);
      assert.equal(
        box.opened,
        `https://worldmonitor.app${path}`,
        `${path} is served on the apex and must keep it`,
      );
    }
  });

  it('collapses origin-spoofing schemes before the origin comparison', async () => {
    for (const { raw, why } of ORIGIN_SPOOFING_SCHEMES) {
      const box = makeSwSandbox(PRIMARY_ORIGIN);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: raw });
      assert.equal(client.navigated, '/', `${raw} must collapse to the dashboard (${why})`);
    }
  });

  it('does not rewrite lookalike hosts', async () => {
    for (const { raw } of LOOKALIKE_HOSTS) {
      const box = makeSwSandbox(PRIMARY_ORIGIN);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: raw });
      assert.equal(client.navigated, null, `${raw} is not first-party`);
      assert.equal(box.opened, raw, `${raw} gets its own tab`);
    }
  });

  it('collapses unparseable targets to the dashboard', async () => {
    for (const { raw, why } of UNPARSEABLE) {
      const box = makeSwSandbox(PRIMARY_ORIGIN);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: raw });
      assert.equal(client.navigated, '/', `${raw} must collapse (${why})`);
    }
  });
});

// The worker hand-copies the Cloudflare apex-exemption list because a service
// worker cannot import from a test module — making it a THIRD uncoordinated
// copy (the zone rule, the published-corpus guard, and now this). If the zone
// gains a sixth exempt path and only one copy learns about it, the worker
// silently rewrites it and reproduces the #4938 POST-to-GET 405. This binds the
// two in-repo copies so they cannot drift apart unnoticed.
describe('push-handler.js — apex exemption list stays in sync', () => {
  it('mirrors APEX_SERVED from the published-corpus guard', () => {
    const read = (rel) => readFileSync(resolve(__dirname, rel), 'utf-8');
    const patternsIn = (src, constName) => {
      const block = src.match(new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
      assert.ok(block, `${constName} must exist`);
      return (block[1].match(/\/\^[^\n,]*\//g) ?? []).map((p) => p.trim()).sort();
    };

    const guard = patternsIn(read('./agent-corpus-canonical-host.test.mjs'), 'APEX_SERVED');
    const worker = patternsIn(read('../public/push-handler.js'), 'APEX_SERVED_PATHS');
    // THREE copies exist, not two: the corpus guard, the worker, and the relay.
    // Binding only two left the relay's free to drift, reproducing the #4938
    // POST-to-GET 405 on the half that talks to push services.
    const relay = patternsIn(read('../scripts/notification-relay.cjs'), 'APEX_SERVED_PATHS');

    assert.ok(guard.length >= 5, 'the corpus guard must still carry the exemption list');
    assert.deepEqual(
      worker,
      guard,
      'public/push-handler.js must exempt exactly the paths Cloudflare serves on the apex',
    );
    assert.deepEqual(
      relay,
      guard,
      'scripts/notification-relay.cjs must exempt exactly the same paths',
    );
  });

  it('keeps the generic first-party host list identical across both halves', () => {
    // The other duplicated policy, and the one that decides what counts as
    // "the dashboard". It had no guard at all: if one side gained a host the
    // other did not, the relay would relativize a target the worker refuses to
    // rewrite — the two halves silently disagreeing, which is the bug class
    // this whole change exists to remove.
    const read = (rel) => readFileSync(resolve(__dirname, rel), 'utf-8');
    const hostsIn = (src) => {
      const block = src.match(/GENERIC_FIRST_PARTY_HOSTS\s*=\s*\[([^\]]*)\]/);
      assert.ok(block, 'GENERIC_FIRST_PARTY_HOSTS must exist');
      return (block[1].match(/'[^']+'/g) ?? []).map((h) => h.replace(/'/g, '')).sort();
    };
    const worker = hostsIn(read('../public/push-handler.js'));
    const relay = hostsIn(read('../scripts/notification-relay.cjs'));
    assert.ok(worker.length >= 2, 'the worker must carry the generic host list');
    assert.deepEqual(relay, worker, 'both halves must agree on what "the dashboard" means');
  });
});
