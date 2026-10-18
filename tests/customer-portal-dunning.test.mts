import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.CLERK_JWT_ISSUER_DOMAIN = 'https://clerk.portal.test';
process.env.CONVEX_SITE_URL = 'https://portal.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET = 'synthetic-tenant-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://portal-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';

const { default: handler } = await import('../api/customer-portal.ts');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function mockInfra(relay: (body: unknown) => Response) {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).origin === 'https://portal-redis.test') {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map(() => ({ result: [9, 10] })));
    }
    assert.equal(url, 'https://portal.convex.site/relay/customer-portal');
    return relay(JSON.parse(String(init?.body)));
  };
}

it('GET with a portal token 302s to the minted Dodo URL', async () => {
  let relayBody: unknown;
  mockInfra((body) => {
    relayBody = body;
    return Response.json({ portal_url: 'https://customer.dodopayments.com/session/abc' });
  });
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig&next=https://evil.example'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://customer.dodopayments.com/session/abc');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.deepEqual(relayBody, { portalToken: 'v1.user_x.1.sig' });
});

it('GET with an invalid portal token sends the user to sign-in, not a query redirect', async () => {
  mockInfra(() => Response.json({ error: 'INVALID_PORTAL_TOKEN' }, { status: 401 }));
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=forged&redirect=https://evil.example'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard?billing=portal');
});

it('GET without a token or session requires sign-in and does not call the relay', async () => {
  let relayCalls = 0;
  mockInfra(() => {
    relayCalls += 1;
    return Response.json({ portal_url: 'https://customer.dodopayments.com/x' });
  });
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?next=https://evil.example'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard?billing=portal');
  assert.equal(relayCalls, 0);
});

it('GET refuses to redirect to a non-Dodo portal_url and falls back to the dashboard', async () => {
  mockInfra(() => Response.json({ portal_url: 'https://evil.example/phish' }));
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard?billing=portal');
});

for (const [label, status, body, loggedReason] of [
  ['relay 404 NO_CUSTOMER', 404, { error: 'NO_CUSTOMER' }, null],
  ['relay 500', 500, { error: 'boom' }, 'relay_500'],
  ['relay-secret 401 UNAUTHORIZED', 401, { error: 'UNAUTHORIZED' }, 'relay_401'],
  ['invalid portal token', 401, { error: 'INVALID_PORTAL_TOKEN' }, null],
] as const) {
  it(`GET email click on ${label} lands on the dashboard${loggedReason ? ` and logs ${loggedReason}` : ''}`, async () => {
    mockInfra(() => Response.json(body, { status }));
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig'));
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard?billing=portal');
    } finally {
      console.error = originalError;
    }
    const mintFailures = errors.filter((args) => args[0] === '[customer-portal] GET mint failed:');
    assert.deepEqual(mintFailures.map((args) => args[1]), loggedReason ? [loggedReason] : []);
  });
}

it('GET email click when the relay fetch throws lands on the dashboard', async () => {
  mockInfra(() => { throw new TypeError('network down'); });
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard?billing=portal');
});

async function signedBearer(sub: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: `portal-get-${sub}`, alg: 'RS256' };
  const token = await new SignJWT({ sub, plan: 'pro' })
    .setProtectedHeader({ alg: 'RS256', kid: `portal-get-${sub}` })
    .setIssuer('https://clerk.portal.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return { jwk, token };
}

it('GET with a valid Clerk bearer mints a session for that user', async () => {
  const { jwk, token } = await signedBearer('user_bearer_get');
  let relayBody: unknown;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const origin = new URL(url).origin;
    if (origin === 'https://clerk.portal.test') return Response.json({ keys: [jwk] });
    if (origin === 'https://portal-redis.test') {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map(() => ({ result: [9, 10] })));
    }
    relayBody = JSON.parse(String(init?.body));
    return Response.json({ portal_url: 'https://customer.dodopayments.com/session/bearer' });
  };
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
    headers: { Authorization: `Bearer ${token}` },
  }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://customer.dodopayments.com/session/bearer');
  assert.deepEqual(relayBody, { userId: 'user_bearer_get' });
});

it('GET with an invalid Clerk bearer goes to sign-in without calling the relay', async () => {
  let relayCalls = 0;
  mockInfra(() => {
    relayCalls += 1;
    return Response.json({ portal_url: 'https://customer.dodopayments.com/x' });
  });
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
    headers: { Authorization: 'Bearer not-a-jwt' },
  }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard?billing=portal');
  assert.equal(relayCalls, 0);
});

it('GET caps one token replayed from many IPs, then lands on sign-in without the relay', async () => {
  const buckets = new Map<string, number>();
  let relayCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).origin === 'https://portal-redis.test') {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map((command: unknown[]) => {
        const key = String(command[3]).replace(/:\d+$/, '');
        const limit = Number(command[4] ?? 0) || (key.includes('portal-token:') ? 5 : 10);
        const count = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, count);
        return { result: [limit - count, limit] };
      }));
    }
    relayCalls += 1;
    return Response.json({ portal_url: 'https://customer.dodopayments.com/session/replay' });
  };
  const locations: (string | null)[] = [];
  for (let i = 0; i < 7; i++) {
    // A token of its own: the limiter caches blocked identifiers in memory,
    // so reusing the shared fixture token would block later tests.
    const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_replay.1.sig', {
      headers: { 'x-real-ip': `198.51.100.${i + 1}` },
    }));
    assert.equal(res.status, 302);
    locations.push(res.headers.get('Location'));
  }
  assert.equal(relayCalls, 5);
  assert.deepEqual(locations.slice(5), [
    'https://www.worldmonitor.app/dashboard?billing=portal',
    'https://www.worldmonitor.app/dashboard?billing=portal',
  ]);
});

it('GET relay call carries a User-Agent', async () => {
  let ua: string | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).origin === 'https://portal-redis.test') {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map(() => ({ result: [9, 10] })));
    }
    ua = new Headers(init?.headers).get('User-Agent');
    return Response.json({ portal_url: 'https://customer.dodopayments.com/session/abc' });
  };
  await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig'));
  assert.match(String(ua), /^worldmonitor-customer-portal-edge\//);
});
