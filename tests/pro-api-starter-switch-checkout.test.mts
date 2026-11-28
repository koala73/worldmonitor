/**
 * /pro asks for the in-place API Starter switch before every signed-in API
 * Starter checkout. Drives the real `startCheckout` and
 * `tryResumeCheckoutFromUrl` with the esbuild + happy-dom fixture of
 * `pro-desktop-account-handoff.test.mts`, and asserts on the requests sent.
 *
 * Deploy order: a new /pro on an older edge gets 404 from the route, and an
 * older Convex behind a new edge gives 502. Both continue to the checkout.
 */
import assert from 'node:assert/strict';
import { afterEach, before, it, mock } from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

import tiers from '../pro-test/src/generated/tiers.json' with { type: 'json' };

const tier = (name: string) => (tiers as Array<{ name: string; monthlyProductId: string; annualProductId: string }>)
  .find((t) => t.name === name)!;
const API_STARTER_MONTHLY = tier('API Starter').monthlyProductId;
const API_STARTER_ANNUAL = tier('API Starter').annualProductId;
const PRO_MONTHLY = tier('Pro').monthlyProductId;
const USER = 'user_pro_a';

const QUOTE = {
  kind: 'preview', fromPlanKey: 'pro_monthly', toPlanKey: 'api_starter', chargeAmount: 6012, currency: 'USD',
  renewalAmount: 9999, renewalCurrency: 'USD', renewalDate: '2026-12-27T10:00:00Z', billingPeriod: 'monthly',
  discounted: false, percentOff: null, acceptsQuoteGuards: true,
};

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
             export const ensureClerk = () => globalThis.__checkoutFixture.clerk();
             export const setAuthReturnUrls = (urls) => { globalThis.__checkoutFixture.authReturnUrls.push(urls); };`
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
  createdAt?: Date;
  /** Replies of /api/api-starter-switch, in order; none left is a network failure. */
  switchReplies?: Array<{ status: number; body: unknown }>;
}) {
  mock.method(console, 'error', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  const href = options.href ?? 'https://www.worldmonitor.app/pro#pricing';
  browser = new Window({ url: href });
  const state = {
    user: options.browserUser
      ? { id: options.browserUser, primaryEmailAddress: { emailAddress: 'b@example.com' }, createdAt: options.createdAt }
      : null,
  };
  const navigations: string[] = [];
  const signIns: Array<{ afterSignInUrl?: string; afterSignUpUrl?: string }> = [];
  const authReturnUrls: unknown[] = [];
  const signUps: Array<{ afterSignInUrl?: string }> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  let signOuts = 0;
  const replacedUrls: string[] = [];
  const analyticsEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
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
      umami: { track: (event: string, data?: Record<string, unknown>) => { analyticsEvents.push({ event, data }); } },
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      setInterval: browser.setInterval.bind(browser), clearInterval: browser.clearInterval.bind(browser),
    },
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      paths.push(path);
      bodies.push(JSON.parse(String(init.body)));
      if (path === '/api/api-starter-switch') {
        const reply = options.switchReplies?.shift();
        if (!reply) throw new TypeError('Failed to fetch');
        return Response.json(reply.body, { status: reply.status });
      }
      return options.responses?.shift() ?? Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
    },
    __checkoutFixture: { authReturnUrls, clerk: async () => ({
      get user() { return state.user; },
      session: { getToken: async () => { options.onGetToken?.(state); return 'synthetic-token'; } },
      openSignIn: (intent: { afterSignInUrl?: string }) => { signIns.push(intent); },
      openSignUp: (intent: { afterSignInUrl?: string }) => { signUps.push(intent); },
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
  return { checkout, navigations, signIns, signUps, bodies, paths, signOuts: () => signOuts, state, replacedUrls, analyticsEvents, authReturnUrls };
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: RegExp) => [...document.querySelectorAll('[role="dialog"] button')]
  .find((el) => label.test(el.textContent ?? '')) as HTMLButtonElement | undefined;

// crypto.subtle.digest settles on a macrotask, and setTimeout is mocked here.
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2_000 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), label);
}

const SWITCH = '/api/api-starter-switch';
const CHECKOUT = '/api/create-checkout';

for (const productId of [API_STARTER_MONTHLY, API_STARTER_ANNUAL]) {
  it(`shows the switch quote instead of a checkout for a Pro holder (${productId})`, async () => {
    const f = await fixture({ browserUser: USER, switchReplies: [{ status: 200, body: QUOTE }] });
    assert.equal(await f.checkout.startCheckout(productId), false);
    assert.deepEqual(f.paths, [SWITCH]);
    assert.deepEqual(f.bodies, [{ confirm: false }]);
    assert.equal(dialog()?.querySelector('h2')?.textContent, 'Switch to API Starter');
  });
}

const CONTINUES: Array<[string, { status: number; body: unknown } | null]> = [
  ['NO_UPGRADEABLE_PRO', { status: 409, body: { error: 'NO_UPGRADEABLE_PRO' } }],
  ['ALREADY_API_PLAN', { status: 409, body: { error: 'ALREADY_API_PLAN' } }],
  ['an edge that predates the route (404)', { status: 404, body: { error: { code: 'not_found' } } }],
  ['a Convex that predates the relay (502)', { status: 502, body: { error: 'Upgrade unavailable' } }],
  ['a network failure', null],
];
for (const [label, reply] of CONTINUES) {
  it(`continues to the normal checkout after ${label}`, async () => {
    const f = await fixture({ browserUser: USER, switchReplies: reply ? [reply] : [] });
    assert.equal(await f.checkout.startCheckout(API_STARTER_MONTHLY), true);
    assert.deepEqual(f.paths, [SWITCH, CHECKOUT]);
    assert.equal(f.bodies[1]!.productId, API_STARTER_MONTHLY);
    assert.equal(dialog(), null);
  });
}

it('stops before checkout for a cancel-scheduled Pro', async () => {
  const f = await fixture({ browserUser: USER, switchReplies: [{ status: 409, body: { error: 'PRO_CANCEL_SCHEDULED' } }] });
  assert.equal(await f.checkout.startCheckout(API_STARTER_MONTHLY), false);
  assert.deepEqual(f.paths, [SWITCH]);
  assert.equal(dialog()?.querySelector('h2')?.textContent, 'Resume Pro first');
});

it('never asks for other products', async () => {
  const f = await fixture({ browserUser: USER, switchReplies: [{ status: 200, body: QUOTE }] });
  assert.equal(await f.checkout.startCheckout(PRO_MONTHLY), true);
  assert.deepEqual(f.paths, [CHECKOUT]);
});

it('never asks for a signed-out visitor', async () => {
  const f = await fixture({ browserUser: null, switchReplies: [{ status: 200, body: QUOTE }] });
  const attempt = f.checkout.startCheckout(API_STARTER_MONTHLY);
  await waitFor(() => dialog() !== null, 'the auth chooser opens');
  button(/cancel|close|not now/i)?.click();
  document.querySelector<HTMLButtonElement>('[role="dialog"] button:last-of-type')?.click();
  await attempt;
  assert.deepEqual(f.paths, []);
});

it('asks again when a signed-in visitor resumes an API Starter checkout after sign-in', async () => {
  const href = `https://www.worldmonitor.app/pro?wm_checkout_product=${API_STARTER_MONTHLY}#pricing`;
  const f = await fixture({ browserUser: USER, href, switchReplies: [{ status: 200, body: QUOTE }] });
  assert.equal(await f.checkout.tryResumeCheckoutFromUrl(), false);
  assert.deepEqual(f.paths, [SWITCH]);
  assert.equal(dialog()?.querySelector('h2')?.textContent, 'Switch to API Starter');
});
