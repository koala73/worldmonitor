/**
 * #10342: a desktop "Upgrade to Pro" hands checkout to the OS browser, where
 * /pro creates it with the BROWSER's Clerk session. When that session is a
 * different account from the desktop app's, the purchase used to unlock the
 * browser account while the return page told the buyer the app would update.
 *
 * The handoff now names the desktop account (a digest of its Clerk id), and
 * /pro must not start that checkout until the buyer either switches to the
 * desktop account or confirms upgrading the browser account instead.
 *
 * Drives the real `startCheckout` and `tryResumeCheckoutFromUrl` with the same
 * esbuild + happy-dom fixture as `pro-checkout-feedback.test.mts`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, before, it, mock } from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const DESKTOP_USER = 'user_desktop_a';
const BROWSER_USER = 'user_browser_b';

function digest(userId: string): string {
  return createHash('sha256').update(`wm-desktop-checkout:${userId}`).digest('hex').slice(0, 16);
}

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
          ? `export class SiteDataBlockedError extends Error { name = 'SiteDataBlockedError'; }
             export const SITE_DATA_BLOCKED_MESSAGE = 'site data blocked';
             export const ensureClerk = () => globalThis.__checkoutFixture.clerk();`
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

async function fixture(options: {
  browserUser: string | null;
  href?: string;
  responses?: Response[];
  onGetToken?: (state: { user: unknown }) => void;
}) {
  mock.method(console, 'error', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  const href = options.href ?? 'https://www.worldmonitor.app/pro#pricing';
  browser = new Window({ url: href });
  const state = {
    user: options.browserUser
      ? { id: options.browserUser, primaryEmailAddress: { emailAddress: 'b@example.com' } }
      : null,
  };
  const navigations: string[] = [];
  const signIns: Array<{ afterSignInUrl?: string }> = [];
  const bodies: Array<Record<string, unknown>> = [];
  let signOuts = 0;
  const replacedUrls: string[] = [];
  const globals: Record<string, unknown> = {
    document: browser.document,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: {
        href,
        search: new URL(href).search,
        pathname: new URL(href).pathname,
        hash: new URL(href).hash,
        assign: (url: string) => navigations.push(url),
      },
      history: { replaceState: (_s: unknown, _t: string, url: string) => { replacedUrls.push(url); } },
      sessionStorage: browser.sessionStorage,
      umami: { track() {} },
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      setInterval: browser.setInterval.bind(browser), clearInterval: browser.clearInterval.bind(browser),
    },
    fetch: async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return options.responses?.shift() ?? Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
    },
    __checkoutFixture: { clerk: async () => ({
      get user() { return state.user; },
      session: { getToken: async () => { options.onGetToken?.(state); return 'synthetic-token'; } },
      openSignIn: (intent: { afterSignInUrl?: string }) => { signIns.push(intent); },
      // Clerk navigates to its after-sign-out URL unless given a callback.
      signOut: async (callback?: () => void) => {
        signOuts++;
        state.user = null;
        if (callback) callback();
        else navigations.push('/after-sign-out');
      },
    }) },
  };
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const checkout = await import(`${moduleUrl}#${Math.random()}`);
  return { checkout, navigations, signIns, bodies, signOuts: () => signOuts, state, replacedUrls };
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: RegExp) => [...document.querySelectorAll('[role="dialog"] button')]
  .find((el) => label.test(el.textContent ?? '')) as HTMLButtonElement | undefined;

// crypto.subtle.digest settles on a macrotask, and setTimeout is mocked here.
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2_000 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), label);
}

it('does not start checkout for the browser account when the desktop app uses another one', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  });
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  assert.deepEqual(f.bodies, [], 'no checkout may be created before the buyer decides');
  assert.ok(dialog(), 'the buyer must be told which account the purchase would upgrade');
  assert.match(dialog()?.textContent ?? '', /b@example\.com/);
  button(/cancel/i)?.click();
  assert.equal(await attempt, false);
  assert.equal(dialog(), null);
  assert.deepEqual(f.bodies, []);
});

it('switches to the desktop account and resumes the same checkout after sign-in', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  });
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  button(/switch account/i)?.click();
  assert.equal(await attempt, false);
  assert.equal(f.signOuts(), 1);
  assert.deepEqual(f.navigations, [], 'sign-out must not navigate away from /pro before sign-in opens');
  assert.equal(f.signIns.length, 1);
  const resume = new URL(f.signIns[0]!.afterSignInUrl!);
  assert.equal(resume.searchParams.get('wm_checkout_product'), 'synthetic-product');
  assert.equal(resume.searchParams.get('wm_checkout_handoff'), 'desktop');
  assert.equal(resume.searchParams.get('wm_checkout_account'), digest(DESKTOP_USER));
  assert.deepEqual(f.bodies, []);
});

it('upgrades the browser account only after the buyer confirms, without the desktop return copy', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  });
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  button(/upgrade this account/i)?.click();
  assert.equal(await attempt, true);
  assert.equal(f.bodies.length, 1);
  assert.doesNotMatch(String(f.bodies[0]!.returnUrl), /wm_src=desktop/,
    'the return page must not promise the desktop app will update');
});

it('starts checkout straight away when the browser is signed in to the desktop account', async () => {
  const f = await fixture({ browserUser: DESKTOP_USER });
  assert.equal(await f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  }), true);
  assert.equal(dialog(), null);
  assert.match(String(f.bodies[0]!.returnUrl), /wm_src=desktop/);
});

it('keeps the old behaviour for a handoff that names no desktop account', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  assert.equal(await f.checkout.startCheckout('synthetic-product', { desktopHandoff: {} }), true);
  assert.equal(dialog(), null);
  assert.match(String(f.bodies[0]!.returnUrl), /wm_src=desktop/);
});

it('carries the desktop account through the sign-in detour of a signed-out browser', async () => {
  const f = await fixture({ browserUser: null });
  assert.equal(await f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  }), false);
  const resume = new URL(f.signIns[0]!.afterSignInUrl!);
  assert.equal(resume.searchParams.get('wm_checkout_account'), digest(DESKTOP_USER));
});

it('checks the account again when checkout resumes after a sign-in to the wrong account', async () => {
  const f = await fixture({
    browserUser: BROWSER_USER,
    href: 'https://www.worldmonitor.app/pro?wm_checkout_product=synthetic-product'
      + `&wm_checkout_handoff=desktop&wm_checkout_account=${digest(DESKTOP_USER)}#pricing`,
  });
  const resumed = f.checkout.tryResumeCheckoutFromUrl();
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  assert.deepEqual(f.bodies, []);
  assert.ok(dialog());
  button(/cancel/i)?.click();
  assert.equal(await resumed, false);
});

it('asks again when the browser account changes while the dialog is open', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  });
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  f.state.user = { id: 'user_other_c', primaryEmailAddress: { emailAddress: 'c@example.com' } };
  button(/upgrade this account/i)?.click();
  await waitFor(() => /c@example\.com/.test(dialog()?.textContent ?? ''), 'the dialog asks again for the current account');
  assert.deepEqual(f.bodies, [], 'approval for one account must not check out another');
  button(/cancel/i)?.click();
  assert.equal(await attempt, false);
});

it('keeps the desktop handoff on the page after a canceled resume, so a retry checks again', async () => {
  const f = await fixture({
    browserUser: BROWSER_USER,
    href: 'https://www.worldmonitor.app/pro?wm_checkout_product=synthetic-product'
      + `&wm_checkout_handoff=desktop&wm_checkout_account=${digest(DESKTOP_USER)}#pricing`,
  });
  const resumed = f.checkout.tryResumeCheckoutFromUrl();
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  button(/cancel/i)?.click();
  assert.equal(await resumed, false);
  const kept = new URL(f.replacedUrls[0]!, 'https://www.worldmonitor.app');
  assert.equal(kept.searchParams.get('wm_checkout_product'), null);
  assert.equal(kept.searchParams.get('wm_checkout_account'), digest(DESKTOP_USER));
});

it('keeps keyboard focus inside the dialog', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  });
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  const buttons = [...document.querySelectorAll('[role="dialog"] button')];
  assert.equal(document.activeElement, buttons.at(-1));
  document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(document.activeElement, buttons[0], 'Tab from the last button wraps to the first');
  document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
  assert.equal(document.activeElement, buttons.at(-1), 'Shift+Tab from the first button wraps to the last');
  document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await attempt, false);
});

it('asks which account to upgrade when the desktop app could not read its own session', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: 'unknown' },
  });
  await waitFor(() => dialog() !== null, 'the account dialog opens');
  assert.deepEqual(f.bodies, [], 'no checkout may be created before the buyer confirms');
  assert.match(dialog()?.textContent ?? '', /confirm the account to upgrade/i);
  assert.match(dialog()?.textContent ?? '', /b@example\.com/);
  assert.doesNotMatch(dialog()?.textContent ?? '', /uses a different account/i,
    'an unread desktop session is not known to differ');
  button(/upgrade this account/i)?.click();
  assert.equal(await attempt, true);
  assert.equal(f.bodies.length, 1);
});

it('does not reuse a pending-payment approval after the browser account changes', async () => {
  const f = await fixture({
    browserUser: DESKTOP_USER,
    responses: [Response.json({ error: 'PAYMENT_IN_PROGRESS', pendingPayment: { planKey: 'pro_monthly' } }, { status: 409 })],
  });
  assert.equal(await f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  }), false);
  const confirm = () => document.getElementById('wm-pro-pending-payment-dialog-confirm') as HTMLButtonElement | null;
  await waitFor(() => confirm() !== null, 'the pending-payment dialog opens');
  f.state.user = { id: BROWSER_USER, primaryEmailAddress: { emailAddress: 'b@example.com' } };
  confirm()?.click();
  await waitFor(() => dialog()?.id === 'wm-pro-desktop-account-dialog', 'the account check runs for the new account');
  assert.equal(f.bodies.length, 1, 'no checkout for the new account before it is confirmed');
  button(/upgrade this account/i)?.click();
  await waitFor(() => f.bodies.length === 2, 'checkout restarts for the confirmed account');
  assert.equal(f.bodies[1]!.bypassPendingGuard, undefined,
    'the new account never approved skipping its own pending-payment guard');
});

it('keeps the pending-payment approval for the account that gave it', async () => {
  const f = await fixture({
    browserUser: DESKTOP_USER,
    responses: [Response.json({ error: 'PAYMENT_IN_PROGRESS', pendingPayment: { planKey: 'pro_monthly' } }, { status: 409 })],
  });
  await f.checkout.startCheckout('synthetic-product', { desktopHandoff: { account: digest(DESKTOP_USER) } });
  const confirm = () => document.getElementById('wm-pro-pending-payment-dialog-confirm') as HTMLButtonElement | null;
  await waitFor(() => confirm() !== null, 'the pending-payment dialog opens');
  confirm()?.click();
  await waitFor(() => f.bodies.length === 2, 'checkout retries');
  assert.equal(f.bodies[1]!.bypassPendingGuard, true);
});

it('checks the account again when another tab switches it while checkout fetches its token', async () => {
  let switched = false;
  const f = await fixture({
    browserUser: DESKTOP_USER,
    onGetToken: (state) => {
      if (switched) return;
      switched = true;
      state.user = { id: BROWSER_USER, primaryEmailAddress: { emailAddress: 'b@example.com' } };
    },
  });
  assert.equal(await f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  }), false);
  await waitFor(() => dialog() !== null, 'the account dialog opens for the new account');
  assert.deepEqual(f.bodies, [], 'the new account token must not create the desktop checkout');
  button(/upgrade this account/i)?.click();
  await waitFor(() => f.bodies.length === 1, 'checkout continues once the new account is confirmed');
  assert.doesNotMatch(String(f.bodies[0]!.returnUrl), /wm_src=desktop/);
});
