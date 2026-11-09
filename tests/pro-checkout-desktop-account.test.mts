/**
 * Desktop checkout handoff account binding on /pro (#10342).
 *
 * The desktop app hands "Upgrade to Pro" to the OS browser, where /pro runs
 * checkout on the BROWSER's Clerk session. The handoff URL names the desktop
 * account by fingerprint; before charging, /pro compares it with the browser
 * account and, on a mismatch, asks instead of silently upgrading the wrong
 * one. Drives the REAL startCheckout through the same esbuild + happy-dom
 * harness as pro-checkout-feedback.test.mts.
 */
import assert from 'node:assert/strict';
import { afterEach, before, it, mock } from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

import { fingerprintCheckoutAccount } from '../shared/checkout-attribution.ts';

let moduleUrl: string;
let browser: Window;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  const result = await build({
    entryPoints: ['pro-test/src/services/checkout.ts'],
    bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'checkout-fixtures', setup(builder) {
      builder.onResolve({ filter: /^(\.\/clerk|@sentry\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path === './clerk'
          ? 'export const ensureClerk = () => globalThis.__checkoutFixture.clerk();'
          : 'export const captureException = () => {}; export const captureMessage = () => {};',
      }));
    } }],
  });
  moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
});

afterEach(async () => {
  mock.timers.reset();
  await browser?.happyDOM.abort();
  mock.restoreAll();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

const BROWSER_USER = { id: 'user_browser', email: 'browser@example.com' };
const HANDOFF_URL = 'https://www.worldmonitor.app/pro?wm_checkout_handoff=desktop#pricing';

interface FixtureOptions {
  signedOut?: boolean;
  url?: string;
  email?: string;
  /** How the Clerk double's signOut behaves; real Clerk skips the callback with zero sessions. */
  signOut?: 'callback' | 'no-callback' | 'reject';
}

async function fixture(options: FixtureOptions = {}) {
  mock.method(console, 'error', () => {});
  // A successful checkout arms the redirect hold and the interstitial safety
  // timer; neither may outlive the test (same rule as pro-checkout-feedback).
  mock.timers.enable({ apis: ['setTimeout'] });
  browser = new Window({ url: options.url ?? HANDOFF_URL });
  const navigations: string[] = [];
  const signIns: Array<{ afterSignInUrl?: string }> = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  let signOuts = 0;
  type ClerkUser = { id: string; primaryEmailAddress: { emailAddress: string } };
  const user: ClerkUser = { id: BROWSER_USER.id, primaryEmailAddress: { emailAddress: options.email ?? BROWSER_USER.email } };
  const clerk = {
    user: (options.signedOut ? null : user) as ClerkUser | null,
    session: { getToken: async () => 'synthetic-token' },
    openSignIn: (intent: { afterSignInUrl?: string }) => { signIns.push(intent); },
    // Real Clerk: without a callback, signOut navigates to the after-sign-out
    // URL, which would take the buyer off /pro before sign-in can reopen.
    signOut: async (callback?: () => void | Promise<void>) => {
      signOuts++;
      if (options.signOut === 'reject') throw new Error('Synthetic sign-out failure');
      clerk.user = null;
      if (!callback) navigations.push('clerk-after-sign-out-redirect');
      else if (options.signOut !== 'no-callback') await callback();
    },
  };
  const location = {
    get href() { return browser.location.href; },
    get search() { return browser.location.search; },
    get pathname() { return browser.location.pathname; },
    get hash() { return browser.location.hash; },
    assign: (url: string) => navigations.push(url),
  };
  const globals: Record<string, unknown> = {
    document: browser.document,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    window: {
      addEventListener() {}, removeEventListener() {},
      location,
      history: { replaceState: (_state: unknown, _title: string, url: string) => browser.history.replaceState({}, '', url) },
      sessionStorage: browser.sessionStorage,
      umami: { track() {} },
      setTimeout: browser.setTimeout.bind(browser), clearTimeout: browser.clearTimeout.bind(browser),
      setInterval: browser.setInterval.bind(browser), clearInterval: browser.clearInterval.bind(browser),
    },
    fetch: async (_url: string, init: { body: string }) => {
      requestBodies.push(JSON.parse(init.body));
      return Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
    },
    __checkoutFixture: { clerk: async () => clerk },
  };
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const checkout = await import(`${moduleUrl}#${Math.random()}`);
  const dialog = () => document.querySelector<HTMLElement>('#wm-pro-desktop-account-dialog');
  const click = (suffix: string) => {
    const button = document.getElementById(`wm-pro-desktop-account-dialog-${suffix}`);
    assert.ok(button, `dialog button ${suffix} must exist`);
    button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  };
  // setTimeout is mocked, and the fingerprint hash resolves off the microtask
  // queue, so drain real event-loop turns instead.
  const settle = async () => {
    for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
  };
  return {
    checkout, clerk, navigations, signIns, requestBodies, signOuts: () => signOuts, dialog, click, settle,
    search: () => new URLSearchParams(browser.location.search),
  };
}

const OTHER_ACCOUNT = fingerprintCheckoutAccount('user_desktop');
const mismatched = async () => ({ desktopHandoff: true, accountFingerprint: await OTHER_ACCOUNT });

it('charges the browser account when it is the desktop account', async () => {
  const f = await fixture();
  const ok = await f.checkout.startCheckout('pro_monthly', {
    desktopHandoff: true,
    accountFingerprint: await fingerprintCheckoutAccount(BROWSER_USER.id),
  });
  assert.equal(ok, true);
  assert.equal(f.dialog(), null);
  assert.equal(f.requestBodies.length, 1);
  assert.match(String(f.requestBodies[0]!.returnUrl), /wm_src=desktop/);
});

it('asks before upgrading a browser account that is not the desktop account', async () => {
  const f = await fixture();
  const ok = await f.checkout.startCheckout('pro_monthly', {
    desktopHandoff: true,
    accountFingerprint: await fingerprintCheckoutAccount('user_desktop'),
  });
  assert.equal(ok, false, 'no checkout may start before the user decides');
  assert.equal(f.requestBodies.length, 0);
  assert.deepEqual(f.navigations, []);
  const dialog = f.dialog();
  assert.ok(dialog, 'the mismatch must be shown, not silently charged');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  const text = dialog.textContent ?? '';
  assert.ok(text.includes(BROWSER_USER.email), 'names the account this browser would upgrade');
  assert.match(text, /desktop app/i);
});

it('"switch account" signs the browser out and re-opens sign-in with the bound intent', async () => {
  const f = await fixture();
  const fingerprint = await fingerprintCheckoutAccount('user_desktop');
  await f.checkout.startCheckout('pro_monthly', { desktopHandoff: true, accountFingerprint: fingerprint });
  f.click('switch');
  await f.settle();
  assert.equal(f.signOuts(), 1);
  assert.deepEqual(f.navigations, [], 'the buyer must stay on /pro while switching accounts');
  assert.equal(f.signIns.length, 1);
  const returnUrl = new URL(f.signIns[0]!.afterSignInUrl!);
  assert.equal(returnUrl.searchParams.get('wm_checkout_product'), 'pro_monthly');
  assert.equal(returnUrl.searchParams.get('wm_checkout_handoff'), 'desktop');
  assert.equal(returnUrl.searchParams.get('wm_checkout_account'), fingerprint, 'the check runs again after sign-in');
  assert.equal(f.requestBodies.length, 0);
  assert.equal(f.dialog(), null);
});

it('"upgrade this account anyway" checks out as a plain browser purchase', async () => {
  const f = await fixture();
  await f.checkout.startCheckout('pro_monthly', {
    desktopHandoff: true,
    accountFingerprint: await fingerprintCheckoutAccount('user_desktop'),
  });
  f.click('anyway');
  await f.settle();
  assert.equal(f.dialog(), null);
  assert.equal(f.requestBodies.length, 1);
  // The desktop app will not update, so the return page must not say it will.
  assert.doesNotMatch(String(f.requestBodies[0]!.returnUrl), /wm_src=desktop/);
  assert.deepEqual(f.navigations, ['https://checkout.dodopayments.com/test']);
});

it('does not gate a handoff that carries no fingerprint (signed-out desktop)', async () => {
  const f = await fixture();
  const ok = await f.checkout.startCheckout('pro_monthly', { desktopHandoff: true });
  assert.equal(ok, true);
  assert.equal(f.dialog(), null);
  assert.equal(f.requestBodies.length, 1);
});

// --- Post-sign-in resume: the check has to run again, and the desktop context
// has to outlive the intent strip, or a dismissed dialog is a silent bypass. ---

const resumeUrl = (fingerprint: string) =>
  `https://www.worldmonitor.app/pro?wm_checkout_product=pro_monthly&wm_checkout_handoff=desktop&wm_checkout_account=${fingerprint}#pricing`;

it('re-checks the account when checkout resumes after sign-in', async () => {
  const fingerprint = await OTHER_ACCOUNT;
  const f = await fixture({ url: resumeUrl(fingerprint) });
  assert.equal(await f.checkout.tryResumeCheckoutFromUrl(), false);
  assert.ok(f.dialog(), 'signing in as yet another account must ask again');
  assert.equal(f.requestBodies.length, 0);
  // Consumed: a reload must not re-fire checkout. Kept: the desktop context,
  // so the next pricing click is still checked.
  assert.equal(f.search().has('wm_checkout_product'), false);
  assert.equal(f.search().get('wm_checkout_handoff'), 'desktop');
  assert.equal(f.search().get('wm_checkout_account'), fingerprint);
});

it('resumes straight into checkout when the signed-in account is the desktop one', async () => {
  const f = await fixture({ url: resumeUrl(await fingerprintCheckoutAccount(BROWSER_USER.id)) });
  assert.equal(await f.checkout.tryResumeCheckoutFromUrl(), true);
  assert.equal(f.dialog(), null);
  assert.equal(f.requestBodies.length, 1);
  assert.match(String(f.requestBodies[0]!.returnUrl), /wm_src=desktop/);
});

// --- Dismissal is not a choice: nothing is charged and the next click asks again. ---

for (const how of ['Escape', 'a backdrop click'] as const) {
  it(`dismissing with ${how} charges nobody and the next click asks again`, async () => {
    const f = await fixture();
    await f.checkout.startCheckout('pro_monthly', await mismatched());
    if (how === 'Escape') {
      document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else {
      f.dialog()!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    }
    await f.settle();
    assert.equal(f.dialog(), null);
    assert.equal(f.requestBodies.length, 0);
    assert.equal(f.signOuts(), 0);
    assert.equal(f.signIns.length, 0);
    await f.checkout.startCheckout('pro_monthly', await mismatched());
    assert.ok(f.dialog());
  });
}

it('carries the binding into sign-in when the browser is signed out', async () => {
  const f = await fixture({ signedOut: true });
  const options = await mismatched();
  assert.equal(await f.checkout.startCheckout('pro_monthly', options), false);
  assert.equal(f.dialog(), null);
  assert.equal(f.requestBodies.length, 0);
  const returnUrl = new URL(f.signIns[0]!.afterSignInUrl!);
  assert.equal(returnUrl.searchParams.get('wm_checkout_handoff'), 'desktop');
  assert.equal(returnUrl.searchParams.get('wm_checkout_account'), options.accountFingerprint);
});

// --- The dialog must act on the account it named. ---

it('does not charge a different account that became active while the dialog was open', async () => {
  const f = await fixture();
  await f.checkout.startCheckout('pro_monthly', await mismatched());
  // Another tab switched this browser to a third account.
  f.clerk.user = { id: 'user_third', primaryEmailAddress: { emailAddress: 'third@example.com' } };
  f.click('anyway');
  await f.settle();
  assert.equal(f.requestBodies.length, 0, 'the button named browser@example.com, not third@example.com');
  const text = f.dialog()?.textContent ?? '';
  assert.ok(text.includes('third@example.com'), 'the check runs again for the account that is now active');
});

it('still reopens sign-in when Clerk signs out without running the callback', async () => {
  // Real Clerk resolves signOut without the callback when the client already
  // has zero sessions (ended in another tab while the dialog was open).
  const f = await fixture({ signOut: 'no-callback' });
  await f.checkout.startCheckout('pro_monthly', await mismatched());
  f.click('switch');
  await f.settle();
  assert.equal(f.signIns.length, 1, 'the dialog is closed, so something must open');
  assert.deepEqual(f.navigations, []);
});

it('tells the buyer when switching accounts fails', async () => {
  const f = await fixture({ signOut: 'reject' });
  await f.checkout.startCheckout('pro_monthly', await mismatched());
  f.click('switch');
  await f.settle();
  assert.equal(f.signIns.length, 0);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /sign out and try again/i);
});

it('renders a hostile email as text, never as markup', async () => {
  const f = await fixture({ email: '<img src=x onerror=alert(1)>@example.com' });
  await f.checkout.startCheckout('pro_monthly', await mismatched());
  const dialog = f.dialog()!;
  assert.equal(dialog.querySelector('img'), null);
  assert.ok((dialog.textContent ?? '').includes('<img src=x onerror=alert(1)>@example.com'));
});
