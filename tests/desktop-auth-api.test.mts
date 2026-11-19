/**
 * Desktop sign-in through the system browser (#9396 follow-up):
 *   POST /api/desktop-auth/authorize — a signed-in browser binds a one-time
 *        code to the desktop's PKCE challenge.
 *   POST /api/desktop-auth/token — the desktop redeems the code with its
 *        verifier for a short-lived Clerk sign-in ticket.
 * See docs/plans/2026-10-19-desktop-system-browser-sign-in.md.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  desktopAuthAuthorizeHandler,
  type DesktopAuthorizeDeps,
} from '../api/desktop-auth/authorize.ts';
import {
  desktopAuthTokenHandler,
  type DesktopTokenDeps,
} from '../api/desktop-auth/token.ts';
import {
  DESKTOP_AUTH_CODE_TTL_SECONDS,
  clientIp,
  desktopAuthCodeKey,
  storeDesktopAuthCode,
  takeDesktopAuthCode,
  type DesktopAuthCodeRecord,
} from '../api/_desktop-auth.ts';

const VERIFIER = 'dBjftJeZ4CVP-mJ92ZcbaYWHQjSNNSSzSRDf8nB25o4';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function post(path: string, body: unknown): Request {
  return new Request(`https://api.worldmonitor.app/api/desktop-auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.worldmonitor.app' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function memoryStore() {
  const records = new Map<string, DesktopAuthCodeRecord>();
  const ttls = new Map<string, number>();
  return {
    records,
    ttls,
    store: async (key: string, record: DesktopAuthCodeRecord, ttlSeconds: number) => {
      if (records.has(key)) return false;
      records.set(key, record);
      ttls.set(key, ttlSeconds);
      return true;
    },
    take: async (key: string) => {
      const record = records.get(key) ?? null;
      records.delete(key);
      return record;
    },
  };
}

function authorizeDeps(store = memoryStore(), overrides: Partial<DesktopAuthorizeDeps> = {}): DesktopAuthorizeDeps {
  return {
    resolveSession: async () => ({ userId: 'user_123', orgId: null, role: 'pro', sessionId: 'sess_123' }),
    verifySession: async () => 'active',
    storeCode: store.store,
    rateLimit: async () => null,
    audit: () => {},
    ...overrides,
  };
}

function tokenDeps(store = memoryStore(), overrides: Partial<DesktopTokenDeps> = {}): DesktopTokenDeps {
  return {
    takeCode: store.take,
    verifySession: async () => 'active',
    mintTicket: async (userId) => ({ kind: 'ticket', ticket: `ticket-for-${userId}` }),
    rateLimit: async () => null,
    audit: () => {},
    report: () => {},
    ...overrides,
  };
}

async function authorize(store: ReturnType<typeof memoryStore>, challenge = CHALLENGE): Promise<string> {
  const response = await desktopAuthAuthorizeHandler(post('authorize', { code_challenge: challenge }), authorizeDeps(store));
  assert.equal(response.status, 200);
  const { code } = await response.json() as { code: string };
  return code;
}

describe('POST /api/desktop-auth/authorize', () => {
  it('binds a one-time code to the challenge for the signed-in user', async () => {
    const store = memoryStore();
    const response = await desktopAuthAuthorizeHandler(post('authorize', { code_challenge: CHALLENGE }), authorizeDeps(store));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { code } = await response.json() as { code: string };
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);

    const key = await desktopAuthCodeKey(code);
    assert.equal(key, `desktop-auth:code:${createHash('sha256').update(`desktop-auth:${code}`).digest('hex')}`);
    assert.deepEqual(store.records.get(key), { userId: 'user_123', sessionId: 'sess_123', codeChallenge: CHALLENGE });
    assert.equal(store.ttls.get(key), DESKTOP_AUTH_CODE_TTL_SECONDS);
    assert.ok(DESKTOP_AUTH_CODE_TTL_SECONDS <= 60);
  });

  it('never stores the raw code', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    for (const key of store.records.keys()) assert.equal(key.includes(code), false);
  });

  it('rejects a signed-out caller', async () => {
    const store = memoryStore();
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(store, { resolveSession: async () => null }),
    );
    assert.equal(response.status, 401);
    assert.equal(store.records.size, 0);
  });

  it('refuses a bearer without a session id before the rate limit or Clerk', async () => {
    const store = memoryStore();
    let limited = 0;
    let checks = 0;
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(store, {
        resolveSession: async () => ({ userId: 'user_123', orgId: null, role: 'pro', sessionId: null }),
        rateLimit: async () => { limited += 1; return null; },
        verifySession: async () => { checks += 1; return 'active'; },
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(limited, 0);
    assert.equal(checks, 0);
    assert.equal(store.records.size, 0);
  });

  it('applies the per-user rate limit before the Clerk session check', async () => {
    const store = memoryStore();
    let checks = 0;
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(store, {
        rateLimit: async () => new Response('{}', { status: 429 }),
        verifySession: async () => { checks += 1; return 'active'; },
      }),
    );
    assert.equal(response.status, 429);
    assert.equal(checks, 0, 'a limited caller never spends the Clerk quota');
    assert.equal(store.records.size, 0);
  });

  it('refuses a session Clerk reports inactive, and stores nothing', async () => {
    const store = memoryStore();
    const checks: Array<[string, string]> = [];
    const events: Array<Record<string, unknown>> = [];
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(store, {
        verifySession: async (sessionId, userId) => { checks.push([sessionId, userId]); return 'inactive'; },
        audit: (event) => events.push(event),
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    assert.deepEqual(checks, [['sess_123', 'user_123']]);
    assert.equal(events.at(-1)?.outcome, 'session_inactive');
    assert.equal(store.records.size, 0);
  });

  it('fails closed with a retryable 503 when the session check is unavailable', async () => {
    const store = memoryStore();
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(store, { verifySession: async () => 'unavailable' }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(store.records.size, 0);
  });

  it('passes a retryable session-verification denial through with no-store', async () => {
    const store = memoryStore();
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(store, { resolveSession: async () => new Response('{}', { status: 503, headers: { 'Retry-After': '5' } }) }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(store.records.size, 0);
  });

  it('rejects a malformed challenge or body', async () => {
    for (const body of [
      { code_challenge: 'short' },
      { code_challenge: `${CHALLENGE}=` },
      { code_challenge: CHALLENGE.replace('-', '+') },
      {},
      'not json',
    ]) {
      const store = memoryStore();
      const response = await desktopAuthAuthorizeHandler(post('authorize', body), authorizeDeps(store));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(store.records.size, 0);
    }
  });

  it('only accepts POST', async () => {
    const response = await desktopAuthAuthorizeHandler(
      new Request('https://api.worldmonitor.app/api/desktop-auth/authorize'),
      authorizeDeps(),
    );
    assert.equal(response.status, 405);
  });

  it('returns 503 when the code cannot be stored', async () => {
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(memoryStore(), { storeCode: async () => false }),
    );
    assert.equal(response.status, 503);
  });

  it('applies the rate limit after authentication', async () => {
    const limited = new Response('{}', { status: 429 });
    const response = await desktopAuthAuthorizeHandler(
      post('authorize', { code_challenge: CHALLENGE }),
      authorizeDeps(memoryStore(), { rateLimit: async () => limited }),
    );
    assert.equal(response.status, 429);
  });
});

describe('POST /api/desktop-auth/token', () => {
  it('exchanges the code and its verifier for a sign-in ticket once', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    const deps = tokenDeps(store);

    const first = await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await first.json(), { ticket: 'ticket-for-user_123' });

    const replay = await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: 'invalid_grant' });
  });

  it('refuses a verifier that does not match, and burns the code', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    let minted = 0;
    const deps = tokenDeps(store, { mintTicket: async () => { minted += 1; return { kind: 'ticket', ticket: 't' }; } });

    const wrong = await desktopAuthTokenHandler(post('token', { code, code_verifier: 'x'.repeat(43) }), deps);
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), { error: 'invalid_grant' });

    const retry = await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);
    assert.equal(retry.status, 400);
    assert.equal(minted, 0);
  });

  it('refuses an unknown code', async () => {
    const response = await desktopAuthTokenHandler(
      post('token', { code: 'A'.repeat(43), code_verifier: VERIFIER }),
      tokenDeps(),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_grant' });
  });

  it('rejects malformed input before touching the store', async () => {
    let takes = 0;
    const deps = tokenDeps(memoryStore(), { takeCode: async () => { takes += 1; return null; } });
    for (const body of [
      { code: 'A'.repeat(43) },
      { code_verifier: VERIFIER },
      { code: 'A'.repeat(43), code_verifier: 'short' },
      { code: 'A'.repeat(43), code_verifier: `${VERIFIER}!` },
      { code: 'not a code', code_verifier: VERIFIER },
      'not json',
    ]) {
      const response = await desktopAuthTokenHandler(post('token', body), deps);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }
    assert.equal(takes, 0);
  });

  it('re-checks the bound session at Clerk and refuses a 401 when it is no longer live', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    const checks: Array<[string, string]> = [];
    let minted = 0;
    const events: Array<Record<string, unknown>> = [];
    const response = await desktopAuthTokenHandler(
      post('token', { code, code_verifier: VERIFIER }),
      tokenDeps(store, {
        verifySession: async (sessionId, userId) => { checks.push([sessionId, userId]); return 'inactive'; },
        mintTicket: async () => { minted += 1; return { kind: 'ticket', ticket: 't' }; },
        audit: (event) => events.push(event),
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'session_inactive' });
    assert.deepEqual(checks, [['sess_123', 'user_123']]);
    assert.equal(minted, 0);
    assert.equal(events.at(-1)?.outcome, 'session_inactive');
    assert.equal(store.records.size, 0, 'the code is burned');
  });

  it('fails closed with 503 when the session check is unavailable, does not mint, and does not invite a retry of a burned code', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    let minted = 0;
    const deps = tokenDeps(store, {
      verifySession: async () => 'unavailable',
      mintTicket: async () => { minted += 1; return { kind: 'ticket', ticket: 't' }; },
    });
    const response = await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), null, 'GETDEL burned the code; the browser flow must restart');
    assert.deepEqual(await response.json(), { error: 'session_check_unavailable' });
    assert.equal(minted, 0);

    const retry = await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);
    assert.equal(retry.status, 400);
    assert.deepEqual(await retry.json(), { error: 'invalid_grant' });
  });

  it('checks the session only after the verifier matched', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    let checks = 0;
    const response = await desktopAuthTokenHandler(
      post('token', { code, code_verifier: 'x'.repeat(43) }),
      tokenDeps(store, { verifySession: async () => { checks += 1; return 'active'; } }),
    );
    assert.equal(response.status, 400);
    assert.equal(checks, 0);
  });

  it('maps a Clerk refusal for the user to 403, not a server error', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    let reports = 0;
    const response = await desktopAuthTokenHandler(
      post('token', { code, code_verifier: VERIFIER }),
      tokenDeps(store, {
        mintTicket: async () => ({ kind: 'refused', status: 403 }),
        report: () => { reports += 1; },
      }),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'sign_in_refused' });
    assert.equal(reports, 0);
  });

  it('reports a Clerk outage as 502', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    const reported: unknown[] = [];
    const response = await desktopAuthTokenHandler(
      post('token', { code, code_verifier: VERIFIER }),
      tokenDeps(store, {
        mintTicket: async () => { throw new TypeError('fetch failed'); },
        report: (error) => { reported.push(error); },
      }),
    );
    assert.equal(response.status, 502);
    assert.equal(reported.length, 1);
    assert.ok(reported[0] instanceof TypeError);
  });

  it('returns 503 when the code store is unreachable', async () => {
    const response = await desktopAuthTokenHandler(
      post('token', { code: 'A'.repeat(43), code_verifier: VERIFIER }),
      tokenDeps(memoryStore(), { takeCode: async () => { throw new Error('Redis HTTP 500'); } }),
    );
    assert.equal(response.status, 503);
  });

  it('audits success and failure without the code or ticket', async () => {
    const store = memoryStore();
    const code = await authorize(store);
    const events: Array<Record<string, unknown>> = [];
    const deps = tokenDeps(store, { audit: (event) => events.push(event) });

    await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);
    await desktopAuthTokenHandler(post('token', { code, code_verifier: VERIFIER }), deps);

    assert.deepEqual(events.map((event) => event.outcome), ['ticket_issued', 'invalid_grant']);
    assert.equal(events[0]!.userId, 'user_123');
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(code), false);
    assert.equal(serialized.includes('ticket-for-user_123'), false);
  });
});

describe('desktop-auth helpers', () => {
  it('audits the hardened client IP, never a spoofable cf-connecting-ip or x-forwarded-for', () => {
    const request = new Request('https://api.worldmonitor.app/api/desktop-auth/token', {
      headers: {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '198.51.100.7',
        'x-real-ip': '192.0.2.44',
      },
    });
    assert.equal(clientIp(request), '192.0.2.44');
  });

  it('identifies itself to Redis on both code operations', async () => {
    const originalFetch = globalThis.fetch;
    const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const agents: Array<string | null> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      agents.push(new Headers(init?.headers).get('user-agent'));
      return Response.json(String(_input).includes('/pipeline') ? [{ result: 'OK' }] : { result: null });
    }) as typeof fetch;
    try {
      await storeDesktopAuthCode('desktop-auth:code:x', { userId: 'u', sessionId: 'sess_u', codeChallenge: CHALLENGE }, 60);
      await takeDesktopAuthCode('desktop-auth:code:x');
    } finally {
      globalThis.fetch = originalFetch;
      if (saved.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = saved.url;
      if (saved.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
    }
    assert.equal(agents.length, 2);
    for (const agent of agents) assert.match(agent ?? '', /worldmonitor/i);
  });

  it('cannot redeem a stored record that carries no session to re-check', async () => {
    const originalFetch = globalThis.fetch;
    const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    let stored = JSON.stringify({ userId: 'u', codeChallenge: CHALLENGE });
    globalThis.fetch = (async () => Response.json({ result: stored })) as typeof fetch;
    try {
      assert.equal(await takeDesktopAuthCode('desktop-auth:code:legacy'), null);
      stored = JSON.stringify({ userId: 'u', sessionId: '', codeChallenge: CHALLENGE });
      assert.equal(await takeDesktopAuthCode('desktop-auth:code:legacy'), null);
      stored = JSON.stringify({ userId: 'u', sessionId: 'sess_u', codeChallenge: CHALLENGE });
      assert.deepEqual(await takeDesktopAuthCode('desktop-auth:code:ok'), { userId: 'u', sessionId: 'sess_u', codeChallenge: CHALLENGE });
    } finally {
      globalThis.fetch = originalFetch;
      if (saved.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = saved.url;
      if (saved.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
    }
  });
});
