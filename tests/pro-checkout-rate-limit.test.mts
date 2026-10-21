import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';

import {
  checkoutRetryAtMs,
  checkoutRetryRemainingSeconds,
  parseCheckoutRetryAfterSeconds,
} from '../pro-test/src/services/checkout-rate-limit.ts';

interface ProRateLimitHarness {
  fetchCalls: number;
  phases: Array<{ kind: string; retryAtMs?: number }>;
  reports: Array<{ message: string; payload: Record<string, unknown> }>;
  toastMessages: string[];
}

declare global {
  // eslint-disable-next-line no-var
  var __proRateLimitHarness: ProRateLimitHarness;
}

class FakeElement {
  id = '';
  textContent = '';
  innerHTML = '';
  readonly style: Record<string, string> = {};

  constructor(private readonly elements: Map<string, FakeElement>) {}

  setAttribute(): void {}

  remove(): void {
    if (this.id) this.elements.delete(this.id);
  }
}

function installBrowserHarness(): void {
  const elements = new Map<string, FakeElement>();
  const storage = new Map<string, string>();
  const windowValue = {
    umami: { track: () => {} },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: {
      href: 'https://www.worldmonitor.app/pro',
      pathname: '/pro',
      search: '',
      hash: '',
      assign: () => {},
    },
    history: { replaceState: () => {} },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    open: () => null,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowValue,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new FakeElement(elements),
      body: {
        appendChild: (element: FakeElement) => {
          if (element.id) elements.set(element.id, element);
          if (element.id === 'wm-checkout-rate-limit-toast') {
            globalThis.__proRateLimitHarness.toastMessages.push(element.textContent);
          }
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: () => void) => callback(),
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      globalThis.__proRateLimitHarness.fetchCalls += 1;
      return Response.json(
        {
          error: 'CHECKOUT_RATE_LIMITED',
          message: 'Checkout is temporarily rate limited. Retry shortly.',
        },
        {
          status: 429,
          headers: { 'Retry-After': '10' },
        },
      );
    },
  });
}

// No `dodopayments-checkout` or `./entitlement-watchdog` stub: #7222 removed
// both imports from pro-test/src/services/checkout.ts, so these were dead
// fixtures. Removing them is cleanup only, NOT a regression guard — the
// dashboard still declares the SDK in the root package.json, so a re-added
// import in /pro resolves against the repo-root node_modules and this suite
// stays green either way (verified by mutation). The guard that actually
// catches that is the source sweep in tests/pro-bundle-no-dodo-sdk.test.mts.
const stubSources: Record<string, string> = {
  '@sentry/react': `
    export const addBreadcrumb = () => {};
    export const captureException = () => {};
    export const captureMessage = (message, payload) => {
      globalThis.__proRateLimitHarness.reports.push({ message, payload });
    };
  `,
  './clerk': `
    export async function ensureClerk() {
      return {
        user: { id: 'user_rate_limited' },
        session: { getToken: async () => 'tok_test' },
        openSignIn: () => {},
      };
    }
  `,
};

const harnessPlugin: Plugin = {
  name: 'pro-rate-limit-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) =>
      Object.hasOwn(stubSources, args.path)
        ? { path: args.path, namespace: 'pro-rate-limit-stub' }
        : null,
    );
    buildApi.onLoad(
      { filter: /.*/, namespace: 'pro-rate-limit-stub' },
      (args) => ({ contents: stubSources[args.path], loader: 'js' }),
    );
  },
};

async function loadProCheckoutModule(): Promise<{
  startCheckout: (productId: string) => Promise<boolean>;
  subscribeCheckoutPhase: (
    callback: (phase: { kind: string; retryAtMs?: number }) => void,
  ) => () => void;
}> {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `
        export {
          startCheckout,
          subscribeCheckoutPhase,
        } from './pro-test/src/services/checkout.ts';
      `,
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
  const dataUrl =
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

function resetHarness(): void {
  globalThis.__proRateLimitHarness = {
    fetchCalls: 0,
    phases: [],
    reports: [],
    toastMessages: [],
  };
  installBrowserHarness();
}

describe('/pro checkout rate-limit policy', () => {
  it('parses and bounds the numeric edge contract', () => {
    assert.equal(parseCheckoutRetryAfterSeconds('15'), 15);
    assert.equal(parseCheckoutRetryAfterSeconds('9999'), 9999);
    assert.equal(parseCheckoutRetryAfterSeconds('10000'), 10);
    assert.equal(parseCheckoutRetryAfterSeconds('later'), 10);
    assert.equal(checkoutRetryAtMs(1_000, 15), 16_000);
    assert.equal(checkoutRetryRemainingSeconds(1_001, 16_000), 15);
    assert.equal(checkoutRetryRemainingSeconds(16_000, 16_000), 0);
  });

  it('shows the cooldown, disables checkout phase, and blocks a repeated request', async () => {
    resetHarness();
    const checkout = await loadProCheckoutModule();
    checkout.subscribeCheckoutPhase((phase) => {
      globalThis.__proRateLimitHarness.phases.push(phase);
    });

    assert.equal(await checkout.startCheckout('prod_rate_limited'), false);
    assert.equal(globalThis.__proRateLimitHarness.fetchCalls, 1);
    assert.equal(globalThis.__proRateLimitHarness.phases.at(-1)?.kind, 'rate_limited');
    assert.match(globalThis.__proRateLimitHarness.toastMessages.at(-1) ?? '', /10 seconds/i);
    assert.deepEqual(globalThis.__proRateLimitHarness.reports.at(-1), {
      message: 'Checkout temporarily rate limited',
      payload: {
        level: 'info',
        tags: { surface: 'pro-marketing', code: 'rate_limited' },
        extra: { retryAfterSeconds: 10 },
      },
    });

    assert.equal(await checkout.startCheckout('prod_rate_limited'), false);
    assert.equal(globalThis.__proRateLimitHarness.fetchCalls, 1);
    assert.match(globalThis.__proRateLimitHarness.toastMessages.at(-1) ?? '', /10 seconds/i);
  });
});
