import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';

interface HarnessState {
  initializeCalls: number;
  handlers: Array<(event: unknown) => void>;
  openedUrls: string[];
  successCalls: number;
  sentryBreadcrumbs: Array<{ message?: string }>;
  watchdogs: Array<{ stopCalls: number }>;
  storageWrites: string[];
  closeCalls: number;
  silentNoOpOpens: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __checkoutOverlayHarness: HarnessState;
}

class MemoryStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
    globalThis.__checkoutOverlayHarness.storageWrites.push(key);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function installBrowserGlobals(): void {
  const sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: sessionStorage,
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
        assign: () => {},
      },
      history: { replaceState: () => {} },
    },
  });
}

function resetHarness(): void {
  globalThis.__checkoutOverlayHarness = {
    initializeCalls: 0,
    handlers: [],
    openedUrls: [],
    successCalls: 0,
    sentryBreadcrumbs: [],
    watchdogs: [],
    storageWrites: [],
    closeCalls: 0,
    silentNoOpOpens: 0,
  };
  installBrowserGlobals();
}

const stubSources: Record<string, string> = {
  '@/bootstrap/sentry-defer': `
    export function enqueueSentryCall(fn) {
      fn({
        addBreadcrumb: (breadcrumb) => globalThis.__checkoutOverlayHarness.sentryBreadcrumbs.push(breadcrumb),
        captureMessage: () => {},
        captureException: () => {},
      });
    }
  `,
  'dodopayments-checkout': `
    // Models the real SDK: Initialize registers ONE page-lifetime listener;
    // open() is a silent no-op while an iframe is already mounted; close()
    // tears the iframe down. A destroy that never calls close() therefore makes
    // the next open() vanish — which is exactly what this harness can now catch.
    //
    // close() also re-emits checkout.closed SYNCHRONOUSLY through the same onEvent
    // forwarder, in the same call stack — mirroring the real SDK (fn b -> g('checkout.closed')
    // -> config.onEvent). That synchronous re-entry is what makes destroyCheckoutOverlay's
    // "null currentCheckoutEventHandler BEFORE safeCloseOverlay()" ordering load-bearing:
    // reverse it and the re-entrant checkout.closed wipes the pending-intent.
    let _overlayOpen = false;
    let _onEvent = null;
    export const DodoPayments = {
      Initialize(options) {
        globalThis.__checkoutOverlayHarness.initializeCalls += 1;
        _onEvent = options.onEvent;
        globalThis.__checkoutOverlayHarness.handlers.push(options.onEvent);
      },
      Checkout: {
        isOpen: () => _overlayOpen,
        close: () => {
          const wasOpen = _overlayOpen;
          _overlayOpen = false;
          globalThis.__checkoutOverlayHarness.closeCalls += 1;
          if (wasOpen) {
            _onEvent?.({ event_type: 'checkout.closed', data: { message: 'Checkout closed manually' } });
          }
        },
        open(options) {
          if (_overlayOpen) {
            globalThis.__checkoutOverlayHarness.silentNoOpOpens += 1;
            return;
          }
          _overlayOpen = true;
          globalThis.__checkoutOverlayHarness.openedUrls.push(options.checkoutUrl);
        },
      },
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
  './auth-state': `
    export const subscribeAuthState = () => () => {};
  `,
  './checkout-attempt': `
    export const saveCheckoutAttempt = () => {};
    export const loadCheckoutAttempt = () => null;
    export const clearCheckoutAttempt = () => {};
  `,
  './checkout-errors': `
    export const classifyHttpCheckoutError = () => ({ code: 'service_unavailable', userMessage: 'unavailable', retryable: true });
    export const classifySyntheticCheckoutError = (code) => ({ code, userMessage: code, retryable: false });
    export const classifyThrownCheckoutError = () => ({ code: 'service_unavailable', userMessage: 'unavailable', retryable: true });
    export const parseCheckoutErrorBody = () => ({});
    export const snapshotUpstreamResponse = () => ({});
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
  './checkout-plan-names': `
    export const resolvePlanDisplayName = () => 'Pro';
  `,
  './entitlement-watchdog': `
    export function createEntitlementWatchdog() {
      const record = { stopCalls: 0 };
      globalThis.__checkoutOverlayHarness.watchdogs.push(record);
      return {
        start: () => {},
        stop: () => { record.stopCalls += 1; },
        isActive: () => record.stopCalls === 0,
      };
    }
  `,
};

const checkoutHarnessPlugin: Plugin = {
  name: 'checkout-overlay-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) => {
      if (Object.hasOwn(stubSources, args.path)) {
        return { path: args.path, namespace: 'checkout-stub' };
      }
      return null;
    });
    buildApi.onLoad({ filter: /.*/, namespace: 'checkout-stub' }, (args) => ({
      contents: stubSources[args.path],
      loader: 'js',
    }));
  },
};

async function loadCheckoutModule(): Promise<{
  registerCheckoutSuccessCallback: (onSuccess?: () => void) => void;
  openCheckout: (checkoutUrl: string) => Promise<void>;
  destroyCheckoutOverlay: () => void;
}> {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `
        export {
          registerCheckoutSuccessCallback,
          openCheckout,
          destroyCheckoutOverlay,
        } from './src/services/checkout.ts';
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: {
      'import.meta.env.VITE_DODO_ENVIRONMENT': '"test_mode"',
    },
    plugins: [checkoutHarnessPlugin],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return await import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

describe('checkout overlay lifecycle', () => {
  it('keeps one SDK handler while refreshing per-session side effects after destroy+reopen', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    checkout.registerCheckoutSuccessCallback(() => {
      globalThis.__checkoutOverlayHarness.successCalls += 1;
    });
    await checkout.openCheckout('https://checkout.example/first');
    checkout.destroyCheckoutOverlay();

    checkout.registerCheckoutSuccessCallback(() => {
      globalThis.__checkoutOverlayHarness.successCalls += 1;
    });
    await checkout.openCheckout('https://checkout.example/second');

    const harness = globalThis.__checkoutOverlayHarness;
    assert.equal(harness.initializeCalls, 1, 'DodoPayments.Initialize should run once per page load');
    assert.equal(harness.handlers.length, 1, 'SDK should hold one stable onEvent handler');
    assert.deepEqual(harness.openedUrls, [
      'https://checkout.example/first',
      'https://checkout.example/second',
    ]);

    harness.handlers[0]({
      event_type: 'checkout.status',
      data: { message: { status: 'succeeded' } },
    });
    assert.equal(harness.successCalls, 1, 'terminal success side effects should run once');
    assert.equal(
      harness.sentryBreadcrumbs.filter((breadcrumb) => breadcrumb.message === 'terminal success (event-status)').length,
      1,
      'terminal success breadcrumb should be emitted once',
    );
    assert.equal(
      harness.storageWrites.filter((key) => key === 'wm-post-checkout').length,
      1,
      'post-checkout marker should be written once',
    );
  });

  it('stops the current session watchdog after a destroy+reopen cycle', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    await checkout.openCheckout('https://checkout.example/first');
    checkout.destroyCheckoutOverlay();
    await checkout.openCheckout('https://checkout.example/second');

    const harness = globalThis.__checkoutOverlayHarness;
    harness.handlers[0]({ event_type: 'checkout.opened', data: {} });
    assert.equal(harness.watchdogs.length, 1, 'reopened session should create a watchdog through the stable handler');

    checkout.destroyCheckoutOverlay();
    assert.equal(harness.watchdogs[0].stopCalls, 1, 'destroy should stop the reopened session watchdog');
  });

  it('closes the overlay on destroy so a reopen is not a silent no-op', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    await checkout.openCheckout('https://checkout.example/first');
    checkout.destroyCheckoutOverlay();

    const harness = globalThis.__checkoutOverlayHarness;
    assert.equal(harness.closeCalls, 1, 'destroy must close the open Dodo overlay');

    await checkout.openCheckout('https://checkout.example/second');
    assert.equal(harness.silentNoOpOpens, 0, 'reopen must not be swallowed by an orphaned iframe');
    assert.deepEqual(
      harness.openedUrls,
      ['https://checkout.example/first', 'https://checkout.example/second'],
      'the reopened overlay must actually open',
    );
  });

  it('silences events from a destroyed session before the overlay is reopened', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    checkout.registerCheckoutSuccessCallback(() => {
      globalThis.__checkoutOverlayHarness.successCalls += 1;
    });
    await checkout.openCheckout('https://checkout.example/first');
    checkout.destroyCheckoutOverlay();

    // A late terminal event arriving through the stable SDK forwarder after
    // destroy (and before any reopen) must be a no-op — the per-session handler
    // was nulled, so no success side effects or storage writes may fire.
    const harness = globalThis.__checkoutOverlayHarness;
    harness.handlers[0]({
      event_type: 'checkout.status',
      data: { message: { status: 'succeeded' } },
    });
    assert.equal(harness.successCalls, 0, 'a destroyed session must not run success side effects');
    assert.equal(
      harness.storageWrites.filter((key) => key === 'wm-post-checkout').length,
      0,
      'a destroyed session must not write the post-checkout marker',
    );

    // The headline cross-session hazard: a late checkout.redirect_requested from
    // the destroyed session's orphaned iframe must NOT navigate — otherwise
    // session A's redirect_to could hijack session B's tab.
    const win = (globalThis as unknown as { window: { location: { href: string } } }).window;
    const hrefBefore = win.location.href;
    harness.handlers[0]({
      event_type: 'checkout.redirect_requested',
      data: { message: { redirect_to: 'https://attacker.example/stolen' } },
    });
    assert.equal(
      win.location.href,
      hrefBefore,
      'a destroyed session must not navigate via a late redirect_requested',
    );
  });

  it('preserves the pending-checkout intent across destroy (pins the null-handler-before-close ordering)', async () => {
    resetHarness();
    const checkout = await loadCheckoutModule();

    await checkout.openCheckout('https://checkout.example/first');

    // A saved auto-resume intent that an unmount-driven destroy must NOT wipe.
    const pending = JSON.stringify({ productId: 'prod_1', savedByUserId: null, savedAt: 1 });
    globalThis.sessionStorage.setItem('wm-pending-checkout', pending);

    checkout.destroyCheckoutOverlay();

    // The stub's close() re-emits checkout.closed synchronously through the stable
    // forwarder, exactly as the real SDK does. destroyCheckoutOverlay nulls
    // currentCheckoutEventHandler BEFORE calling safeCloseOverlay(), so that re-entrant
    // checkout.closed lands on a null handler and the handler's
    // `if (!successFired) clearPendingCheckoutIntent()` branch never runs — the intent
    // survives for auto-resume after a remount. Reversing those two lines (close before
    // null) routes checkout.closed into the still-live session handler and wipes the
    // intent, failing this assertion. This is the property the other destroy tests do
    // NOT pin, since they fire events manually after destroy has already returned.
    assert.equal(
      globalThis.sessionStorage.getItem('wm-pending-checkout'),
      pending,
      'destroy must preserve the pending-checkout intent (handler nulled before close)',
    );
  });
});
