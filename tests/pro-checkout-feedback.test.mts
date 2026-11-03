import assert from 'node:assert/strict';
import { afterEach, before, it, mock } from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

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
  await browser?.happyDOM.abort();
  mock.restoreAll();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

async function fixture(options: {
  clerkError?: boolean; signInError?: boolean; signedOut?: boolean; missingToken?: boolean;
  response?: () => Promise<Response>;
} = {}) {
  mock.method(console, 'error', () => {});
  browser = new Window({ url: 'https://www.worldmonitor.app/pro#pricing' });
  const navigations: string[] = [];
  const signIns: unknown[] = [];
  const pageListeners = new Map<string, Set<(event: { persisted: boolean }) => void>>();
  let requests = 0;
  const globals: Record<string, unknown> = {
    document: browser.document,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    window: {
      addEventListener: (type: string, fn: (event: { persisted: boolean }) => void) => {
        if (!pageListeners.has(type)) pageListeners.set(type, new Set());
        pageListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (event: { persisted: boolean }) => void) => {
        pageListeners.get(type)?.delete(fn);
      },
      location: { href: browser.location.href, assign: (url: string) => navigations.push(url) },
      sessionStorage: browser.sessionStorage,
      umami: { track() {} },
      setTimeout: browser.setTimeout.bind(browser), clearTimeout: browser.clearTimeout.bind(browser),
      setInterval: browser.setInterval.bind(browser), clearInterval: browser.clearInterval.bind(browser),
    },
    fetch: async () => {
      requests++;
      return options.response?.() ?? Response.json({ checkout_url: 'https://checkout.dodopayments.com/test' });
    },
    __checkoutFixture: { clerk: async () => {
      if (options.clerkError) throw new Error('Synthetic auth failure');
      return {
        user: options.signedOut ? null : { id: 'user_test' },
        session: { getToken: async () => options.missingToken ? null : 'synthetic-token' },
        openSignIn: (intent: unknown) => {
          if (options.signInError) throw new Error('Synthetic modal failure');
          signIns.push(intent);
        },
      };
    } },
  };
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const checkout = await import(`${moduleUrl}#${Math.random()}`);
  const phases: Array<{ kind: string; productId?: string }> = [];
  checkout.subscribeCheckoutPhase((phase: { kind: string }) => phases.push(phase));
  const firePageShow = (persisted: boolean) => {
    for (const fn of [...(pageListeners.get('pageshow') ?? [])]) fn({ persisted });
  };
  return { checkout, phases, navigations, signIns, requests: () => requests, options, firePageShow };
}

for (const [name, options] of [
  ['auth loading fails', { clerkError: true }],
  ['sign-in modal fails', { signedOut: true, signInError: true }],
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

it('shows loading before auth resolves and leaves dismissed sign-in retryable', async () => {
  const f = await fixture({ signedOut: true });
  const attempt = f.checkout.startCheckout('synthetic-product');
  assert.equal(f.phases.at(-1)?.kind, 'loading_auth');
  assert.equal(await attempt, false);
  assert.equal(f.signIns.length, 1);
  assert.equal(f.requests(), 0);
  assert.equal(f.phases.at(-1)?.kind, 'idle');
  assert.equal(document.querySelector('[role="alert"]'), null);
  await f.checkout.startCheckout('synthetic-product');
  assert.equal(f.signIns.length, 2);
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
