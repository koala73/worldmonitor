import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { PUBLIC_PRODUCT_FACTS } from './_product-catalog.generated.js';
import { PUBLIC_INVENTORY_FACTS } from './_inventory-facts.generated.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function importHandler({ relaySecret, upstash = false }) {
  if (upstash) {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  delete process.env.DODO_API_KEY;
  if (relaySecret == null) {
    delete process.env.RELAY_SHARED_SECRET;
  } else {
    process.env.RELAY_SHARED_SECRET = relaySecret;
  }
  const mod = await import(`./product-catalog.js?test=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function getRequest() {
  return new Request('https://api.worldmonitor.app/api/product-catalog', {
    method: 'GET',
  });
}

function deleteRequest(authHeader) {
  const headers = new Headers();
  if (authHeader != null) headers.set('Authorization', authHeader);
  return new Request('https://api.worldmonitor.app/api/product-catalog', {
    method: 'DELETE',
    headers,
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv();
});

test('DELETE purge accepts only the exact relay bearer secret', async () => {
  const handler = await importHandler({ relaySecret: 'relay-secret-with-distinct-length' });

  const accepted = await handler(deleteRequest('Bearer relay-secret-with-distinct-length'));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { purged: true });

  const prefixOnly = await handler(deleteRequest('Bearer relay-secret-with-distinct'));
  assert.equal(prefixOnly.status, 401);

  const longerMismatch = await handler(deleteRequest('Bearer relay-secret-with-distinct-length-extra'));
  assert.equal(longerMismatch.status, 401);
});

test('DELETE purge fails closed when RELAY_SHARED_SECRET is missing', async () => {
  const handler = await importHandler({ relaySecret: null });

  const missingSecret = await handler(deleteRequest('Bearer '));
  assert.equal(missingSecret.status, 401);

  const noAuth = await handler(deleteRequest(null));
  assert.equal(noAuth.status, 401);
});

test('GET fallback publishes generated lifecycle, pricing, and capability facts', async () => {
  const handler = await importHandler({ relaySecret: null });

  const response = await handler(getRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-product-catalog-source'), 'fallback');

  const body = await response.json();
  assert.equal(body.product.lifecycle, 'launched');
  assert.equal(body.product.pricingUrl, 'https://www.worldmonitor.app/pro#pricing');
  assert.equal(body.currency, 'USD');
  assert.equal(body.capabilities.mcpTools, PUBLIC_INVENTORY_FACTS.capabilities.mcpTools);
  assert.equal(body._generated, PUBLIC_PRODUCT_FACTS._generated);
  const proMonthly = PUBLIC_PRODUCT_FACTS.plans.find((plan) => plan.planKey === 'pro_monthly');
  const proAnnual = PUBLIC_PRODUCT_FACTS.plans.find((plan) => plan.planKey === 'pro_annual');
  assert.ok(body.plans.some((plan) => (
    plan.planKey === 'pro_monthly'
    && plan.price === proMonthly.price
    && plan.billingDuration === 'P1M'
  )));
  assert.ok(body.tiers.some((tier) => (
    tier.name === 'Pro'
    && tier.monthlyPrice === proMonthly.price
    && tier.annualPrice === proAnnual.price
  )));
});

test('GET cache cannot override generated public lifecycle and capability facts', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: JSON.stringify({
      product: { lifecycle: 'waitlist', pricingUrl: '/stale' },
      currency: 'EUR',
      plans: [],
      capabilities: { mcpTools: 1 },
      tiers: [{ name: 'Cached tier' }],
      fetchedAt: 123,
    }),
  }));
  const handler = await importHandler({ relaySecret: null, upstash: true });

  const response = await handler(getRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-product-catalog-source'), 'cache');

  const body = await response.json();
  assert.equal(body.product.lifecycle, PUBLIC_PRODUCT_FACTS.product.lifecycle);
  assert.equal(body.product.pricingUrl, PUBLIC_PRODUCT_FACTS.product.pricingUrl);
  assert.equal(body.currency, PUBLIC_PRODUCT_FACTS.currency);
  assert.deepEqual(body.plans, PUBLIC_PRODUCT_FACTS.plans);
  assert.equal(body.capabilities.mcpTools, PUBLIC_INVENTORY_FACTS.capabilities.mcpTools);
  assert.equal(body._generated, PUBLIC_PRODUCT_FACTS._generated);
  assert.deepEqual(body.tiers, [{ name: 'Cached tier' }]);
});
