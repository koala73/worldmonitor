import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const ISSUER = 'https://clerk.test.invalid';
process.env.CLERK_JWT_ISSUER_DOMAIN = ISSUER;
process.env.CLERK_SECRET_KEY = 'sk_test_stub';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET = 'gateway-secret';
const { resolveVerifiedClerkSession } = await import('../server/_shared/auth-session.ts');
const { lookupClerkPlan, verifyClerkSessionActive } = await import('../server/auth-session.ts');
const { default: route, userEmbedKeyCreateHandler, userEmbedKeyCreateRateLimitPolicy } = await import('../api/user-embed-keys.ts');

let privateKey: CryptoKey;
let verifiedUser: string;
let userNumber = 0;
let planStatus: number;
let publicMetadata: Record<string, unknown>;
let jwk: Record<string, unknown>;
let session: unknown;
let clerkStatus: number;
let relayStatus: number;
let relayThrows: boolean;
let relayBody: Record<string, unknown>;
const calls: string[] = [];
const originalFetch = globalThis.fetch;
before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'k1', alg: 'RS256', use: 'sig' };
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url.startsWith('https://api.clerk.com/v1/sessions/')) return Response.json(session, { status: clerkStatus });
    if (url.startsWith('https://api.clerk.com/v1/users/')) {
      assert.equal(url, `https://api.clerk.com/v1/users/${verifiedUser}`);
      return Response.json({ public_metadata: publicMetadata }, { status: planStatus });
    }
    if (url === 'https://fake.convex.site/relay/embed-keys/create') {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer gateway-secret');
      assert.match(new Headers(init?.headers).get('User-Agent')!, /worldmonitor/);
      assert.ok(init?.signal);
      relayBody = JSON.parse(String(init?.body));
      if (relayThrows) throw new TypeError('fetch failed');
      return Response.json(relayStatus === 200 ? { id: 'key_1', name: 'key', keyPrefix: 'wme_aaaaa' } : { error: 'KEY_LIMIT_REACHED' }, { status: relayStatus });
    }
    throw new Error('Stubbed network outage');
  };
});
after(() => { globalThis.fetch = originalFetch; });
beforeEach(() => {
  calls.length = 0;
  verifiedUser = `user_verified_${++userNumber}`;
  planStatus = 200; publicMetadata = { plan: 'pro' };
  session = { id: 'sess_live', status: 'active', user_id: verifiedUser };
  clerkStatus = 200; relayStatus = 200; relayThrows = false; relayBody = {};
});
const clerkCalls = () => calls.filter(c => c.includes('api.clerk.com'));
const relayCalls = () => calls.filter(c => c.includes('/relay/'));
async function request(claims: Record<string, unknown> = { sid: 'sess_live' }, body: unknown = { name: 'key', keyPrefix: 'wme_aaaaa', keyHash: 'a'.repeat(64), userId: 'user_attacker', clerkPlan: 'free' }) {
  const token = await new SignJWT({ azp: 'https://www.worldmonitor.app', v: 2, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setSubject(verifiedUser)
    .setIssuedAt().setExpirationTime('60s').sign(privateKey);
  return new Request('https://www.worldmonitor.app/api/user-embed-keys', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://www.worldmonitor.app', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
// Stub the relay transport; separate default-export tests exercise its real wiring.
const relay = async (body: Record<string, unknown>) => fetch(`${process.env.CONVEX_SITE_URL}/relay/embed-keys/create`, {
  method: 'POST', headers: { Authorization: 'Bearer gateway-secret', 'User-Agent': 'worldmonitor-edge/1.0' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
});
const run = async (req: Request, rateLimit = async () => null as Response | null) => userEmbedKeyCreateHandler(req, {
  resolveSession: resolveVerifiedClerkSession, verifySession: verifyClerkSessionActive, lookupPlan: lookupClerkPlan, rateLimit, relay,
});
describe('Embed-key creation live-session gate', () => {
  it('rejects a revoked session before relay', async () => {
    session = { id: 'sess_live', status: 'revoked', user_id: verifiedUser };
    assert.equal((await run(await request())).status, 401);
    assert.equal(relayCalls().length, 0);
  });
  it('fails closed when Clerk is unavailable', async () => {
    clerkStatus = 503;
    const response = await run(await request());
    assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '5');
    assert.equal(relayCalls().length, 0);
  });
  it('rejects tokens without sid without asking Clerk', async () => {
    assert.equal((await run(await request({}))).status, 401);
    assert.equal(clerkCalls().length, 0); assert.equal(relayCalls().length, 0);
  });
  it('rejects session user mismatch', async () => {
    session = { id: 'sess_live', status: 'active', user_id: 'user_other' };
    assert.equal((await run(await request())).status, 401); assert.equal(relayCalls().length, 0);
  });
  it('sends the verified userId and passes success through', async () => {
    const response = await run(await request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'key_1', name: 'key', keyPrefix: 'wme_aaaaa' });
    assert.equal(relayBody.userId, verifiedUser);
    assert.equal(relayBody.clerkPlan, 'pro');
    assert.equal(Object.hasOwn(relayBody, 'allowedOrigins'), false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
  for (const metadata of [{ plan: 'pro' }, { plan: 'free' }, { plan: 'admin' }, {}]) {
    it(`resolves the role server-side for ${JSON.stringify(metadata)} and ignores body claims`, async () => {
      publicMetadata = metadata;
      const response = await run(await request(undefined, {
        name: 'embed', keyPrefix: 'wme_aaaaa', keyHash: 'a'.repeat(64),
        userId: 'user_other', clerkPlan: metadata.plan === 'pro' ? 'free' : 'pro',
        allowedOrigins: ['https://partner.example'],
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(relayBody, {
        userId: verifiedUser, clerkPlan: metadata.plan === 'pro' ? 'pro' : 'free',
        name: 'embed', keyPrefix: 'wme_aaaaa', keyHash: 'a'.repeat(64),
        allowedOrigins: ['https://partner.example'],
      });
      assert.equal(clerkCalls().length, 2);
      assert.match(clerkCalls()[0], /\/sessions\//);
      assert.match(clerkCalls()[1], /\/users\//);
    });
  }
  it('fails closed when the server-side role lookup is unavailable', async () => {
    planStatus = 503;
    const response = await run(await request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '5');
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
    assert.equal(relayCalls().length, 0);
  });
  it('passes 4xx error codes through', async () => {
    relayStatus = 409; const response = await run(await request());
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'KEY_LIMIT_REACHED' });
  });
  for (const status of [401, 404, 500, 503, 0]) it(`makes relay failure ${status} retryable`, async () => {
    relayStatus = status || 200; relayThrows = status === 0;
    const response = await run(await request());
    assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '5');
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  });
  it('rate-limits before any Clerk call', async () => {
    const response = await run(await request(), async () => new Response('{}', { status: 429 }));
    assert.equal(response.status, 429); assert.equal(clerkCalls().length, 0); assert.equal(relayCalls().length, 0);
  });
  it('default export fails closed on Upstash outage before Clerk', async () => {
    assert.equal((await route(await request())).status, 503);
    assert.equal(clerkCalls().length, 0); assert.equal(relayCalls().length, 0);
    assert.ok(calls.some(c => c.includes('redis.test.invalid')));
  });
  it('exports the fail-closed policy', () => {
    assert.deepEqual(userEmbedKeyCreateRateLimitPolicy('u'), { scope: 'user-embed-key-create', identifier: 'user:u', limit: 10, window: '10 m', failClosed: true });
  });
  it('default export wires the real relay after successful limiting', async () => {
    const stub = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('redis.test.invalid')) {
        const result = { result: [9, 10] };
        return Response.json(String(input).includes('/pipeline') ? [result] : result);
      }
      return stub(input, init);
    };
    try {
      const response = await route(await request());
      assert.equal(response.status, 200);
      assert.equal(relayBody.userId, verifiedUser);
    } finally { globalThis.fetch = stub; }
  });
});

describe('Embed-key creation request contract', () => {
  for (const body of [null, [], {}, { name: 'x', keyPrefix: 'wme_aaaaa', keyHash: 'a', allowedOrigins: [1] }, { name: 'x', keyPrefix: 'wme_aaaaa', keyHash: 'a', allowedOrigins: 'https://partner.example' }]) {
    it(`rejects malformed fields ${JSON.stringify(body)}`, async () => {
      const response = await run(await request(undefined, body));
      assert.equal(response.status, 400);
      assert.equal(relayCalls().length, 0);
      assert.equal(calls.some(c => c.includes('/v1/users/')), false);
    });
  }
  it('rejects malformed JSON', async () => {
    const req = await request();
    const response = await run(new Request(req.url, { method: 'POST', headers: req.headers, body: '{' }));
    assert.equal(response.status, 400); assert.equal(relayCalls().length, 0);
  });
  it('preserves a resolver denial with CORS and no-store', async () => {
    const response = await userEmbedKeyCreateHandler(await request(), {
      resolveSession: async () => Response.json({ error: 'unavailable' }, { status: 503 }),
      rateLimit: async () => { assert.fail('must not rate limit'); },
      verifySession: async () => { assert.fail('must not ask Clerk'); },
      lookupPlan: async () => { assert.fail('must not look up role'); },
      relay: async () => { assert.fail('must not relay'); },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://www.worldmonitor.app');
  });
  it('accepts OPTIONS and rejects GET without authentication', async () => {
    for (const [method, status] of [['OPTIONS', 204], ['GET', 405]] as const) {
      const response = await route(new Request('https://www.worldmonitor.app/api/user-embed-keys', { method }));
      assert.equal(response.status, status);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(calls.length, 0);
  });
});
