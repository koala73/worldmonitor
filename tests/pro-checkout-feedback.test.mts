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
  let requests = 0;
  const globals: Record<string, unknown> = {
    document: browser.document,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    window: {
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
  return { checkout, phases, navigations, signIns, requests: () => requests, options };
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
  assert.equal(await f.checkout.startCheckout('synthetic-product'), true);
  assert.deepEqual(f.navigations, ['https://checkout.dodopayments.com/test']);
  assert.equal(document.querySelector('[role="alert"]'), null);
});
