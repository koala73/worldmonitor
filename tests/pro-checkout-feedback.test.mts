import assert from 'node:assert/strict';
import { afterEach, before, it, mock } from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const SITE_DATA_BLOCKED_MESSAGE = 'Your browser is blocking cookies and site data for worldmonitor.app. Allow them for this site, then try again.';

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
             export const SITE_DATA_BLOCKED_MESSAGE = ${JSON.stringify(SITE_DATA_BLOCKED_MESSAGE)};
             export const ensureClerk = () => globalThis.__checkoutFixture.clerk({ SiteDataBlockedError });
             export const setAuthReturnUrls = (urls) => { globalThis.__checkoutFixture.authReturnUrls.push(urls); };`
          : `export const captureException = (...args) => { globalThis.__checkoutFixture.captures.push(args); };
             export const captureMessage = () => {};`,
      }));
    } }],
  });
  moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
});

afterEach(async () => {
  await browser?.happyDOM.abort();
  mock.restoreAll();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

async function fixture(options: {
  clerkError?: boolean; siteDataBlocked?: boolean; signUpError?: boolean; signInError?: boolean; signedOut?: boolean; missingToken?: boolean;
  /** The chooser button a signed-out buyer clicks; null leaves the chooser open. */
  authChoice?: RegExp | null;
  response?: () => Promise<Response>;
} = {}) {
  mock.method(console, 'error', () => {});
  browser = new Window({ url: 'https://www.worldmonitor.app/pro#pricing' });
  const navigations: string[] = [];
  const signIns: Array<{ afterSignUpUrl?: string; afterSignInUrl?: string }> = [];
  const signUps: Array<{ afterSignUpUrl?: string; afterSignInUrl?: string }> = [];
  const pageListeners = new Map<string, Set<(event: { persisted: boolean }) => void>>();
  const captures: unknown[][] = [];
  const authReturnUrls: unknown[] = [];
  const returnUrlsAtOpen: number[] = [];
  const analyticsEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
  let requests = 0;
  const globals: Record<string, unknown> = {
    document: browser.document,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    window: {
      innerWidth: 1000,
      addEventListener: (type: string, fn: (event: { persisted: boolean }) => void) => {
        if (!pageListeners.has(type)) pageListeners.set(type, new Set());
        pageListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (event: { persisted: boolean }) => void) => {
        pageListeners.get(type)?.delete(fn);
      },
      location: { href: browser.location.href, assign: (url: string) => navigations.push(url) },
      sessionStorage: browser.sessionStorage,
      umami: { track: (event: string, data?: Record<string, unknown>) => analyticsEvents.push({ event, data }) },
      setTimeout: browser.setTimeout.bind(browser), clearTimeout: browser.clearTimeout.bind(browser),
      setInterval: browser.setInterval.bind(browser), clearInterval: browser.clearInterval.bind(browser),
    },
    fetch: async () => {
      requests++;
      return options.response?.() ?? Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
    },
    __checkoutFixture: { captures, authReturnUrls, clerk: async ({ SiteDataBlockedError }: { SiteDataBlockedError: new (message: string) => Error }) => {
      if (options.siteDataBlocked) throw new SiteDataBlockedError('localStorage is not readable');
      if (options.clerkError) throw new Error('Synthetic auth failure');
      return {
        user: options.signedOut ? null : { id: 'user_test' },
        session: { getToken: async () => options.missingToken ? null : 'synthetic-token' },
        openSignIn: (intent: { afterSignUpUrl?: string; afterSignInUrl?: string }) => {
          if (options.signInError) throw new Error('Synthetic modal failure');
          returnUrlsAtOpen.push(authReturnUrls.length);
          signIns.push(intent);
        },
        openSignUp: (intent: { afterSignUpUrl?: string; afterSignInUrl?: string }) => {
          if (options.signUpError) throw new Error('Synthetic modal failure');
          returnUrlsAtOpen.push(authReturnUrls.length);
          signUps.push(intent);
        },
      };
    } },
  };
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const authChoice = options.authChoice === undefined ? /create account/i : options.authChoice;
  if (authChoice) {
    new browser.MutationObserver(() => chooserButton(authChoice)?.click())
      .observe(browser.document.body, { childList: true });
  }
  const checkout = await import(`${moduleUrl}#${Math.random()}`);
  const phases: Array<{ kind: string; productId?: string }> = [];
  checkout.subscribeCheckoutPhase((phase: { kind: string }) => phases.push(phase));
  const firePageShow = (persisted: boolean) => {
    for (const fn of [...(pageListeners.get('pageshow') ?? [])]) fn({ persisted });
  };
  return { checkout, phases, navigations, signIns, signUps, captures, authReturnUrls, returnUrlsAtOpen, analyticsEvents, requests: () => requests, options, firePageShow };
}

const chooser = () => document.getElementById('wm-pro-auth-form-dialog');
const chooserButton = (label: RegExp) => [...(chooser()?.querySelectorAll('button') ?? [])]
  .find((el) => label.test(el.textContent ?? '')) as HTMLButtonElement | undefined;

for (const [name, options] of [
  ['auth loading fails', { clerkError: true }],
  ['sign-up modal fails', { signedOut: true, signUpError: true }],
  ['sign-in modal fails', { signedOut: true, signInError: true, authChoice: /sign in/i }],
  ['auth token is unavailable', { missingToken: true }],
  ['checkout returns 503', { response: async () => Response.json({ error: 'Service unavailable' }, { status: 503 }) }],
  ['network fails', { response: async () => { throw new TypeError('Failed to fetch'); } }],
  ['checkout URL is untrusted', { response: async () => Response.json({ checkout_url: 'https://untrusted.example/checkout' }) }],
] as const) {
  it(`shows an actionable error and releases the CTA when ${name}`, async () => {
    const f = await fixture(options);
    assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, 'failed checkout must not silently return to the pricing page');
    assert.match(alert.textContent ?? '', /try again|retry/i);
    assert.equal(f.phases.at(-1)?.kind, 'idle');
    assert.deepEqual(f.navigations, []);
  });
}

it('tells the buyer to allow site data, without paging Sentry, when the browser blocks it', async () => {
  const f = await fixture({ siteDataBlocked: true });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, SITE_DATA_BLOCKED_MESSAGE);
  assert.deepEqual(f.captures, []);
  assert.equal(f.phases.at(-1)?.kind, 'idle');
});

it('keeps the retry toast and the Sentry report for any other auth load failure', async () => {
  const f = await fixture({ clerkError: true });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Sign-in could not load. Please try again.');
  assert.equal(f.captures.length, 1);
  assert.deepEqual(f.captures[0]?.[1], { tags: { surface: 'pro-marketing', action: 'load-clerk' } });
});

it('shows loading before auth resolves and leaves dismissed sign-up retryable', async () => {
  const f = await fixture({ signedOut: true });
  const attempt = f.checkout.startCheckout('synthetic-product');
  assert.equal(f.phases.at(-1)?.kind, 'loading_auth');
  assert.equal(await attempt, false);
  assert.equal(f.signUps.length, 1);
  assert.equal(f.requests(), 0);
  assert.equal(f.phases.at(-1)?.kind, 'idle');
  assert.equal(document.querySelector('[role="alert"]'), null);
  await f.checkout.startCheckout('synthetic-product');
  assert.equal(f.signUps.length, 2);
});

it('asks a signed-out buyer to create an account or sign in before Clerk opens', async () => {
  const f = await fixture({ signedOut: true, authChoice: null });
  const attempt = f.checkout.startCheckout('synthetic-product');
  for (let i = 0; i < 100 && !chooser(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chooser()?.getAttribute('role'), 'dialog');
  assert.ok(chooserButton(/new here\? create account/i));
  assert.ok(chooserButton(/have an account\? sign in/i));
  assert.equal(document.activeElement, chooserButton(/create account/i));
  assert.deepEqual([f.signUps.length, f.signIns.length], [0, 0], 'no Clerk form before the buyer picks one');
  chooserButton(/cancel/i)?.click();
  assert.equal(await attempt, false);
  assert.equal(chooser(), null);
  assert.deepEqual([f.signUps.length, f.signIns.length], [0, 0]);
  assert.deepEqual(f.analyticsEvents.map(item => item.event), ['checkout-start']);
  assert.equal(f.phases.at(-1)?.kind, 'idle');
  assert.equal(document.querySelector('[role="alert"]'), null);
});

it('returns keyboard focus to the clicked checkout button when the chooser is cancelled', async () => {
  const f = await fixture({ signedOut: true, authChoice: null });
  // Stand-in for PricingSection: the clicked CTA is disabled while auth loads,
  // and a disabled control loses focus (browser focus fixup).
  const cta = document.createElement('button');
  document.body.appendChild(cta);
  f.checkout.subscribeCheckoutPhase((phase: { kind: string }) => {
    cta.disabled = phase.kind === 'loading_auth';
    if (cta.disabled && document.activeElement === cta) cta.blur();
  });
  cta.focus();
  const attempt = f.checkout.startCheckout('synthetic-product');
  for (let i = 0; i < 100 && !chooser(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(chooser());
  assert.equal(cta.disabled, false, 'the CTA is re-enabled behind the chooser so focus can return to it');
  chooserButton(/cancel/i)?.click();
  assert.equal(await attempt, false);
  assert.equal(document.activeElement, cta);
});

for (const [label, form] of [[/create account/i, 'sign-up'], [/sign in/i, 'sign-in']] as const) {
  it(`opens only ${form} for that choice, with the intent on both return URLs`, async () => {
    const f = await fixture({ signedOut: true, authChoice: label });
    assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
    const [opened, other] = form === 'sign-up' ? [f.signUps, f.signIns] : [f.signIns, f.signUps];
    assert.equal(opened.length, 1);
    assert.deepEqual(other, []);
    const { afterSignUpUrl, afterSignInUrl } = opened[0]!;
    assert.ok(afterSignUpUrl);
    assert.equal(afterSignInUrl, afterSignUpUrl, 'the footer link to the other form must resume the same checkout');
    assert.equal(new URL(afterSignUpUrl).searchParams.get('wm_checkout_product'), 'synthetic-product');
    // The sign-up code card's Sign in escape reopens sign-in with these URLs.
    assert.deepEqual(f.authReturnUrls, [{ afterSignInUrl, afterSignUpUrl }]);
    assert.deepEqual(f.returnUrlsAtOpen, [1], 'recorded before the form opens');
    assert.deepEqual(f.analyticsEvents[1]?.data, { productId: 'unknown', surface: 'pro-page', form });
  });
}

it('reports a sign-in modal failure with the checkout-sign-in tag', async () => {
  const f = await fixture({ signedOut: true, signInError: true, authChoice: /sign in/i });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Sign-in could not open. Please try again.');
  assert.deepEqual(f.captures[0]?.[1], { tags: { surface: 'pro-marketing', action: 'checkout-sign-in' } });
});

it('reports a sign-up modal failure with the checkout-sign-up tag', async () => {
  const f = await fixture({ signedOut: true, signUpError: true });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Sign-up could not open. Please try again.');
  assert.equal(f.captures.length, 1);
  assert.deepEqual(f.captures[0]?.[1], { tags: { surface: 'pro-marketing', action: 'checkout-sign-up' } });
});

it('clears the old error and redirects when a later attempt succeeds', async () => {
  const f = await fixture({ response: async () => Response.json({}, { status: 500 }) });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  assert.ok(document.querySelector('[role="alert"]'));
  f.options.response = async () => Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
  // The redirect hold arms a timer that must not outlive the test.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
    assert.deepEqual(f.navigations, ['https://checkout.dodopayments.com/test']);
    assert.equal(f.analyticsEvents.find(item => item.event === 'checkout-start')?.data?.vw, 'narrow-split');
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    mock.timers.reset();
  }
});

// `location.assign` only starts navigation: this page stays clickable until
// Dodo's page loads. Releasing the guard on return let a second click create a
// second Dodo session (same-account pairs 1-3 s apart in checkoutSessionEvents).
it('refuses a second checkout while the redirect to Dodo is in progress', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = await fixture();
    assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
    assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
    assert.equal(await f.checkout.startCheckout('other-product'), false);
    assert.equal(f.requests(), 1);
    assert.deepEqual(f.navigations, ['https://checkout.dodopayments.com/test']);
    assert.equal(f.phases.at(-1)?.kind, 'creating_checkout');
  } finally {
    mock.timers.reset();
  }
});

it('re-enables checkout when the buyer comes back from Dodo through the back-forward cache', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = await fixture();
    assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
    f.firePageShow(false);
    assert.equal(await f.checkout.startCheckout('synthetic-product'), false, 'a non-restored pageshow is the first load, not a return');
    f.firePageShow(true);
    assert.equal(f.phases.at(-1)?.kind, 'idle');
    assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
    assert.equal(f.requests(), 2);
  } finally {
    mock.timers.reset();
  }
});

it('releases checkout when the redirect never leaves the page', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = await fixture();
    assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
    mock.timers.tick(14_999);
    assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
    mock.timers.tick(1);
    assert.equal(f.phases.at(-1)?.kind, 'idle');
    assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
    assert.equal(f.requests(), 2);
  } finally {
    mock.timers.reset();
  }
});

it('records that the auth modal opened for a signed-out checkout click', async () => {
  const f = await fixture({ signedOut: true });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  const names = f.analyticsEvents.map(item => item.event);
  assert.deepEqual(names, ['checkout-start', 'checkout-auth-shown']);
  assert.equal(f.analyticsEvents[0]?.data?.authed, false);
  assert.deepEqual(f.analyticsEvents[1]?.data, { productId: 'unknown', surface: 'pro-page', form: 'sign-up' });
});

it('does not record the auth modal as shown when it fails to open', async () => {
  const f = await fixture({ signedOut: true, signUpError: true });
  assert.equal(await f.checkout.startCheckout('synthetic-product'), false);
  assert.deepEqual(f.analyticsEvents.map(item => item.event), ['checkout-start']);
});

it('counts an account as new only within the window after creation', async () => {
  const f = await fixture();
  const now = Date.UTC(2026, 10, 16, 12);
  assert.equal(f.checkout.isRecentlyCreated(new Date(now - 60_000), now), true);
  assert.equal(f.checkout.isRecentlyCreated(now - 60_000, now), true);
  assert.equal(f.checkout.isRecentlyCreated(new Date(now - 86_400_000), now), false);
  assert.equal(f.checkout.isRecentlyCreated(new Date(now - f.checkout.NEW_ACCOUNT_WINDOW_MS), now), false);
  assert.equal(f.checkout.isRecentlyCreated(undefined, now), false);
  assert.equal(f.checkout.isRecentlyCreated(null, now), false);
  assert.equal(f.checkout.isRecentlyCreated(new Date('invalid'), now), false);
});
