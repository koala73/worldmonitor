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
const { trackApiAction } = await import('../src/services/analytics.ts');

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
  for (const ev of ['checkout-start', 'checkout-success', 'checkout-failed', 'api-action', 'agent-connect']) {
    assert.ok(src.includes(`'${ev}': true`), `event '${ev}' missing from EVENTS catalog`);
  }
});

test('API outcome telemetry is bounded to successful key lifecycle actions', () => {
  const analytics = read('src/services/analytics.ts');
  const settings = read('src/components/UnifiedSettings.ts');
  assert.ok(analytics.includes("['key-created', 'key-revoked'] as const"),
    'API action vocabulary must stay closed to key lifecycle outcomes');
  assert.ok(analytics.includes("track('api-action', { action })"),
    'API action helper must emit only the normalized action bucket');
  assert.ok(settings.includes("trackApiAction('key-created')"),
    'successful API key creation no longer contributes to API outcomes');
  assert.ok(settings.includes("trackApiAction('key-revoked')"),
    'successful API key revocation no longer contributes to API outcomes');
  assert.ok(!settings.includes('trackApiAction(keyId)'),
    'API telemetry must not include a key identifier');
});

test('API outcome telemetry emits only the closed key lifecycle buckets at runtime', () => {
  const calls = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      umami: {
        track: (event, data) => calls.push({ event, data }),
      },
    },
  });

  try {
    trackApiAction('key-created');
    trackApiAction('key-revoked');
    // The TypeScript signature protects typed callers; this exercises the
    // runtime boundary where an untyped or stale caller can still arrive.
    trackApiAction('key-exported');

    assert.deepEqual(calls, [
      { event: 'api-action', data: { action: 'key-created' } },
      { event: 'api-action', data: { action: 'key-revoked' } },
    ]);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      delete globalThis.window;
    }
  }
});

test('dashboard checkout entry fires checkout-start', () => {
  const src = read('src/services/checkout.ts');
  assert.match(
    src,
    /const checkoutContext = trackCheckoutStart\(\s*productId,\s*Boolean\(user\),/,
    'startCheckout no longer fires trackCheckoutStart or preserves its checkout context',
  );
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

test('tracker tags are async', () => {
  for (const page of ['pro-test/index.html', 'pro-test/welcome.html']) {
    const tag = read(page).match(/<script[^>]+abacus\.worldmonitor\.app\/script\.js[^>]*>/)[0];
    assert.ok(/\basync\b/.test(tag),
      `${page}: tracker must be async — a plain defer script delays DOMContentLoaded behind the analytics host`);
  }
});

// Both marketing pages carry a tracker: /pro (index.html) and the homepage,
// which vercel.json rewrites to /pro/welcome.html.
for (const page of ['pro-test/index.html', 'pro-test/welcome.html']) test(`${page} redacts sensitive params per payload and keeps utm_*`, async () => {
  const html = read(page);
  const proTag = html.match(/<script[^>]+abacus[^>]*>/)[0];
  assert.ok(!proTag.includes('data-exclude-search'),
    `${page}: data-exclude-search would drop utm_* attribution`);
  assert.ok(proTag.includes('data-before-send="__wmUmamiBeforeSend"'),
    `${page}: tracker has no before-send redaction hook, so the whole query string reaches the analytics vendor`);
  // The hook is an async-safe inline script: it must precede the tracker tag.
  const hookScript = html.match(/<script nonce="wm-static-bootstrap">\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/);
  assert.ok(hookScript, `${page}: inline before-send hook script missing`);
  assert.ok(html.indexOf(hookScript[0]) < html.indexOf(proTag), 'hook must be defined before the async tracker tag');
  // Same list as the shared one.
  const { SENSITIVE_URL_PARAM_RE } = await import('../shared/sensitive-url-params.ts');
  const inlineRe = hookScript[1].match(/var SENSITIVE = \/(.+)\/i;/)[1];
  assert.equal(inlineRe, SENSITIVE_URL_PARAM_RE.source, `${page}: inline regex drifted from shared/sensitive-url-params.ts`);
  // Behaviour: run the real script.
  const vm = await import('node:vm');
  const win = {};
  vm.runInNewContext(hookScript[1], { window: win, location: { origin: 'https://www.worldmonitor.app' }, URL, Object });
  const hook = win.__wmUmamiBeforeSend;
  const sensitive = ['wm_checkout_ref', 'wm_checkout_discount', 'wm_checkout_account', '__clerk_ticket', '__clerk_status', 'token', 'email'];
  const url = `/pro?utm_source=mcp&utm_medium=tool&wm_checkout_product=pdt_1&${sensitive.map((k) => `${k}=x`).join('&')}#frag`;
  const out = hook('event', { url, referrer: `https://x.test/?token=t&utm_source=chatgpt.com` });
  const params = new URL(out.url, 'https://www.worldmonitor.app').searchParams;
  for (const k of sensitive) assert.equal(params.has(k), false, `${page}: ${k} must be removed`);
  assert.equal(params.get('utm_source'), 'mcp');
  assert.equal(params.get('utm_medium'), 'tool');
  assert.equal(params.get('wm_checkout_product'), 'pdt_1', 'non-secret funnel params survive');
  assert.ok(!out.url.startsWith('http'), 'relative url stays relative');
  assert.ok(!out.url.includes('#'), 'hash dropped');
  assert.equal(new URL(out.referrer).searchParams.has('token'), false);
  assert.equal(new URL(out.referrer).searchParams.get('utm_source'), 'chatgpt.com');
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
  assert.ok(analytics.includes("from '@/config/product-ids.generated'") && analytics.includes('DODO_PRODUCT_IDS'),
    'dashboard product allowlist must keep deriving from the generated catalog');
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
  assert.ok(
    pro.includes('persistFunnelEventForReplay(event, data)')
      || pro.includes('persistFunnelEventForReplay(event, enrichedData)'),
    '/pro queue branch no longer mirrors events into sessionStorage',
  );
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
