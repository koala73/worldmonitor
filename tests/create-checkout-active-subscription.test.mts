import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function importFreshCreateCheckout() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';
  return import(`../api/create-checkout.ts?test=${Date.now()}-${Math.random()}`);
}

function makeCheckoutRequest(): Request {
  return new Request('https://worldmonitor.app/api/create-checkout', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      productId: 'pdt_pro_monthly',
      returnUrl: 'https://worldmonitor.app/?wm_checkout=return',
    }),
  });
}

afterEach(() => {
  mock.restoreAll();
  restoreEnv();
});

describe('/api/create-checkout ACTIVE_SUBSCRIPTION_EXISTS relay handling', () => {
  it('forwards the typed duplicate-subscription response without logging a production error', async () => {
    const mod = await importFreshCreateCheckout();
    const consoleError = mock.method(console, 'error', () => {});
    const relayFetch = mock.fn(async () =>
      Response.json(
        {
          error: 'ACTIVE_SUBSCRIPTION_EXISTS',
          message: 'Active Pro Monthly subscription already exists',
          subscription: { planKey: 'pro_monthly' },
        },
        { status: 409 },
      ),
    );

    mod.__setCreateCheckoutDepsForTests({
      validateBearerToken: async () => ({
        valid: true,
        userId: 'user_existing_pro',
        email: 'pro@example.com',
        name: 'Existing Pro',
      }),
      fetch: relayFetch,
    });

    const res = await mod.default(makeCheckoutRequest());

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: 'ACTIVE_SUBSCRIPTION_EXISTS',
      message: 'Active Pro Monthly subscription already exists',
      subscription: { planKey: 'pro_monthly' },
    });
    assert.equal(consoleError.mock.calls.length, 0);
    assert.equal(relayFetch.mock.calls.length, 1);
    const relayInit = relayFetch.mock.calls[0].arguments[1] as RequestInit;
    assert.equal((relayInit.headers as Record<string, string>)['User-Agent'], 'worldmonitor-checkout-edge/1.0');
  });

  it('continues logging and forwarding non-active 409 checkout blocks', async () => {
    const mod = await importFreshCreateCheckout();
    const consoleError = mock.method(console, 'error', () => {});
    const relayFetch = mock.fn(async () =>
      Response.json(
        {
          error: 'PAYMENT_IN_PROGRESS',
          message: 'A Pro Monthly payment is already in progress',
          pendingPayment: { planKey: 'pro_monthly' },
        },
        { status: 409 },
      ),
    );

    mod.__setCreateCheckoutDepsForTests({
      validateBearerToken: async () => ({
        valid: true,
        userId: 'user_pending_payment',
      }),
      fetch: relayFetch,
    });

    const res = await mod.default(makeCheckoutRequest());

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: 'PAYMENT_IN_PROGRESS',
      message: 'A Pro Monthly payment is already in progress',
      pendingPayment: { planKey: 'pro_monthly' },
    });
    assert.equal(consoleError.mock.calls.length, 1);
    assert.equal(String(consoleError.mock.calls[0].arguments[0]), '[create-checkout] Relay error:');
  });

  it('continues logging non-409 relay failures before returning the fallback envelope', async () => {
    const mod = await importFreshCreateCheckout();
    const consoleError = mock.method(console, 'error', () => {});
    const relayFetch = mock.fn(async () =>
      Response.json(
        {
          error: 'UPSTREAM_CHECKOUT_FAILURE',
          message: 'Dodo checkout temporarily failed',
        },
        { status: 500 },
      ),
    );

    mod.__setCreateCheckoutDepsForTests({
      validateBearerToken: async () => ({
        valid: true,
        userId: 'user_retryable_failure',
      }),
      fetch: relayFetch,
    });

    const res = await mod.default(makeCheckoutRequest());

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: 'UPSTREAM_CHECKOUT_FAILURE',
    });
    assert.equal(consoleError.mock.calls.length, 1);
    assert.equal(String(consoleError.mock.calls[0].arguments[0]), '[create-checkout] Relay error:');
    assert.equal(consoleError.mock.calls[0].arguments[1], 500);
    assert.deepEqual(consoleError.mock.calls[0].arguments[2], {
      error: 'UPSTREAM_CHECKOUT_FAILURE',
      message: 'Dodo checkout temporarily failed',
    });
  });
});
