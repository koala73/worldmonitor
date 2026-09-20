import assert from 'node:assert/strict';
import { after, it } from 'node:test';

process.env.CONVEX_SITE_URL = 'https://checkout.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET = 'synthetic-tenant-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://checkout-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';

const { default: handler, __setCreateCheckoutDepsForTests } = await import('../api/create-checkout.ts');
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  __setCreateCheckoutDepsForTests(null);
});

it('limits checkout sessions per authenticated user before the relay', async () => {
  const buckets = new Map<string, number>();
  const stored = new Map<string, string>();
  let relayCalls = 0;
  let userId = 'user_checkout';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, 'https://checkout-redis.test');
    const commands = JSON.parse(String(init?.body)) as unknown[][];
    return Response.json(commands.map((command) => {
      const operation = String(command[0]).toUpperCase();
      const storageKey = String(command[1]);
      if (operation === 'GET') return { result: stored.get(storageKey) ?? null };
      if (operation === 'SET') {
        if (command.includes('NX') && stored.has(storageKey)) return { result: null };
        stored.set(storageKey, String(command[2]));
        return { result: 'OK' };
      }
      if (operation === 'DEL') {
        stored.delete(storageKey);
        return { result: 1 };
      }
      const key = String(command[3] ?? storageKey).replace(/:\d+$/, '');
      const count = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, count);
      return { result: [5 - count, 5] };
    }));
  };
  __setCreateCheckoutDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId, email: 'buyer@example.com', name: 'Buyer' }),
    fetch: async () => {
      relayCalls += 1;
      return Response.json({ url: 'https://billing.test/checkout' });
    },
  });

  const requestFor = (ip: string, idempotencyKey?: string) => new Request('https://worldmonitor.app/api/create-checkout', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
      'x-real-ip': ip,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      productId: 'pdt_pro_monthly',
      returnUrl: 'https://worldmonitor.app/?wm_checkout=return',
    }),
  });

  for (let i = 0; i < 6; i++) {
    const res = await handler(requestFor(`192.0.2.${i + 1}`, i === 0 ? 'completed-checkout' : undefined));
    assert.equal(res.status, i < 5 ? 200 : 429, `request ${i} status`);
    if (i >= 5) assert.ok(res.headers.get('Retry-After'));
  }
  assert.equal(relayCalls, 5, 'the sixth call must not reach Dodo');

  const replay = await handler(requestFor('192.0.2.20', 'completed-checkout'));
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotent-Replayed'), 'true');
  assert.deepEqual(await replay.json(), { url: 'https://billing.test/checkout' });
  assert.equal(relayCalls, 5, 'a completed replay must not spend another relay call or limiter slot');

  userId = 'user_checkout_other';
  const other = await handler(requestFor('192.0.2.1'));
  assert.equal(other.status, 200);
  assert.equal(relayCalls, 6, 'a different user keeps their own budget');

  const healthyFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (/eval/i.test(String(init?.body))) throw new Error('Redis unavailable');
    return healthyFetch(input, init);
  };
  userId = 'user_checkout_outage';
  const unavailable = await handler(requestFor('192.0.2.30'));
  userId = 'user_checkout';
  const replayDuringOutage = await handler(requestFor('192.0.2.31', 'completed-checkout'));
  assert.equal(replayDuringOutage.status, 200);
  assert.equal(replayDuringOutage.headers.get('Idempotent-Replayed'), 'true');
  assert.equal(relayCalls, 6);
  assert.equal(unavailable.status, 503);
});
