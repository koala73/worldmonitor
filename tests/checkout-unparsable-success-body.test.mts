/**
 * End-to-end regression for WORLDMONITOR-XV: POST /api/create-checkout
 * answered HTTP 200 with a body that was not valid JSON.
 *
 * The old success path ran a bare `await resp.json()`, so the parse threw a
 * raw browser DOMException (Safari: `SyntaxError: The string did not match
 * the expected pattern.`, code 12). That exception skipped the deliberately
 * built contract-violation reporter and landed in the generic catch, which
 * meant the event was tagged `action: exception`, carried NO upstream
 * snapshot, and was phrased differently by every browser engine — so one
 * bug fragmented across a Sentry fingerprint per engine and nothing
 * recorded what the 200 body actually was.
 *
 * Drives the REAL startCheckout through an esbuild stub harness (mirroring
 * tests/checkout-overlay-lifecycle.test.mts) with the REAL checkout-errors
 * and checkout-sentry-policy modules bundled in, so parsing, redaction and
 * the emit policy are all genuinely exercised rather than stubbed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';

interface CapturedReport {
  message: string;
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

interface HarnessState {
  reports: CapturedReport[];
  assignedUrls: string[];
  checkoutEffects: string[];
  currentUser: { id: string; email: string } | null;
  /** Body + headers the stub fetch should answer the create-checkout POST with. */
  responseBody: string;
  responseHeaders: Record<string, string>;
  /** When set, text() rejects — models a stream that dies mid-read. */
  failBodyRead?: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __xvHarness: HarnessState;
}

class MemoryStorage {
  private readonly store = new Map<string, string>();
  constructor(private readonly onSet?: (key: string) => void) {}
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
    this.onSet?.(key);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function installBrowserGlobals(): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: new MemoryStorage((key) => globalThis.__xvHarness.checkoutEffects.push(`session:${key}`)),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      location: {
        href: 'https://worldmonitor.app/dashboard',
        origin: 'https://worldmonitor.app',
        pathname: '/dashboard',
        search: '',
        hash: '',
        assign: (url: string) => {
          globalThis.__xvHarness.assignedUrls.push(url);
          globalThis.__xvHarness.checkoutEffects.push(`navigate:${url}`);
        },
      },
      history: { replaceState: () => {} },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      const harness = globalThis.__xvHarness;
      // A faithful Response double: real ones always expose text(), and
      // text() never rejects on a malformed payload — only json() does.
      // That asymmetry is the whole point of the fix.
      return {
        ok: true,
        status: 200,
        text: async () => {
          if (harness.failBodyRead) throw new TypeError('network error');
          return harness.responseBody;
        },
        json: async () => JSON.parse(harness.responseBody),
        headers: { get: (name: string) => harness.responseHeaders[name.toLowerCase()] ?? null },
      };
    },
  });
}

function resetHarness(
  responseBody: string,
  responseHeaders: Record<string, string> = {},
  currentUser: HarnessState['currentUser'] = { id: 'user_1', email: 'pro@example.com' },
): void {
  globalThis.__xvHarness = {
    reports: [],
    assignedUrls: [],
    checkoutEffects: [],
    currentUser,
    responseBody,
    responseHeaders,
  };
  installBrowserGlobals();
}

const stubSources: Record<string, string> = {
  // Records the full Sentry payload so the test can assert on tags + extra.
  '@/bootstrap/sentry-defer': `
    export function enqueueSentryCall(fn) {
      fn({
        addBreadcrumb: () => {},
        captureMessage: (message, payload) => globalThis.__xvHarness.reports.push({ message, ...payload }),
        captureException: (err, payload) => globalThis.__xvHarness.reports.push({ message: String(err && err.message || err), ...payload }),
      });
    }
  `,
  'dodopayments-checkout': `
    export const DodoPayments = {
      Initialize() {},
      Checkout: { isOpen: () => false, close: () => {}, open: () => {} },
    };
  `,
  './billing': `
    export const openBillingPortal = async () => {};
    export const prereserveBillingPortalTab = () => null;
  `,
  './clerk': `
    export const getCurrentClerkUser = () => globalThis.__xvHarness.currentUser;
    export const getClerkToken = async () => 'tok_test';
    export const openSignIn = () => globalThis.__xvHarness.checkoutEffects.push('openSignIn');
  `,
  './analytics': `
    export const trackCheckoutStart = () => {};
  `,
  './auth-state': `
    export const subscribeAuthState = () => () => {};
  `,
  './checkout-attempt': `
    export const saveCheckoutAttempt = () => globalThis.__xvHarness.checkoutEffects.push('saveCheckoutAttempt');
    export const loadCheckoutAttempt = () => null;
    export const clearCheckoutAttempt = () => {};
  `,
  './checkout-error-toast': `
    export const showCheckoutErrorToast = () => {};
  `,
  './entitlements': `
    export const isEntitled = () => false;
    export const onEntitlementChange = () => () => {};
  `,
  './checkout-banner-state': `
    export const CLASSIC_AUTO_DISMISS_MS = 5000;
    export const EXTENDED_UNLOCK_TIMEOUT_MS = 30000;
    export const maskEmail = (email) => email ?? null;
  `,
  './referral-capture': `
    export const loadActiveReferral = () => null;
  `,
  './checkout-duplicate-dialog': `
    export const showDuplicateSubscriptionDialog = () => {};
  `,
  './checkout-pending-dialog': `
    export const showCheckoutPendingDialog = () => {};
  `,
  './checkout-plan-names': `
    export const resolvePlanDisplayName = () => 'Pro';
  `,
  './entitlement-watchdog': `
    export function createEntitlementWatchdog() {
      return { start: () => {}, stop: () => {}, isActive: () => false };
    }
  `,
};

const harnessPlugin: Plugin = {
  name: 'xv-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) =>
      Object.hasOwn(stubSources, args.path) ? { path: args.path, namespace: 'xv-stub' } : null,
    );
    buildApi.onLoad({ filter: /.*/, namespace: 'xv-stub' }, (args) => ({
      contents: stubSources[args.path],
      loader: 'js',
    }));
  },
};

async function loadCheckoutModule(): Promise<{ startCheckout: (productId: string) => Promise<boolean> }> {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `export { startCheckout } from './src/services/checkout.ts';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: { 'import.meta.env.VITE_DODO_ENVIRONMENT': '"test_mode"' },
    plugins: [harnessPlugin],
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return await import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

function soleReport(): CapturedReport {
  const { reports } = globalThis.__xvHarness;
  assert.equal(reports.length, 1, `expected exactly one Sentry report, got ${reports.length}`);
  return reports[0];
}

describe('signed-out checkout production wiring', () => {
  it('redirects without persisting checkout state on the default path', async () => {
    resetHarness('', {}, null);
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), false);
    assert.deepEqual(globalThis.__xvHarness.checkoutEffects, [
      'navigate:https://worldmonitor.app/pro',
    ]);
  });

  it('persists intent and attempt before opening inline sign-in', async () => {
    resetHarness('', {}, null);
    const checkout = await loadCheckoutModule();

    assert.equal(
      await checkout.startCheckout(
        'prod_monthly',
        undefined,
        { fallbackToPricingPage: false },
      ),
      false,
    );
    assert.deepEqual(globalThis.__xvHarness.checkoutEffects, [
      'session:wm-pending-checkout',
      'saveCheckoutAttempt',
      'openSignIn',
    ]);
  });
});

describe('create-checkout 200 with an unparsable body (WORLDMONITOR-XV)', () => {
  it('reports the contract violation instead of letting the parse error escape', async () => {
    // An HTML interstitial served with 200 — the shape a middlebox or edge
    // challenge produces, and what a bare resp.json() choked on.
    resetHarness('<!DOCTYPE html><html>Attention Required</html>', {
      'cf-ray': 'a00d6f7b7b9bfb0a-IAD',
      server: 'cloudflare',
    });
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), false);
    // The graceful surface for this behavior is the pricing page; what must
    // never happen is navigating somewhere derived from the broken payload.
    assert.deepEqual(globalThis.__xvHarness.assignedUrls, ['https://worldmonitor.app/pro']);

    const report = soleReport();
    // The decisive assertion: `exception` here means the DOMException escaped
    // to the generic catch again, which is the bug.
    assert.equal(report.tags?.action, 'unparsable-success-body');
    assert.notEqual(report.tags?.action, 'exception');
    assert.equal(report.tags?.code, 'service_unavailable');
    assert.equal(report.extra?.httpStatus, 200);
    assert.equal(report.extra?.serverMessage, 'Server returned 200 with a non-JSON body');
  });

  it('attaches the upstream snapshot so the next occurrence names its emitter', async () => {
    // Without this the event says only "a parse failed" — not whether the
    // 200 was HTML, empty or truncated, nor which layer produced it. That
    // blindness is what made the original event unresolvable.
    resetHarness('<!DOCTYPE html><html>Attention Required</html>', {
      'cf-ray': 'a00d6f7b7b9bfb0a-IAD',
      server: 'cloudflare',
      'x-vercel-id': 'iad1::xyz789',
    });
    const checkout = await loadCheckoutModule();
    await checkout.startCheckout('prod_monthly');

    const report = soleReport();
    const upstream = report.extra?.upstream as Record<string, unknown> | undefined;
    assert.ok(upstream, 'upstream snapshot missing from the report');
    assert.equal(upstream.cfRay, 'a00d6f7b7b9bfb0a-IAD');
    assert.equal(upstream.server, 'cloudflare');
    assert.equal(upstream.vercelId, 'iad1::xyz789');
    assert.ok(
      String(upstream.bodySnippet).includes('Attention Required'),
      'body snippet must show what the 200 actually contained',
    );
    // cf-ray and server are promoted to tags so the emitter is filterable
    // without opening the event (WORLDMONITOR-RN).
    assert.equal(report.tags?.cfRay, 'a00d6f7b7b9bfb0a-IAD');
    assert.equal(report.tags?.upstreamServer, 'cloudflare');
  });

  it('never ships anonymous_claim_token to Sentry, even from a truncated body', async () => {
    // A body cut mid-transit still parses as unparsable and still gets
    // snapshotted — so the claim token the success payload carries (bearer
    // proof persisted to localStorage) must be redacted on the way out.
    resetHarness('{"anonymous_claim_token":"tok_live_SECRET123","checkout_url":"https://checkout.dod');
    const checkout = await loadCheckoutModule();
    await checkout.startCheckout('prod_monthly');

    const snippet = String((soleReport().extra?.upstream as Record<string, unknown>).bodySnippet);
    assert.ok(!snippet.includes('tok_live_SECRET123'), 'claim token leaked to Sentry');
    assert.ok(snippet.includes('[redacted]'));
    assert.ok(snippet.includes('anonymous_claim_token'), 'field presence is still diagnostic');
  });

  it('empty 200 body is reported, not swallowed', async () => {
    resetHarness('');
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), false);
    const report = soleReport();
    assert.equal(report.tags?.action, 'unparsable-success-body');
    // No snippet for an empty body — undefined is filterable in Sentry, and
    // its absence alongside the headers is itself the "body was empty" signal.
    assert.equal((report.extra?.upstream as Record<string, unknown>).bodySnippet, undefined);
  });

  it('a well-formed 200 missing checkout_url keeps its own distinct action tag', async () => {
    // Control: the two contract violations must stay separable, because one
    // points at the transport and the other at the relay payload.
    resetHarness('{"ok":true}', { server: 'Vercel' });
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), false);
    const report = soleReport();
    assert.equal(report.tags?.action, 'missing-checkout-url');
    assert.equal(report.extra?.serverMessage, 'Server returned 200 without a usable checkout_url');
    assert.equal((report.extra?.upstream as Record<string, unknown>).server, 'Vercel');
  });

  it('a parsed 200 reports key names only — no payload values reach Sentry', async () => {
    // The highest-exposure path: safeHostedCheckoutUrl rejected an untrusted
    // host, so the body is a COMPLETE successful payload. Its field set comes
    // from the Dodo SDK, which we do not control, so nothing value-level may
    // ship — not the claim token, not the session id.
    resetHarness(
      JSON.stringify({
        session_id: 'cks_live_9f2b7c1d4e',
        checkout_url: 'https://unexpected-host.example/pay/abc',
        anonymous_claim_token: 'tok_live_SECRET123',
      }),
    );
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), false);
    const report = soleReport();
    assert.equal(report.tags?.action, 'missing-checkout-url');
    const upstream = report.extra?.upstream as Record<string, unknown>;
    assert.deepEqual(upstream.bodyKeys, ['anonymous_claim_token', 'checkout_url', 'session_id']);
    assert.equal(upstream.bodySnippet, undefined);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('tok_live_SECRET123'), 'claim token leaked to Sentry');
    assert.ok(!serialized.includes('cks_live_9f2b7c1d4e'), 'session id leaked to Sentry');
    assert.ok(!serialized.includes('unexpected-host.example'), 'rejected URL leaked to Sentry');
  });

  it('distinguishes an empty body from one that is merely unparseable', async () => {
    // Two different upstream faults; a shared message would erase which.
    resetHarness('');
    let checkout = await loadCheckoutModule();
    await checkout.startCheckout('prod_monthly');
    assert.equal(soleReport().extra?.serverMessage, 'Server returned 200 with an empty body');

    resetHarness('<html>nope</html>');
    checkout = await loadCheckoutModule();
    await checkout.startCheckout('prod_monthly');
    assert.equal(soleReport().extra?.serverMessage, 'Server returned 200 with a non-JSON body');
  });

  it('does not call valid-but-non-object JSON a non-JSON body', async () => {
    resetHarness('[]');
    const checkout = await loadCheckoutModule();
    await checkout.startCheckout('prod_monthly');

    const report = soleReport();
    assert.equal(report.tags?.action, 'unparsable-success-body');
    assert.equal(
      report.extra?.serverMessage,
      'Server returned 200 with a JSON body that is not an object',
    );
  });

  it('preserves the original exception when the response body cannot be read', async () => {
    // A response whose stream dies mid-read is not an empty response. The
    // original error, stack, and cause must reach the exception reporter.
    resetHarness('');
    globalThis.__xvHarness.failBodyRead = true;
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), false);
    const report = soleReport();
    assert.equal(report.tags?.action, 'exception');
    assert.equal(report.message, 'network error');
    assert.equal(report.extra?.serverMessage, 'network error');
    assert.equal(report.extra?.upstream, undefined);
  });

  it('a valid success payload still navigates and reports nothing', async () => {
    // Guards against the fix turning a working checkout into an error path.
    resetHarness('{"checkout_url":"https://checkout.dodopayments.com/session/cks_ok0000000000000000000"}');
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), true);
    assert.deepEqual(globalThis.__xvHarness.assignedUrls, [
      'https://checkout.dodopayments.com/session/cks_ok0000000000000000000',
    ]);
    assert.equal(globalThis.__xvHarness.reports.length, 0);
  });

  it('still persists the anonymous claim token on a successful checkout', async () => {
    // The token read moved behind the null check; prove it did not regress.
    resetHarness(
      '{"checkout_url":"https://checkout.dodopayments.com/session/cks_ok0000000000000000000","anonymous_claim_token":"tok_live_KEEP"}',
    );
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('prod_monthly'), true);
    assert.equal(
      (globalThis.localStorage as unknown as MemoryStorage).getItem('wm-anon-claim-token'),
      'tok_live_KEEP',
    );
  });
});
