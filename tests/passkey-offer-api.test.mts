import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { __resetJwksForTests } from '../server/auth-session.ts';
// @ts-expect-error JS module without declarations.
import { __resetRateLimitForTest } from '../api/_rate-limit.js';

import {
  default as handler,
  createRedisSlotStore,
  passkeyOfferFingerprint,
  passkeyOfferHandler,
  persistClerkTerminalCount,
  readClerkMigratedCount,
  type PasskeyOfferDeps,
  type PasskeyOfferFailureStep,
} from '../api/user/passkey-offer.ts';

const originalFetch = globalThis.fetch;
const originalClerkSecret = process.env.CLERK_SECRET_KEY;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = originalClerkSecret;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalIssuer === undefined) delete process.env.CLERK_JWT_ISSUER_DOMAIN;
  else process.env.CLERK_JWT_ISSUER_DOMAIN = originalIssuer;
  __resetJwksForTests();
  __resetRateLimitForTest();
});

function deps(overrides: Partial<PasskeyOfferDeps> = {}): PasskeyOfferDeps {
  return {
    resolveUserId: async () => 'user_123',
    rateLimit: async () => null,
    readMigratedCount: async () => 1,
    reserve: async () => ({ status: 'reserved', count: 2 }),
    persistTerminalCount: async () => {},
    ...overrides,
  };
}

function request(method = 'POST'): Request {
  return new Request('https://worldmonitor.app/api/user/passkey-offer', {
    method,
    headers: { Origin: 'https://worldmonitor.app' },
  });
}

describe('passkey offer route', () => {
  for (const limiterState of ['unconfigured', 'unreachable', 'exhausted']) {
    it(`the exported route spends no Clerk quota when the limiter is ${limiterState}`, async () => {
      const issuer = 'https://clerk.passkey.test';
      process.env.CLERK_JWT_ISSUER_DOMAIN = issuer;
      process.env.CLERK_SECRET_KEY = 'sk_test_passkey';
      if (limiterState !== 'unconfigured') {
        process.env.UPSTASH_REDIS_REST_URL = 'https://redis.passkey.test';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      } else {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
      }
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = { ...await exportJWK(publicKey), kid: 'passkey', alg: 'RS256' };
      // Standard session tokens omit plan, exercising the former pre-limit lookup.
      const token = await new SignJWT({ sid: 'sess_passkey' })
        .setProtectedHeader({ alg: 'RS256', kid: 'passkey' })
        .setIssuer(issuer).setSubject('user_123').setIssuedAt().setExpirationTime('60s')
        .sign(privateKey);
      const clerkCalls: string[] = [];
      const redisBodies: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
        if (url.startsWith('https://redis.passkey.test') && limiterState === 'exhausted') {
          redisBodies.push(String(init?.body));
          return Response.json([{ result: [-1, 10] }]);
        }
        if (url.startsWith('https://api.clerk.com/')) clerkCalls.push(url);
        throw new Error('upstream unavailable');
      };
      const req = request();
      req.headers.set('Authorization', `Bearer ${token}`);
      const response = await handler(req);
      assert.equal(response.status, limiterState === 'exhausted' ? 429 : 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.ok(response.headers.get('Retry-After'));
      assert.deepEqual(clerkCalls, []);
      if (limiterState === 'exhausted') {
        assert.equal(response.headers.get('X-RateLimit-Limit'), '10');
        assert.ok(redisBodies.some((body) => body.includes('rl:passkey-offer') && body.includes('user:user_123')));
      }
    });
  }

  for (const status of [429, 503]) {
    it(`returns limiter ${status} before any account read, reservation or mirror`, async () => {
      const calls: string[] = [];
      const response = await passkeyOfferHandler(request(), deps({
        resolveUserId: async () => { calls.push('auth'); return 'user_123'; },
        rateLimit: async (_req, userId, headers) => {
          calls.push(`limit:${userId}`);
          return new Response('{}', { status, headers: { ...headers, 'Retry-After': '60' } });
        },
        readMigratedCount: async () => { calls.push('read'); return 0; },
        reserve: async () => { calls.push('reserve'); return { status: 'reserved', count: 3 }; },
        persistTerminalCount: async () => { calls.push('mirror'); },
      }));
      assert.equal(response.status, status);
      assert.equal(response.headers.get('Retry-After'), '60');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
      assert.deepEqual(calls, ['auth', 'limit:user_123']);
    });
  }

  it('rejects an unauthenticated request before it reads account state', async () => {
    let read = false;
    const response = await passkeyOfferHandler(request(), deps({
      resolveUserId: async () => null,
      rateLimit: async () => { assert.fail('unauthenticated requests must not charge a user budget'); },
      readMigratedCount: async () => { read = true; return 0; },
    }));

    assert.equal(response.status, 401);
    assert.equal(read, false);
  });

  it('charges an allowed account before reading, reserving and mirroring its final slot', async () => {
    const calls: string[] = [];
    const response = await passkeyOfferHandler(request(), deps({
      rateLimit: async () => { calls.push('limit'); return null; },
      readMigratedCount: async () => { calls.push('read'); return 2; },
      reserve: async () => { calls.push('reserve'); return { status: 'reserved', count: 3 }; },
      persistTerminalCount: async () => { calls.push('mirror'); },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['limit', 'read', 'reserve', 'mirror']);
  });

  it('returns the reserved slot without writing a partial Clerk mirror', async () => {
    let mirrored = false;
    const response = await passkeyOfferHandler(request(), deps({
      reserve: async () => ({ status: 'reserved', count: 2 }),
      persistTerminalCount: async () => { mirrored = true; },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'reserved', count: 2 });
    assert.equal(mirrored, false);
  });

  it('mirrors only the terminal cap', async () => {
    let mirroredUserId: string | null = null;
    const response = await passkeyOfferHandler(request(), deps({
      reserve: async () => ({ status: 'reserved', count: 3 }),
      persistTerminalCount: async (userId) => { mirroredUserId = userId; },
    }));

    assert.equal(response.status, 200);
    assert.equal(mirroredUserId, 'user_123');
  });

  it('does not rewrite a terminal mirror that Clerk already has', async () => {
    let mirrored = false;
    const response = await passkeyOfferHandler(request(), deps({
      readMigratedCount: async () => 3,
      reserve: async () => ({ status: 'cap-reached', count: 3 }),
      persistTerminalCount: async () => { mirrored = true; },
    }));

    assert.equal(response.status, 200);
    assert.equal(mirrored, false);
  });

  it('keeps the Redis verdict when the Clerk mirror fails', async () => {
    const response = await passkeyOfferHandler(request(), deps({
      reserve: async () => ({ status: 'cap-reached', count: 3 }),
      persistTerminalCount: async () => { throw new Error('clerk unavailable'); },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'cap-reached', count: 3 });
  });

  it('fails closed when the reservation store is unavailable', async () => {
    const response = await passkeyOfferHandler(request(), deps({
      reserve: async () => { throw new Error('redis unavailable'); },
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '5');
  });

  // WORLDMONITOR-10E: both upstreams abort through `AbortSignal.timeout` and the
  // minified edge bundle gives them identical anonymous frames, so a single
  // `step` value left a Clerk outage and a Redis outage indistinguishable in
  // Sentry. Each upstream must name itself.
  it('attributes a Clerk read failure to the clerk-read step', async () => {
    const steps: PasskeyOfferFailureStep[] = [];
    const response = await passkeyOfferHandler(request(), deps({
      readMigratedCount: async () => { throw new Error('clerk unavailable'); },
      reserve: async () => { throw new Error('reserve must not run'); },
      report: (_error, step) => { steps.push(step); },
    }));

    assert.equal(response.status, 503);
    assert.deepEqual(steps, ['clerk-read']);
  });

  it('attributes a Redis claim failure to the redis-claim step', async () => {
    const steps: PasskeyOfferFailureStep[] = [];
    const response = await passkeyOfferHandler(request(), deps({
      reserve: async () => { throw new Error('redis unavailable'); },
      report: (_error, step) => { steps.push(step); },
    }));

    assert.equal(response.status, 503);
    assert.deepEqual(steps, ['redis-claim']);
  });

  it('attributes a terminal-mirror failure to the clerk-mirror step and still returns the slot', async () => {
    const steps: PasskeyOfferFailureStep[] = [];
    const response = await passkeyOfferHandler(request(), deps({
      readMigratedCount: async () => 2,
      reserve: async () => ({ status: 'reserved', count: 3 }),
      persistTerminalCount: async () => { throw new Error('clerk mirror unavailable'); },
      report: (_error, step) => { steps.push(step); },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(steps, ['clerk-mirror']);
  });
});

describe('passkey offer Sentry fingerprint', () => {
  // A timeout on Clerk and a timeout on Redis carry the same message and the
  // same anonymous stack; only the step keeps them in separate Sentry issues.
  it('separates the two upstreams for an identical error', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });

    assert.deepEqual(
      passkeyOfferFingerprint('clerk-read', timeout),
      ['passkey-offer', 'clerk-read', 'TimeoutError'],
    );
    assert.notDeepEqual(
      passkeyOfferFingerprint('clerk-read', timeout),
      passkeyOfferFingerprint('redis-claim', timeout),
    );
  });

  it('separates distinct faults on the same upstream', () => {
    assert.notDeepEqual(
      passkeyOfferFingerprint('clerk-read', Object.assign(new Error('x'), { name: 'TimeoutError' })),
      passkeyOfferFingerprint('clerk-read', new Error('Clerk user read failed with 500')),
    );
  });

  it('keys a non-Error throw without reading properties off it', () => {
    assert.deepEqual(
      passkeyOfferFingerprint('redis-claim', 'boom'),
      ['passkey-offer', 'redis-claim', 'non-error'],
    );
  });
});

describe('passkey offer Clerk and Redis adapters', () => {
  it('reads the migration count from Clerk unsafe metadata', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_passkey';
    globalThis.fetch = async () => new Response(JSON.stringify({
      unsafe_metadata: { wmPasskeyOfferCount: 2 },
    }), { status: 200 });

    assert.equal(await readClerkMigratedCount('user_123'), 2);
  });

  it('writes only the terminal value through Clerk metadata merge', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_passkey';
    let body: unknown;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('{}', { status: 200 });
    };

    await persistClerkTerminalCount('user_123');

    assert.deepEqual(body, { unsafe_metadata: { wmPasskeyOfferCount: 3 } });
  });

  it('claims each slot with Redis HSETNX', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
    let body: unknown;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify([{ result: 1 }]), { status: 200 });
    };

    assert.equal(await createRedisSlotStore('user_123').claim(2), true);
    assert.deepEqual(body, [[
      'HSETNX',
      'passkey-offer-slots:user_123',
      '2',
      '1',
    ]]);
  });
});
