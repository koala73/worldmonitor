/**
 * The dashboard asks for an in-place API Starter switch before any API Starter
 * checkout. This drives the REAL startCheckout through an esbuild stub harness
 * (mirroring tests/checkout-referral-policy.test.mts) and asserts on the
 * create-checkout POST: an account the switch flow handled ('shown') is never
 * sent to checkout, and every other outcome reaches checkout exactly as before.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
// A successful web redirect holds the checkout guard until the page leaves
// or a 15 s timer fires. Return the buyer from the back-forward cache after
// each test so that timer never outlives it.
type PageShowListener = (event: { persisted: boolean }) => void;
const pageShowListeners = new Set<PageShowListener>();
afterEach(() => {
  for (const fn of [...pageShowListeners]) fn({ persisted: true });
  pageShowListeners.clear();
});

import { build, type Plugin } from 'esbuild';

interface HarnessState {
  fetchBodies: Record<string, unknown>[];
  assignedUrls: string[];
  storedReferral: string | null;
  signedIn: boolean;
  /** What the stubbed switch flow resolves; 'throw' rejects, 'fail-load' fails the chunk load. */
  outcome: 'shown' | 'not-switchable' | 'throw' | 'fail-load' | 'switch-account';
  userId: string;
  flowCalls: Array<{ requestSwitchIsBilling: boolean; hasDismiss: boolean }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __apiSwitchCheckoutHarness: HarnessState;
}

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? (this.store.get(key) as string) : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

const CHECKOUT_URL = 'https://checkout.dodopayments.com/session/test';

function resetHarness(outcome: HarnessState['outcome'], signedIn = true): void {
  globalThis.__apiSwitchCheckoutHarness = { fetchBodies: [], assignedUrls: [], storedReferral: null, signedIn, outcome, flowCalls: [], userId: 'user_1' };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: PageShowListener) => {
        if (type === 'pageshow') pageShowListeners.add(fn);
      },
      removeEventListener: (type: string, fn: PageShowListener) => {
        if (type === 'pageshow') pageShowListeners.delete(fn);
      },
      setInterval: () => 1,
      clearInterval: () => {},
      location: {
        href: 'https://worldmonitor.app/dashboard',
        origin: 'https://worldmonitor.app',
        pathname: '/dashboard',
        search: '',
        hash: '',
        assign: (url: string) => globalThis.__apiSwitchCheckoutHarness.assignedUrls.push(url),
      },
      history: { replaceState: () => {} },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url: string, init?: { body?: string }) => {
      globalThis.__apiSwitchCheckoutHarness.fetchBodies.push(JSON.parse(init?.body ?? '{}'));
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
  './billing': `
    export const openBillingPortal = async () => {};
    export const prereserveBillingPortalTab = () => null;
    export const requestProBusinessUpgrade = async () => { throw new Error('stub'); };
    export const requestProAnnualSwitch = async () => { throw new Error('stub'); };
    export const requestApiStarterSwitch = async () => { throw new Error('stub'); };
    globalThis.__billingStubRequestApiStarterSwitch = requestApiStarterSwitch;
  `,
  './clerk': `
    export const getCurrentClerkUser = () => (globalThis.__apiSwitchCheckoutHarness.signedIn ? { id: globalThis.__apiSwitchCheckoutHarness.userId, email: 'pro@example.com' } : null);
    export const getClerkToken = async () => 'tok_test';
    export const openSignIn = () => {};
  `,
  './analytics': `
    export const trackCheckoutStart = () => ({ origin: { kind: 'dashboard' } });
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
    export const loadActiveReferral = () => globalThis.__apiSwitchCheckoutHarness.storedReferral;
    export { isAffiliateCode } from './src/services/referral-capture.ts';
  `,
  './checkout-duplicate-dialog': `
    export const showDuplicateSubscriptionDialog = () => {};
  `,
  './checkout-pending-dialog': `
    export const showCheckoutPendingDialog = () => {};
  `,
  './api-starter-switch-dialog': `
    if (globalThis.__apiSwitchCheckoutHarness.outcome === 'fail-load') throw new Error('chunk load failed');
    export const runApiStarterSwitchFlow = async (options) => {
      const h = globalThis.__apiSwitchCheckoutHarness;
      h.flowCalls.push({
        requestSwitchIsBilling: options.requestSwitch === globalThis.__billingStubRequestApiStarterSwitch,
        hasDismiss: typeof options.onDismiss === 'function',
      });
      if (h.outcome === 'throw') throw new Error('flow failed');
      if (h.outcome === 'switch-account') { h.userId = 'user_2'; return 'not-switchable'; }
      return h.outcome;
    };
  `,
  './checkout-plan-names': `
    export const resolvePlanDisplayName = () => 'Pro';
  `,
};

const harnessPlugin: Plugin = {
  name: 'api-switch-checkout-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) =>
      Object.hasOwn(stubSources, args.path) ? { path: args.path, namespace: 'asc-stub' } : null,
    );
    buildApi.onLoad({ filter: /.*/, namespace: 'asc-stub' }, (args) => ({
      contents: stubSources[args.path],
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

async function loadCheckoutModule(): Promise<{
  startCheckout: (productId: string, options?: { referralCode?: string }) => Promise<boolean>;
  startApiStarterSwitch: (onDismiss?: () => void) => Promise<'shown' | 'not-switchable'>;
  resumePendingCheckout: () => Promise<boolean>;
}> {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `export { startCheckout, startApiStarterSwitch, resumePendingCheckout } from './src/services/checkout.ts';`,
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

import { DODO_PRODUCTS } from '../src/config/products.ts';

const posts = () => globalThis.__apiSwitchCheckoutHarness.fetchBodies;
const flowCalls = () => globalThis.__apiSwitchCheckoutHarness.flowCalls;

describe('startCheckout asks for the API Starter switch first', () => {
  for (const productId of [DODO_PRODUCTS.API_STARTER_MONTHLY, DODO_PRODUCTS.API_STARTER_ANNUAL]) {
    it(`stops before checkout when the switch dialog is shown (${productId})`, async () => {
      resetHarness('shown');
      const checkout = await loadCheckoutModule();
      assert.equal(await checkout.startCheckout(productId), false);
      assert.deepEqual(flowCalls(), [{ requestSwitchIsBilling: true, hasDismiss: false }]);
      assert.deepEqual(posts(), []);
    });
  }

  for (const outcome of ['not-switchable', 'throw', 'fail-load'] as const) {
    it(`continues to the normal checkout when the switch is ${outcome}`, async () => {
      resetHarness(outcome);
      const checkout = await loadCheckoutModule();
      await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY);
      assert.equal(posts().length, 1);
      assert.equal(posts()[0]!.productId, DODO_PRODUCTS.API_STARTER_MONTHLY);
      assert.equal(flowCalls().length, outcome === 'fail-load' ? 0 : 1);
    });
  }

  it('never asks for other products', async () => {
    resetHarness('shown');
    const checkout = await loadCheckoutModule();
    for (const productId of [DODO_PRODUCTS.PRO_MONTHLY, DODO_PRODUCTS.PRO_BUSINESS_MONTHLY]) {
      await checkout.startCheckout(productId);
      for (const fn of [...pageShowListeners]) fn({ persisted: true });
    }
    assert.deepEqual(flowCalls(), []);
    assert.equal(posts().length, 2);
  });

  it('never asks for a signed-out visitor', async () => {
    resetHarness('shown', false);
    const checkout = await loadCheckoutModule();
    await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY);
    assert.deepEqual(flowCalls(), []);
  });

  it('lets a second click through once the switch dialog is up', async () => {
    resetHarness('shown');
    const checkout = await loadCheckoutModule();
    await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY);
    await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY);
    assert.equal(flowCalls().length, 2, 'the in-flight guard is released after the preview');
  });

  for (const [label, productId, outcome] of [
    ['another product', DODO_PRODUCTS.PRO_MONTHLY, 'shown'],
    ['API Starter with no Pro to switch', DODO_PRODUCTS.API_STARTER_MONTHLY, 'not-switchable'],
  ] as const) {
    it(`sends one checkout for two clicks made at once (${label})`, async () => {
      resetHarness(outcome);
      const checkout = await loadCheckoutModule();
      const results = await Promise.all([checkout.startCheckout(productId), checkout.startCheckout(productId)]);
      assert.equal(posts().length, 1, 'the second click must hit the in-flight guard');
      assert.deepEqual([...results].sort(), [false, true]);
    });
  }

  it('sends no checkout when the account changes while the switch is quoted', async () => {
    resetHarness('switch-account');
    const checkout = await loadCheckoutModule();
    assert.equal(await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY), false);
    assert.deepEqual(posts(), [], 'the checkout must not run under the other account');
    globalThis.__apiSwitchCheckoutHarness.outcome = 'not-switchable';
    await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY);
    assert.equal(posts().length, 1, 'the guard is released for the next click');
  });

  it('passes the Settings dismissal through', async () => {
    resetHarness('shown');
    const checkout = await loadCheckoutModule();
    assert.equal(await checkout.startApiStarterSwitch(() => {}), 'shown');
    assert.deepEqual(flowCalls(), [{ requestSwitchIsBilling: true, hasDismiss: true }]);
  });

  // A signed-out click stores the intent and resumes it after sign-in.
  const storeIntent = (productId: string) => sessionStorage.setItem('wm-pending-checkout', JSON.stringify({
    productId, savedAt: Date.now(), savedByUserId: null,
  }));

  it('forgets a resumed API Starter intent once the switch dialog takes over', async () => {
    resetHarness('shown');
    storeIntent(DODO_PRODUCTS.API_STARTER_MONTHLY);
    const checkout = await loadCheckoutModule();
    assert.equal(await checkout.resumePendingCheckout(), false);
    assert.equal(flowCalls().length, 1);
    assert.equal(sessionStorage.getItem('wm-pending-checkout'), null, 'a later sign-in must not reopen the dialog');
    assert.equal(await checkout.resumePendingCheckout(), false);
    assert.equal(flowCalls().length, 1);
  });

  it('keeps a stored intent for another product', async () => {
    resetHarness('shown');
    storeIntent(DODO_PRODUCTS.PRO_MONTHLY);
    const checkout = await loadCheckoutModule();
    await checkout.startCheckout(DODO_PRODUCTS.API_STARTER_MONTHLY);
    assert.notEqual(sessionStorage.getItem('wm-pending-checkout'), null);
  });
});
