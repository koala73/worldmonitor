/**
 * #6493 — the money boundary for referral attribution.
 *
 * `referral-capture.ts` rejects our own internal source tags (`welcome-*`,
 * `seo-*`) on capture and evicts them on read, but neither check is on the
 * path that actually pays anyone. `startCheckout` merges a CALLER-passed code
 * ahead of the stored one, and three callers supply a value that never went
 * through referral capture:
 *
 *   - the checkout-failure banner, replaying `attempt.referralCode` from a
 *     checkout started before the fix shipped,
 *   - a resumed pending checkout intent,
 *   - `?checkoutReferral=` straight off the URL, which carries no charset
 *     check at all.
 *
 * So this drives the REAL startCheckout through an esbuild stub harness
 * (mirroring tests/checkout-unparsable-success-body.test.mts) and asserts on
 * the outgoing POST body — the last observable point before Dodo writes
 * `metadata.affonso_referral`. A test that stopped at loadActiveReferral()
 * would have passed while every one of those three paths shipped a poisoned
 * code.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';

interface HarnessState {
  fetchBodies: Record<string, unknown>[];
  assignedUrls: string[];
  /** What the stubbed storage layer reports as the active referral. */
  storedReferral: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __referralPolicyHarness: HarnessState;
}

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? (this.store.get(key) as string) : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

const CHECKOUT_URL = 'https://checkout.dodopayments.com/session/test';

function resetHarness(storedReferral: string | null = null): void {
  globalThis.__referralPolicyHarness = { fetchBodies: [], assignedUrls: [], storedReferral };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
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
        assign: (url: string) => globalThis.__referralPolicyHarness.assignedUrls.push(url),
      },
      history: { replaceState: () => {} },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url: string, init?: { body?: string }) => {
      globalThis.__referralPolicyHarness.fetchBodies.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ checkout_url: CHECKOUT_URL }),
        json: async () => ({ checkout_url: CHECKOUT_URL }),
        headers: { get: () => null },
      };
    },
  });
}

const stubSources: Record<string, string> = {
  '@/bootstrap/sentry-defer': `
    export function enqueueSentryCall(fn) {
      fn({ addBreadcrumb: () => {}, captureMessage: () => {}, captureException: () => {} });
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
    export const getCurrentClerkUser = () => ({ id: 'user_1', email: 'pro@example.com' });
    export const getClerkToken = async () => 'tok_test';
    export const openSignIn = () => {};
  `,
  './analytics': `
    export const trackCheckoutStart = () => {};
  `,
  './desktop-runtime': `
    export const isDesktopRuntime = () => false;
  `,
  './auth-state': `
    export const subscribeAuthState = () => () => {};
  `,
  './checkout-attempt': `
    export const saveCheckoutAttempt = () => {};
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
    export const ENTITLEMENT_POLL_MS = 1000;
    export const LATE_ACTIVATION_GRACE_MS = 300000;
    export const maskEmail = (email) => email ?? null;
  `,
  // Only the storage read is faked — it is the harness's control knob for
  // "what did referral capture persist". isAffiliateCode is re-exported REAL
  // because it is the policy under test; stubbing it would make every
  // assertion below vacuous.
  './referral-capture': `
    export const loadActiveReferral = () => globalThis.__referralPolicyHarness.storedReferral;
    export { isAffiliateCode } from './src/services/referral-capture.ts';
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
  name: 'referral-policy-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) =>
      Object.hasOwn(stubSources, args.path) ? { path: args.path, namespace: 'rp-stub' } : null,
    );
    buildApi.onLoad({ filter: /.*/, namespace: 'rp-stub' }, (args) => ({
      contents: stubSources[args.path],
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

async function loadCheckoutModule(): Promise<{
  startCheckout: (productId: string, options?: { referralCode?: string }) => Promise<boolean>;
}> {
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

function soleBody(): Record<string, unknown> {
  const { fetchBodies } = globalThis.__referralPolicyHarness;
  assert.equal(fetchBodies.length, 1, `expected exactly one create-checkout POST, got ${fetchBodies.length}`);
  return fetchBodies[0];
}

describe('startCheckout referral policy (#6493)', () => {
  it('drops a caller-passed internal source tag instead of paying it out', async () => {
    resetHarness(null);
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly', { referralCode: 'welcome-hero' });

    assert.equal(
      soleBody().referralCode,
      undefined,
      'a welcome-* tag replayed from a pre-fix checkout attempt must not reach affonso_referral',
    );
  });

  it('falls back to the stored referral when the passed code is rejected', async () => {
    resetHarness('sharerA');
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly', { referralCode: 'welcome-nav' });

    assert.equal(
      soleBody().referralCode,
      'sharerA',
      'an unusable passed code must not suppress a legitimately captured one',
    );
  });

  it('drops a malformed caller-passed code, which ?checkoutReferral= never charset-checks', async () => {
    resetHarness(null);
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly', { referralCode: 'not a valid code' });

    assert.equal(soleBody().referralCode, undefined);
  });

  it('still forwards a genuine affiliate code', async () => {
    resetHarness(null);
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly', { referralCode: 'sharerB' });

    assert.equal(soleBody().referralCode, 'sharerB', 'the guard must not break real affiliate attribution');
  });

  it('forwards the stored referral when the caller passes none', async () => {
    resetHarness('sharerC');
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly');

    assert.equal(soleBody().referralCode, 'sharerC');
  });
});
