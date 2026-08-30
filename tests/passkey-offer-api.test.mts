import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createRedisSlotStore,
  passkeyOfferHandler,
  persistClerkTerminalCount,
  readClerkMigratedCount,
  type PasskeyOfferDeps,
} from '../api/user/passkey-offer.ts';

const originalFetch = globalThis.fetch;
const originalClerkSecret = process.env.CLERK_SECRET_KEY;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = originalClerkSecret;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

function deps(overrides: Partial<PasskeyOfferDeps> = {}): PasskeyOfferDeps {
  return {
    resolveUserId: async () => 'user_123',
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
  it('rejects an unauthenticated request before it reads account state', async () => {
    let read = false;
    const response = await passkeyOfferHandler(request(), deps({
      resolveUserId: async () => null,
      readMigratedCount: async () => { read = true; return 0; },
    }));

    assert.equal(response.status, 401);
    assert.equal(read, false);
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
