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
  process.env.CONVEX_TENANT_RELAY_SECRET = 'relay-secret';
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
      checkRateLimit: async () => null,
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
    assert.equal((relayInit.headers as Record<string, string>).Authorization, 'Bearer relay-secret');
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
      checkRateLimit: async () => null,
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

  it('preserves a reached relay provider-timeout 500 as non-retryable edge 500', async () => {
    const mod = await importFreshCreateCheckout();
    const consoleError = mock.method(console, 'error', () => {});
    const relayFetch = mock.fn(async () =>
      Response.json(
        {
          error: 'CHECKOUT_TIMED_OUT',
          message: 'Dodo checkout request exceeded its provider timeout',
        },
        { status: 500 },
      ),
    );

    mod.__setCreateCheckoutDepsForTests({
      validateBearerToken: async () => ({
        valid: true,
        userId: 'user_retryable_failure',
      }),
      checkRateLimit: async () => null,
      fetch: relayFetch,
    });

    const res = await mod.default(makeCheckoutRequest());

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      error: 'CHECKOUT_TIMED_OUT',
    });
    assert.equal(consoleError.mock.calls.length, 1);
    assert.equal(String(consoleError.mock.calls[0].arguments[0]), '[create-checkout] Relay error:');
    assert.equal(consoleError.mock.calls[0].arguments[1], 500);
    assert.deepEqual(consoleError.mock.calls[0].arguments[2], {
      error: 'CHECKOUT_TIMED_OUT',
      message: 'Dodo checkout request exceeded its provider timeout',
    });
    assert.equal(relayFetch.mock.calls.length, 1, 'one logical relay create call');
  });

  it('keeps a true edge-to-relay fetch failure on the retryable 502 channel', async () => {
    const mod = await importFreshCreateCheckout();
    const consoleError = mock.method(console, 'error', () => {});
    const relayFetch = mock.fn(async () => {
      throw new TypeError('Failed to fetch relay');
    });

    mod.__setCreateCheckoutDepsForTests({
      validateBearerToken: async () => ({
        valid: true,
        userId: 'user_relay_network_failure',
      }),
      checkRateLimit: async () => null,
      fetch: relayFetch,
    });

    const res = await mod.default(makeCheckoutRequest());

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: 'Checkout service unavailable',
    });
    assert.equal(relayFetch.mock.calls.length, 1);
    assert.equal(consoleError.mock.calls.length, 1);
    assert.equal(String(consoleError.mock.calls[0].arguments[0]), '[create-checkout] Relay failed:');
  });

  it('preserves relay 429 and Retry-After without logging it as an unexpected failure', async () => {
    const mod = await importFreshCreateCheckout();
    const consoleError = mock.method(console, 'error', () => {});
    const relayFetch = mock.fn(async () =>
      Response.json(
        {
          error: 'CHECKOUT_RATE_LIMITED',
          message: 'Checkout is temporarily rate limited. Retry shortly.',
        },
        {
          status: 429,
          headers: { 'Retry-After': '10' },
        },
      ),
    );

    mod.__setCreateCheckoutDepsForTests({
      validateBearerToken: async () => ({
        valid: true,
        userId: 'user_rate_limited',
      }),
      checkRateLimit: async () => null,
      fetch: relayFetch,
    });

    const res = await mod.default(makeCheckoutRequest());

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '10');
    assert.deepEqual(await res.json(), {
      error: 'CHECKOUT_RATE_LIMITED',
      message: 'Checkout is temporarily rate limited. Retry shortly.',
    });
    assert.equal(consoleError.mock.calls.length, 0);
  });
});

it('forwards invalid checkout product as HTTP 400 without a transport retry signal', async () => {
  const mod = await importFreshCreateCheckout();
  const relayFetch = mock.fn(async () => Response.json({ error: 'INVALID_CHECKOUT_PRODUCT' }, { status: 400 }));
  mod.__setCreateCheckoutDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: 'user_product_admission' }),
    checkRateLimit: async () => null,
    fetch: relayFetch,
  });
  const response = await mod.default(makeCheckoutRequest());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_CHECKOUT_PRODUCT' });
  assert.equal(relayFetch.mock.calls.length, 1);
});

it('replays a completed account-scoped checkout without reaching admission at the relay', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
  const mod = await importFreshCreateCheckout();
  const req = makeCheckoutRequest();
  req.headers.set('Idempotency-Key', 'completed-checkout');
  const body = await req.clone().text();
  const sha = async (value: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
  const reqHash = await sha(body);
  const expectedKey = `idem:v1:${await sha('user:user_existing_pro\n/api/create-checkout\ncompleted-checkout')}`;
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://upstash.test/pipeline');
    const commands = JSON.parse(String(init?.body));
    assert.ok(commands.every((command: string[]) => command[1] === expectedKey));
    return Response.json([
      { result: null },
      { result: JSON.stringify({ state: 'completed', status: 200, contentType: 'application/json', reqHash, body: JSON.stringify({ checkout_url: 'https://checkout.example/original' }) }) },
    ]);
  });
  const relay = mock.fn(async () => { throw new Error('Replay must not invoke relay admission'); });
  mod.__setCreateCheckoutDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: 'user_existing_pro' }),
    fetch: relay,
  });
  const response = await mod.default(req);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { checkout_url: 'https://checkout.example/original' });
  assert.equal(relay.mock.callCount(), 0);
});
