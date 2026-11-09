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

async function fixture(options: { browserUser: string | null; href?: string }) {
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
      history: { replaceState: () => {} },
      sessionStorage: browser.sessionStorage,
      umami: { track() {} },
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      setInterval: browser.setInterval.bind(browser), clearInterval: browser.clearInterval.bind(browser),
    },
    fetch: async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
    },
    __checkoutFixture: { clerk: async () => ({
      get user() { return state.user; },
      session: { getToken: async () => 'synthetic-token' },
      openSignIn: (intent: { afterSignInUrl?: string }) => { signIns.push(intent); },
      signOut: async () => { signOuts++; state.user = null; },
    }) },
  };
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const checkout = await import(`${moduleUrl}#${Math.random()}`);
  return { checkout, navigations, signIns, bodies, signOuts: () => signOuts };
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: RegExp) => [...document.querySelectorAll('[role="dialog"] button')]
  .find((el) => label.test(el.textContent ?? '')) as HTMLButtonElement | undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

it('does not start checkout for the browser account when the desktop app uses another one', async () => {
  const f = await fixture({ browserUser: BROWSER_USER });
  const attempt = f.checkout.startCheckout('synthetic-product', {
    desktopHandoff: { account: digest(DESKTOP_USER) },
  });
  await settle();
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
  await settle();
  button(/switch account/i)?.click();
  assert.equal(await attempt, false);
  assert.equal(f.signOuts(), 1);
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
  await settle();
  button(/upgrade b@example\.com/i)?.click();
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
  await settle();
  assert.deepEqual(f.bodies, []);
  assert.ok(dialog());
  button(/cancel/i)?.click();
  assert.equal(await resumed, false);
});
