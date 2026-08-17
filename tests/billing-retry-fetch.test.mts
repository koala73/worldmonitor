/**
 * Unit tests for `withBillingVerificationRetry` in src/services/billing-retry.ts.
 *
 * WORLDMONITOR-Z4: the gateway 503s a caller whose Convex entitlement lookup is
 * unavailable, and getEntitlements() negative-caches that failure per user — so
 * a single blip took out analyze-stock and list-stored-stock-backtests one
 * second apart on the same dashboard paint. The server marks it retryable;
 * these pin that we honor that.
 *
 * These started life against `premiumFetch` (#6483) and moved here with the
 * retry itself. The measured reason, from 30 days of `billing_verification_503`
 * telemetry to 2026-08-12 (12 routes / 31 events): the 24 browser-origin events
 * span 7 routes that are ALL premium paths, so correct `premiumFetch` wiring
 * would have covered them — while the other 7 events are `user_api_key`
 * server-to-server callers that no client change can reach. The retry lives at
 * the fetch patch for defence in depth, not for route coverage: the parity gate
 * cannot see accessor-style wiring, so at this layer a mis-wiring costs Sentry
 * visibility but never the retry. Testing the wrapper tests the layer that ships.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withBillingVerificationRetry } from '@/services/billing-retry';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeRes(status: number) {
  return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
}

function billingRes(status: number, code: string | null, retryAfter: string | null) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (code) headers.set('X-Billing-Verification', code);
  if (retryAfter) headers.set('Retry-After', retryAfter);
  return new Response(JSON.stringify(code ? { code } : {}), { status, headers });
}

interface Harness {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: () => number;
  slept: number[];
}

/**
 * Takes response FACTORIES, not instances: a Response body is single-use, and
 * the retry path clones the first one to read its denial code. Minting a fresh
 * Response per attempt keeps each test's attempts independent.
 *
 * The injected sleep records the wait instead of taking it, so a test can
 * assert we honored Retry-After exactly without sleeping the real 5s.
 */
function harness(responses: Array<() => Response | Promise<Response>>): Harness {
  const slept: number[] = [];
  let n = 0;
  const dispatch = async (): Promise<Response> => {
    const next = responses[Math.min(n++, responses.length - 1)]!;
    return next();
  };
  const wrapped = withBillingVerificationRetry(dispatch, async (ms) => { slept.push(ms); });
  return { fetch: wrapped, calls: () => n, slept };
}

// A route in neither ENDPOINT_ENTITLEMENTS nor PREMIUM_RPC_PATHS that the
// legacy-bearer gate still 503s (3 events / 30d — all `user_api_key`, so those
// particular callers never reach this wrapper; see the header).
const NON_PREMIUM_TARGET = 'https://api.worldmonitor.app/api/conflict/v1/list-ucdp-events';
const PREMIUM_TARGET = 'https://api.worldmonitor.app/api/sanctions/v1/list-sanctions-pressure';

describe('withBillingVerificationRetry', () => {
  it('retries an unverifiable-entitlement 503 once and returns the recovered response', async () => {
    const h = harness([
      () => billingRes(503, 'entitlement_verification_unavailable', '5'),
      () => fakeRes(200),
    ]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 200, 'caller sees the recovered response, not the blip');
    assert.equal(h.calls(), 2, 'exactly one retry');
    assert.deepEqual(h.slept, [5000], 'waited exactly the Retry-After the server asked for');
  });

  it('is route-agnostic — a non-premium path retries too', async () => {
    // Matches the server, whose legacy-bearer gate can 503 any authenticated
    // request. No browser-origin event has landed on a non-premium route yet
    // (all 24 in the 30d window were premium paths), so this pins the property
    // rather than a reproduced incident — it is what makes a future mis-wiring
    // or a newly tier-gated route cost visibility instead of the retry.
    const h = harness([
      () => billingRes(503, 'entitlement_verification_unavailable', '5'),
      () => fakeRes(200),
    ]);

    const res = await h.fetch(NON_PREMIUM_TARGET);
    assert.equal(res.status, 200, 'a non-premium route recovers too');
    assert.equal(h.calls(), 2);
  });

  it('gives up after ONE retry — a sustained outage still surfaces its 503', async () => {
    const h = harness([() => billingRes(503, 'entitlement_verification_unavailable', '5')]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 503, 'sustained outage still reaches the caller');
    assert.equal(h.calls(), 2, 'one retry, then stop — never a loop');
  });

  it('reads the denial code from the body when the header was stripped', async () => {
    // Cross-origin widget/Tauri callers can lose X-Billing-Verification to an
    // intermediary; the body mirrors it.
    const h = harness([
      () => new Response(JSON.stringify({ code: 'entitlement_verification_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      }),
      () => fakeRes(200),
    ]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 200);
    assert.equal(h.calls(), 2, 'body fallback still triggers the retry');
  });

  it('leaves a non-503 response completely untouched', async () => {
    // This wraps EVERY request the page makes, so the common path must not
    // read a body or take a wait.
    const h = harness([() => fakeRes(200)]);

    const res = await h.fetch('https://api.worldmonitor.app/api/news/v1/list-headlines');
    assert.equal(res.status, 200);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.slept, []);
    assert.equal(res.bodyUsed, false, 'body stream handed to the caller intact');
  });

  it('does NOT retry a 503 that carries no billing-verification code', async () => {
    const h = harness([() => billingRes(503, null, '5')]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 503);
    assert.equal(h.calls(), 1, 'an unclassified 503 is not blind-retried');
    assert.deepEqual(h.slept, []);
  });

  it('does NOT retry fail-closed rate-limit degradation', async () => {
    // Redis is the thing that is down there and the limiter IS the abuse
    // defence — retrying adds load to a degraded dependency. Deliberately
    // outside the allowlist.
    const h = harness([() => new Response('{"error":"Rate-limit service temporarily unavailable"}', {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Mode': 'degraded',
        'Retry-After': '5',
      },
    })]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 503);
    assert.equal(h.calls(), 1, 'no retry for a degraded limiter');
  });

  it('declines a Retry-After longer than the inline budget', async () => {
    // renewal_verification_failed asks for up to 60s — that is the Dodo
    // cooldown, so waiting it out inline just arrives at the same denial.
    const h = harness([() => billingRes(503, 'renewal_verification_failed', '60')]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 503);
    assert.equal(h.calls(), 1, 'surfaces now rather than blocking a minute');
  });

  it('retries a short renewal-verification-pending wait', async () => {
    const h = harness([
      () => billingRes(503, 'renewal_verification_pending', '2'),
      () => fakeRes(200),
    ]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 200);
    assert.deepEqual(h.slept, [2000]);
  });

  it('defaults the wait when the server omitted Retry-After', async () => {
    const h = harness([
      () => billingRes(503, 'entitlement_verification_unavailable', null),
      () => fakeRes(200),
    ]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 200);
    assert.deepEqual(h.slept, [5000], 'matches the server-side default');
  });

  it('does NOT retry a Request input — its body stream is single-use', async () => {
    const h = harness([() => billingRes(503, 'entitlement_verification_unavailable', '5')]);

    const res = await h.fetch(new Request(PREMIUM_TARGET));
    assert.equal(res.status, 503);
    assert.equal(h.calls(), 1, 'a consumed body must never be replayed');
  });

  it('does NOT retry a streamed body — single-use for the same reason', async () => {
    const h = harness([() => billingRes(503, 'entitlement_verification_unavailable', '5')]);

    const res = await h.fetch(PREMIUM_TARGET, {
      method: 'POST',
      body: new Blob(['{"a":1}']),
    });
    assert.equal(res.status, 503);
    assert.equal(h.calls(), 1);
  });

  it('replays a plain string body verbatim', async () => {
    const h = harness([
      () => billingRes(503, 'entitlement_verification_unavailable', '5'),
      () => fakeRes(200),
    ]);

    const res = await h.fetch(PREMIUM_TARGET, { method: 'POST', body: '{"symbol":"AAPL"}' });
    assert.equal(res.status, 200);
    assert.equal(h.calls(), 2, 'the generated clients send string bodies — these must replay');
  });

  it('returns the original 503 when the retry itself throws', async () => {
    // Worst case must be exactly the pre-retry behavior, never a thrown
    // rejection in place of the server's answer.
    const h = harness([
      () => billingRes(503, 'entitlement_verification_unavailable', '5'),
      () => Promise.reject(new Error('network down')),
    ]);

    const res = await h.fetch(PREMIUM_TARGET);
    assert.equal(res.status, 503);
    assert.equal(h.calls(), 2);
  });

  it('returns the original 503 when the caller aborts during the wait', async () => {
    // A user who navigated away must not be kept waiting on our behalf, and
    // must not receive a rejection the pre-retry code would never have thrown.
    const controller = new AbortController();
    let n = 0;
    const dispatch = async (): Promise<Response> => {
      n++;
      return billingRes(503, 'entitlement_verification_unavailable', '5');
    };
    const wrapped = withBillingVerificationRetry(dispatch, async () => {
      controller.abort();
      throw controller.signal.reason ?? new Error('Aborted');
    });

    const res = await wrapped(PREMIUM_TARGET, { signal: controller.signal });
    assert.equal(res.status, 503);
    assert.equal(n, 1, 'no replay after the caller gave up');
  });
});

// ---------------------------------------------------------------------------
// Wiring.
//
// The wrapper above is only worth anything if the fetch patches actually
// install it, and NOTHING else covers that seam — no test constructs
// installWebApiRedirect/installRuntimeFetchPatch (they need a browser `window`
// plus the Clerk import graph). The original defect was precisely a wiring one:
// a premium path that authenticated fine but routed around the layer holding
// the behavior. So pin the invariant at the source.
//
// This asserts a COUNT equality rather than mere presence: a fourth
// `window.fetch =` assignment added later without the wrapper fails here, which
// a "does the file mention withBillingVerificationRetry" check would not.
// ---------------------------------------------------------------------------
describe('runtime fetch-patch wiring', () => {
  const runtimeSrc = readFileSync(join(REPO_ROOT, 'src/services/runtime.ts'), 'utf8');

  it('every window.fetch assignment in runtime.ts goes through the retry wrapper', () => {
    const allAssignments = runtimeSrc.match(/window\.fetch\s*=/g) ?? [];
    const wrapped = runtimeSrc.match(/window\.fetch\s*=\s*withBillingVerificationRetry\(/g) ?? [];

    assert.ok(allAssignments.length > 0, 'expected runtime.ts to still patch window.fetch');
    assert.equal(
      wrapped.length,
      allAssignments.length,
      `every window.fetch assignment must honor the billing-verification contract — ` +
      `found ${allAssignments.length} assignment(s) but only ${wrapped.length} wrapped`,
    );
  });

  it('covers both the web and desktop patches', () => {
    // They are mutually exclusive at runtime (each returns early on the other's
    // platform), so a wrapper on only one silently leaves that platform's Pro
    // users with the pre-retry hard failure.
    const desktop = runtimeSrc.indexOf('export function installRuntimeFetchPatch');
    const web = runtimeSrc.indexOf('export function installWebApiRedirect');
    assert.ok(desktop >= 0 && web >= 0, 'both installers still exist');

    const desktopBody = runtimeSrc.slice(desktop, web);
    const webBody = runtimeSrc.slice(web);
    assert.match(desktopBody, /withBillingVerificationRetry\(/, 'desktop patch unwrapped');
    assert.match(webBody, /withBillingVerificationRetry\(/, 'web patch unwrapped');
  });

  it('premiumFetch no longer retries — exactly one layer may own the bound', () => {
    // Two layers would double the bound to two attempts and ~10s of inline
    // waiting, because premiumFetch dispatches through globalThis.fetch, which
    // IS the wrapped patch in a browser.
    //
    // Assert on the IMPORT, not on a mention: premium-fetch.ts documents in
    // prose where the retry went, and a naive text match flags that comment.
    // The import is the real coupling — retrying there requires one.
    const premiumSrc = readFileSync(join(REPO_ROOT, 'src/services/premium-fetch.ts'), 'utf8');
    const imports = premiumSrc.match(/^\s*import\s[\s\S]*?from\s+'[^']+';/gm) ?? [];
    const billingImport = imports.find((i) => i.includes('billing-retry'));
    assert.equal(
      billingImport,
      undefined,
      'premiumFetch must not re-introduce a second retry layer',
    );
  });
});
