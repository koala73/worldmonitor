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

async function relayedBody(acquisition: unknown): Promise<Record<string, unknown>> {
  const mod = await importFreshCreateCheckout();
  const relayFetch = mock.fn(async () => Response.json({ checkout_url: 'https://checkout.example/s' }));
  mod.__setCreateCheckoutDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: 'user_acq' }),
    checkRateLimit: async () => null,
    fetch: relayFetch,
  });
  await mod.default(new Request('https://worldmonitor.app/api/create-checkout', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ productId: 'pdt_pro_monthly', acquisition }),
  }));
  assert.equal(relayFetch.mock.calls.length, 1);
  const init = relayFetch.mock.calls[0].arguments[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  mock.restoreAll();
  restoreEnv();
});

describe('/api/create-checkout acquisition relay', () => {
  it('forwards a normalized first-touch source to Convex', async () => {
    const body = await relayedBody({ source: 'Twitter', referrer: 'www.t.co', landing: 'pricing', firstSeen: '2026-10-24' });
    assert.deepEqual(body.acquisition, { source: 'twitter', referrer: 't.co', landing: 'pricing', firstSeen: '2026-10-24' });
  });

  it('strips unknown keys so the Convex argument validator cannot reject the checkout', async () => {
    const body = await relayedBody({ medium: 'cpc', email: 'someone@example.com', nested: { a: 1 } });
    assert.deepEqual(body.acquisition, { medium: 'cpc' });
  });

  it('omits the field when the value is missing or unusable', async () => {
    assert.equal((await relayedBody(undefined)).acquisition, undefined);
    assert.equal((await relayedBody('direct')).acquisition, undefined);
    assert.equal((await relayedBody({ referrer: 'bad host' })).acquisition, undefined);
  });
});
