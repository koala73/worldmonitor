/**
 * Conversion-funnel instrumentation policy (#4931).
 *
 * Source-extraction guards (same pattern as other policy tests): these
 * invariants are cheap to delete silently in a refactor and expensive to
 * notice — each one going missing blinds a segment of the funnel without
 * breaking any runtime behavior.
 *
 *  1. UMAMI_DOMAINS must list www.worldmonitor.app — the apex 301s to www in
 *     production and the Umami tracker's data-domains check is an EXACT
 *     hostname match; dropping www silently disables ALL dashboard analytics
 *     on the canonical host (the pre-#4931 state).
 *  2. The typed event catalog must contain the funnel events.
 *  3. startCheckout (dashboard) fires checkout-start; the checkout-return
 *     reconciliation fires checkout-success / checkout-failed.
 *  4. The /pro SPA and welcome landing must load the tracker with www listed
 *     and the static CSP nonce, and the /pro checkout service must fire
 *     checkout-start for both the direct and post-sign-in resume paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('UMAMI_DOMAINS covers the canonical www host', () => {
  const src = read('src/services/analytics.ts');
  const m = src.match(/const UMAMI_DOMAINS = '([^']+)'/);
  assert.ok(m, 'UMAMI_DOMAINS constant not found');
  const domains = m[1].split(',');
  assert.ok(domains.includes('www.worldmonitor.app'),
    'www.worldmonitor.app missing from UMAMI_DOMAINS — analytics dead on the canonical host');
  assert.ok(domains.includes('worldmonitor.app'),
    'apex worldmonitor.app missing from UMAMI_DOMAINS');
});

test('funnel events exist in the typed catalog', () => {
  const src = read('src/services/analytics.ts');
  for (const ev of ['checkout-start', 'checkout-success', 'checkout-failed']) {
    assert.ok(src.includes(`'${ev}': true`), `event '${ev}' missing from EVENTS catalog`);
  }
});

test('dashboard checkout entry fires checkout-start', () => {
  const src = read('src/services/checkout.ts');
  assert.ok(src.includes('trackCheckoutStart(productId'),
    'startCheckout no longer fires trackCheckoutStart — funnel start is blind');
});

test('checkout-return reconciliation fires success/failed events', () => {
  const src = read('src/app/panel-layout.ts');
  assert.ok(src.includes('trackCheckoutSuccess('),
    'checkout-return success path no longer fires trackCheckoutSuccess');
  assert.ok(src.includes('trackCheckoutFailed('),
    'checkout-return failed path no longer fires trackCheckoutFailed');
});

test('/pro and welcome pages load the Umami tracker (www + nonce)', () => {
  for (const page of ['pro-test/index.html', 'pro-test/welcome.html']) {
    const html = read(page);
    const tag = html.match(/<script[^>]+abacus\.worldmonitor\.app\/script\.js[^>]*>/);
    assert.ok(tag, `${page}: Umami tracker script tag missing`);
    assert.ok(tag[0].includes('data-website-id="e8800335-c853-46a8-8497-c993ed2f58bc"'),
      `${page}: tracker website id missing/changed`);
    assert.ok(/data-domains="[^"]*www\.worldmonitor\.app/.test(tag[0]),
      `${page}: www.worldmonitor.app missing from tracker data-domains`);
    assert.ok(tag[0].includes('nonce="wm-static-bootstrap"'),
      `${page}: static CSP nonce missing — strict-dynamic CSP will block the tracker`);
  }
});

test('/pro and welcome entries initialize DebugBear RUM', () => {
  for (const entry of ['pro-test/src/main.tsx', 'pro-test/src/welcome-main.tsx']) {
    const src = read(entry);
    assert.ok(
      src.includes("import { initDebugBearRum } from './debugbear-rum'"),
      `${entry}: DebugBear RUM import missing`,
    );
    assert.ok(src.includes('initDebugBearRum();'), `${entry}: DebugBear RUM init missing`);
  }
});

test('/pro checkout service fires checkout-start on both paths', () => {
  const src = read('pro-test/src/services/checkout.ts');
  // Round-2 F4 (Greptile): asserting only the surface labels would still
  // pass if the trackFunnelEvent calls were deleted around them. Extract
  // the actual checkout-start emissions and check each surface is wired
  // to one.
  const emissions = src.match(/trackFunnelEvent\(\s*'checkout-start'[\s\S]{0,300}?\}\s*\)/g) ?? [];
  assert.ok(emissions.some((call) => call.includes("'pro-page'")),
    "no trackFunnelEvent('checkout-start', …surface:'pro-page') emission in startCheckout");
  assert.ok(emissions.some((call) => call.includes("'pro-resume'")),
    "no trackFunnelEvent('checkout-start', …surface:'pro-resume') emission in tryResumeCheckoutFromUrl");
});

test('tracker tags are async and the pro SPA excludes query strings', () => {
  for (const page of ['pro-test/index.html', 'pro-test/welcome.html']) {
    const tag = read(page).match(/<script[^>]+abacus\.worldmonitor\.app\/script\.js[^>]*>/)[0];
    assert.ok(/\basync\b/.test(tag),
      `${page}: tracker must be async — a plain defer script delays DOMContentLoaded behind the analytics host`);
  }
  const proTag = read('pro-test/index.html').match(/<script[^>]+abacus[^>]*>/)[0];
  assert.ok(proTag.includes('data-exclude-search="true"'),
    'pro-test/index.html: data-exclude-search missing — checkout-intent (wm_checkout_*) and Clerk handshake params would land in analytics');
});

test('checkout-success is durable across the entitlement reload', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('sessionStorage.setItem(CHECKOUT_SUCCESS_PENDING_KEY'),
    'trackCheckoutSuccess no longer writes the durable marker');
  assert.ok(analytics.includes('clearPendingCheckoutSuccessMarker()'),
    'delivery-time marker clear missing from sendUmamiCall');
  const layout = read('src/app/panel-layout.ts');
  assert.ok(layout.includes('replayPendingCheckoutSuccess()'),
    'panel-layout boot no longer replays a pending checkout-success');
});

test('checkout-failed status is bucketed to a closed vocabulary', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('CHECKOUT_FAILED_STATUSES.has(rawStatus)'),
    'trackCheckoutFailed no longer normalizes the URL-derived status — unbounded cardinality');
});

test('checkout-start product ids are bucketed on both surfaces (round-4 F2)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('bucketProductIdForAnalytics(productId)'),
    'dashboard trackCheckoutStart no longer buckets the (resume-path URL-derived) productId');
  assert.ok(analytics.includes('Object.values(DODO_PRODUCTS)'),
    'dashboard product allowlist no longer derives from the generated catalog');
  const pro = read('pro-test/src/services/checkout.ts');
  const emissions = pro.match(/trackFunnelEvent\(\s*'checkout-start'[\s\S]{0,300}?\}\s*\)/g) ?? [];
  assert.equal(emissions.length, 2, 'expected exactly two /pro checkout-start emissions');
  for (const call of emissions) {
    assert.ok(call.includes('bucketProductIdForAnalytics('),
      `/pro checkout-start emission no longer buckets productId: ${call.slice(0, 80)}…`);
  }
});

test('/pro funnel events queue until the async tracker loads (round-4 F3)', () => {
  const pro = read('pro-test/src/services/checkout.ts');
  assert.ok(pro.includes('pendingFunnelEvents'),
    '/pro trackFunnelEvent no longer queues — the mount-time pro-resume event drops when the async tracker has not loaded');
  assert.ok(pro.includes('FUNNEL_FLUSH_MAX_ATTEMPTS'),
    '/pro funnel flush poll no longer bounded');
});

test('/pro startCheckout has a synchronous re-entrancy guard (round-4 F4)', () => {
  const pro = read('pro-test/src/services/checkout.ts');
  assert.ok(pro.includes('startCheckoutEntryInFlight'),
    'rapid double-clicks double-fire checkout-start without the whole-start guard');
});

test('/pro checkout-start survives the Dodo redirect via sessionStorage handoff (round-5)', () => {
  const pro = read('pro-test/src/services/checkout.ts');
  assert.ok(pro.includes("'wm-pro-funnel-pending'"),
    '/pro no longer persists undelivered checkout-start — the fast signed-in path dies with the redirect');
  assert.ok(pro.includes('persistFunnelEventForReplay(event, data)'),
    '/pro queue branch no longer mirrors events into sessionStorage');
  assert.ok(pro.includes('clearPersistedFunnelEvents()'),
    '/pro flush no longer clears the mirror — delivered events would double-replay on the dashboard');
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes("'wm-pro-funnel-pending'"),
    'dashboard replay no longer reads the /pro handoff key (keys must match across builds)');
  const layout = read('src/app/panel-layout.ts');
  assert.ok(layout.includes('replayPendingProFunnelEvents()'),
    'panel-layout boot no longer replays /pro funnel events');
});

test('/pro replay marker clears on DELIVERY, not on read (round-6)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes("call.data?.replayed === true"),
    'sendUmamiCall no longer clears the pro-funnel marker on confirmed replay delivery');
  assert.ok(analytics.includes('clearPendingProFunnelMarker()'),
    'delivery-time pro-funnel marker clear is missing');
  assert.ok(analytics.includes('JSON.stringify(sanitized.map'),
    'replay no longer rewrites the marker with sanitized survivors — a pre-delivery reload would retry raw junk or nothing');
});
