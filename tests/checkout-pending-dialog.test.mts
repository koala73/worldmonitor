/**
 * #4438 — pending-payment dialog wiring in startCheckout.
 *
 * Drives the real src/services/checkout.ts through esbuild (mirroring
 * checkout-overlay-lifecycle.test.mts), stubbing the heavy deps but using the
 * REAL checkout-errors taxonomy so the PAYMENT_IN_PROGRESS 409 -> payment_in_progress
 * mapping (U3) is exercised end to end. The dialog itself is stubbed — its DOM
 * rendering mirrors the sibling checkout-duplicate-dialog.ts, which is likewise
 * stubbed in the overlay test (the project tests dialog WIRING here, DOM by parity).
 *
 * Asserts the three U4 acceptance scenarios:
 *   - a PAYMENT_IN_PROGRESS block shows the dialog and does NOT navigate
 *   - "Start new checkout" (onConfirm) re-invokes with bypassPendingGuard:true and navigates
 *   - "Cancel" (onDismiss) is inert — no navigation, no second request
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';

interface PendingDialogOptions {
  planDisplayName: string;
  onConfirm: () => void;
  onDismiss: () => void;
}

interface HarnessState {
  fetchBodies: Array<Record<string, unknown>>;
  assignedUrls: string[];
  dialogCalls: PendingDialogOptions[];
  clearAttemptReasons: string[];
}

declare global {
  // eslint-disable-next-line no-var
  var __pendingDialogHarness: HarnessState;
}

const PENDING_BODY = JSON.stringify({
  error: 'PAYMENT_IN_PROGRESS',
  message: 'A Pro Monthly payment is already in progress for this account',
  pendingPayment: { planKey: 'pro_monthly', displayName: 'Pro Monthly', occurredAt: 1 },
});

const BYPASS_URL = 'https://checkout.dodopayments.com/session/cks_bypass0000000000000000';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
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
    value: new MemoryStorage(),
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
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
          globalThis.__pendingDialogHarness.assignedUrls.push(url);
        },
      },
      history: { replaceState: () => {} },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : (init?.body as Record<string, unknown>);
      globalThis.__pendingDialogHarness.fetchBodies.push(body);
      // With the override flag the backend skips the pending guard -> 200 + url.
      if (body && body.bypassPendingGuard === true) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ checkout_url: BYPASS_URL }),
        };
      }
      // Otherwise the guard fires: a 409 PAYMENT_IN_PROGRESS block.
      return {
        ok: false,
        status: 409,
        text: async () => PENDING_BODY,
        headers: { get: () => null },
      };
    },
  });
}

function resetHarness(): void {
  globalThis.__pendingDialogHarness = {
    fetchBodies: [],
    assignedUrls: [],
    dialogCalls: [],
    clearAttemptReasons: [],
  };
  installBrowserGlobals();
}

const stubSources: Record<string, string> = {
  '@/bootstrap/sentry-defer': `
    export function enqueueSentryCall(fn) {
      fn({ addBreadcrumb: () => {}, captureMessage: () => {}, captureException: () => {} });
    }
  `,
  'dodopayments-checkout': `
    export const DodoPayments = { Initialize() {}, Checkout: { isOpen: () => false, close: () => {}, open() {} } };
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
  './auth-state': `
    export const subscribeAuthState = () => () => {};
  `,
  './checkout-attempt': `
    export const saveCheckoutAttempt = () => {};
    export const loadCheckoutAttempt = () => null;
    export const clearCheckoutAttempt = (reason) => {
      globalThis.__pendingDialogHarness.clearAttemptReasons.push(reason);
    };
  `,
  './checkout-error-toast': `
    export const showCheckoutErrorToast = () => {};
  `,
  './checkout-no-user-policy': `
    export const decideNoUserPathOutcome = () => ({ kind: 'inline-signin', persist: true });
  `,
  './checkout-sentry-policy': `
    export const shouldSkipSentryForAction = () => false;
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
    export const showCheckoutPendingDialog = (options) => {
      globalThis.__pendingDialogHarness.dialogCalls.push(options);
    };
  `,
  './checkout-plan-names': `
    export const resolvePlanDisplayName = () => 'Pro Monthly';
  `,
  './entitlement-watchdog': `
    export function createEntitlementWatchdog() {
      return { start: () => {}, stop: () => {}, isActive: () => true };
    }
  `,
};

const pendingDialogPlugin: Plugin = {
  name: 'pending-dialog-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) => {
      if (Object.hasOwn(stubSources, args.path)) {
        return { path: args.path, namespace: 'pending-stub' };
      }
      return null;
    });
    buildApi.onLoad({ filter: /.*/, namespace: 'pending-stub' }, (args) => ({
      contents: stubSources[args.path],
      loader: 'js',
    }));
  },
};

async function loadCheckoutModule(): Promise<{
  startCheckout: (
    productId: string,
    options?: { discountCode?: string; referralCode?: string; bypassPendingGuard?: boolean },
    behavior?: { fallbackToPricingPage?: boolean },
  ) => Promise<boolean>;
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
    plugins: [pendingDialogPlugin],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return await import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

// Let the fire-and-forget onConfirm re-call settle.
const flush = () => new Promise((r) => setTimeout(r, 25));

describe('checkout pending-payment dialog wiring (#4438)', () => {
  it('shows the dialog and does NOT navigate on a PAYMENT_IN_PROGRESS block', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    const opened = await checkout.startCheckout('prod_monthly');
    const harness = globalThis.__pendingDialogHarness;

    assert.equal(opened, false, 'a blocked checkout does not open');
    assert.equal(harness.assignedUrls.length, 0, 'must not navigate while a payment is pending');
    assert.equal(harness.dialogCalls.length, 1, 'the pending dialog is shown exactly once');
    assert.equal(harness.dialogCalls[0].planDisplayName, 'Pro Monthly');
    // Attempt is preserved (recoverable) — not cleared like the duplicate-sub path.
    assert.equal(harness.clearAttemptReasons.length, 0, 'the checkout attempt is preserved for retry');
  });

  it('re-invokes checkout with bypassPendingGuard and navigates on confirm', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly');
    const harness = globalThis.__pendingDialogHarness;
    assert.equal(harness.dialogCalls.length, 1);

    harness.dialogCalls[0].onConfirm();
    await flush();

    assert.equal(harness.fetchBodies.length, 2, 'confirm issues a second checkout request');
    assert.equal(harness.fetchBodies[1].bypassPendingGuard, true, 'the retry carries the override flag');
    assert.deepEqual(harness.assignedUrls, [BYPASS_URL], 'the override navigates to the hosted checkout');
  });

  it('is inert on cancel — no navigation, no second request', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('prod_monthly');
    const harness = globalThis.__pendingDialogHarness;

    harness.dialogCalls[0].onDismiss();
    await flush();

    assert.equal(harness.fetchBodies.length, 1, 'cancel does not issue another request');
    assert.equal(harness.assignedUrls.length, 0, 'cancel does not navigate');
  });
});
