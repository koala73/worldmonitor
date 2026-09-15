import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.CLERK_JWT_ISSUER_DOMAIN = 'https://clerk.portal.test';
process.env.CONVEX_SITE_URL = 'https://portal.convex.site';
process.env.RELAY_SHARED_SECRET = 'synthetic-ingestion-secret';
process.env.CONVEX_TENANT_RELAY_SECRET = 'synthetic-tenant-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://portal-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';
const { default: handler } = await import('../api/customer-portal.ts');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

it('limits portal sessions per authenticated user before the relay, across tokens and IPs', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'portal-test', alg: 'RS256' };
  let relayCalls = 0;
  const buckets = new Map<string, number>();
  const stored = new Map<string, string>();
  let replayToken = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).origin === 'https://clerk.portal.test') return Response.json({ keys: [jwk] });
    if (new URL(url).origin === 'https://portal-redis.test') {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map((command: unknown[]) => {
        const operation = String(command[0]).toUpperCase();
        const storageKey = String(command[1]);
        if (operation === 'GET') return { result: stored.get(storageKey) ?? null };
        if (operation === 'SET') {
          if (command.includes('NX') && stored.has(storageKey)) return { result: null };
          stored.set(storageKey, String(command[2]));
          return { result: 'OK' };
        }
        const key = String(command[3]);
        const count = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, count);
        return { result: [5 - count, 5] };
      }));
    }
    assert.equal(url, 'https://portal.convex.site/relay/customer-portal');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-tenant-relay-secret');
    relayCalls++;
    return Response.json({ url: 'https://billing.test/session' });
  };
  for (let i = 0; i < 7; i++) {
    const token = await new SignJWT({ sub: 'user_portal', plan: 'pro', jti: String(i) })
      .setProtectedHeader({ alg: 'RS256', kid: 'portal-test' })
      .setIssuer('https://clerk.portal.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    replayToken = token;
    const res = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-real-ip': `192.0.2.${i + 1}`, ...(i === 0 ? { 'Idempotency-Key': 'completed-portal' } : {}) },
    }));
    assert.equal(res.status, i < 5 ? 200 : 429);
    if (i >= 5) assert.ok(res.headers.get('Retry-After'));
  }
  assert.equal(relayCalls, 5);
  const replayRequest = () => new Request('https://worldmonitor.app/api/customer-portal', {
    method: 'POST', headers: { Authorization: `Bearer ${replayToken}`, 'Idempotency-Key': 'completed-portal' },
  });
  const replay = await handler(replayRequest());
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotent-Replayed'), 'true');
  assert.deepEqual(await replay.json(), { url: 'https://billing.test/session' });
  assert.equal(relayCalls, 5);
  const missedReplay = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
    method: 'POST', headers: { Authorization: `Bearer ${replayToken}`, 'Idempotency-Key': 'new-portal' },
  }));
  assert.equal(missedReplay.status, 429);
  assert.equal(stored.size, 1, 'rejected misses must not create idempotency reservations');
  const healthyFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).origin === 'https://portal-redis.test' && /eval/i.test(String(init?.body))) throw new Error('Redis unavailable');
    return healthyFetch(input, init);
  };
  const token = await new SignJWT({ sub: 'other_user', plan: 'pro' })
    .setProtectedHeader({ alg: 'RS256', kid: 'portal-test' })
    .setIssuer('https://clerk.portal.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const unavailable = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }));
  const replayDuringLimiterOutage = await handler(replayRequest());
  assert.equal(replayDuringLimiterOutage.status, 200);
  assert.equal(replayDuringLimiterOutage.headers.get('Idempotent-Replayed'), 'true');
  // The limiter caches its configured client; an unavailable Redis still fails closed.
  assert.equal(relayCalls, 5);
  assert.ok([429, 503].includes(unavailable.status));
});
