/**
 * A Clerk bearer whose session Clerk has revoked (sign-out, "sign out other
 * devices", an admin revoke) is still a validly signed JWT until `exp`. Every
 * route that trades such a bearer for a credential that outlives it must ask
 * Clerk whether the session is live — the desktop sign-in (which mints a
 * brand-new session) and the Pro MCP grant. Strix pentest, 2026-10-27.
 *
 * Production pieces under test: the real `resolveVerifiedClerkSession`,
 * `verifyClerkSessionActive`, `mintClerkSignInTicket` and the exported
 * handlers. Only fetch (JWKS + Clerk Backend API), the Upstash-backed rate
 * limiter and the Redis stores are stubbed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, beforeEach, describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import type { DesktopAuthCodeRecord } from '../api/_desktop-auth.ts';

const ISSUER = 'https://clerk.test.invalid';
const REDIS_URL = 'https://redis.test.invalid';
process.env.CLERK_JWT_ISSUER_DOMAIN = ISSUER;
process.env.CLERK_SECRET_KEY = 'sk_test_stub';
process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';

const VERIFIER = 'dBjftJeZ4CVP-mJ92ZcbaYWHQjSNNSSzSRDf8nB25o4';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const ORIGIN = 'https://www.worldmonitor.app';

type SessionAnswer =
  | { status: string; userId?: string }
  | { httpStatus: number }
  | { throws: Error };

/** Clerk's view of each session, and a log of every outbound call. */
const clerk = {
  sessions: new Map<string, SessionAnswer>(),
  calls: [] as string[],
};

let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const originalWarn = console.warn;
  console.warn = () => {};
  process.on('exit', () => { console.warn = originalWarn; });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    clerk.calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    const session = url.match(/^https:\/\/api\.clerk\.com\/v1\/sessions\/([^/?]+)$/);
    if (session) {
      assert.match(new Headers(init?.headers).get('user-agent') ?? '', /worldmonitor/i);
      const sid = decodeURIComponent(session[1]!);
      const answer = clerk.sessions.get(sid) ?? { httpStatus: 404 };
      if ('throws' in answer) throw answer.throws;
      if ('httpStatus' in answer) return new Response('', { status: answer.httpStatus });
      return Response.json({ id: sid, status: answer.status, user_id: answer.userId ?? 'user_victim' });
    }
    if (url === 'https://api.clerk.com/v1/sign_in_tokens') return Response.json({ token: 'ticket_durable' });
    if (url.startsWith('https://api.clerk.com/v1/users/')) return Response.json({ public_metadata: { plan: 'pro' } });
    // Upstash: no nonce row exists, so a mint that passed auth answers 400.
    if (url.startsWith(`${REDIS_URL}/get/`)) return Response.json({ result: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});

beforeEach(() => {
  clerk.sessions.clear();
  clerk.calls.length = 0;
});

const sessionCalls = () => clerk.calls.filter((call) => call.includes('/v1/sessions/'));
const mintCalls = () => clerk.calls.filter((call) => call.includes('/v1/sign_in_tokens'));
// A standard session token has no `plan` claim; these routes must not pay a
// Clerk user lookup for it ahead of their limiter (Strix, 2026-10-28).
const planLookups = () => clerk.calls.filter((call) => call.includes('/v1/users/'));

async function signToken(claims: Record<string, unknown>, subject = 'user_victim'): Promise<string> {
  return new SignJWT({ azp: ORIGIN, v: 2, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setSubject(subject).setIssuedAt().setExpirationTime('60s')
    .sign(privateKey);
}

function post(url: string, body: unknown, bearer?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('desktop sign-in: a revoked Clerk session cannot be laundered into a ticket', async () => {
  const { resolveVerifiedClerkSession } = await import('../server/_shared/auth-session.ts');
  const { verifyClerkSessionActive } = await import('../server/auth-session.ts');
  const { desktopAuthAuthorizeHandler } = await import('../api/desktop-auth/authorize.ts');
  const { desktopAuthTokenHandler } = await import('../api/desktop-auth/token.ts');
  const { mintClerkSignInTicket } = await import('../api/_desktop-auth.ts');

  function flow(rateLimit: () => Promise<Response | null> = async () => null) {
    const records = new Map<string, DesktopAuthCodeRecord>();
    const authorize = (bearer: string) => desktopAuthAuthorizeHandler(
      post('https://api.worldmonitor.app/api/desktop-auth/authorize', { code_challenge: CHALLENGE }, bearer),
      {
        resolveSession: resolveVerifiedClerkSession,
        verifySession: verifyClerkSessionActive,
        storeCode: async (key, record) => { records.set(key, record); return true; },
        rateLimit,
        audit: () => {},
      },
    );
    const token = (code: string) => desktopAuthTokenHandler(
      post('https://api.worldmonitor.app/api/desktop-auth/token', { code, code_verifier: VERIFIER }),
      {
        takeCode: async (key) => { const record = records.get(key) ?? null; records.delete(key); return record; },
        verifySession: verifyClerkSessionActive,
        mintTicket: mintClerkSignInTicket,
        rateLimit: async () => null,
        audit: () => {},
        report: () => {},
      },
    );
    return { records, authorize, token };
  }

  it('refuses a token whose session Clerk reports revoked, before storing a code', async () => {
    clerk.sessions.set('sess_revoked', { status: 'revoked' });
    const { records, authorize } = flow();
    const response = await authorize(await signToken({ sid: 'sess_revoked' }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    assert.equal(records.size, 0);
    assert.equal(sessionCalls().length, 1);
    assert.equal(mintCalls().length, 0);
  });

  it('refuses a session that belongs to another user', async () => {
    clerk.sessions.set('sess_other', { status: 'active', userId: 'user_attacker' });
    const { records, authorize } = flow();
    const response = await authorize(await signToken({ sid: 'sess_other' }));
    assert.equal(response.status, 401);
    assert.equal(records.size, 0);
  });

  it('refuses a token that carries no sid at all', async () => {
    const { records, authorize } = flow();
    const response = await authorize(await signToken({}));
    assert.equal(response.status, 401);
    assert.equal(records.size, 0);
    assert.equal(sessionCalls().length, 0);
  });

  it('rate-limits on the locally verified identity before any Clerk call', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const { records, authorize } = flow(async () => new Response('{}', { status: 429 }));
    const response = await authorize(await signToken({ sid: 'sess_live' }));
    assert.equal(response.status, 429);
    assert.equal(sessionCalls().length, 0, 'a limited caller never spends the Clerk quota');
    assert.equal(planLookups().length, 0, 'nor a plan lookup ahead of the limiter');
    assert.equal(records.size, 0);
  });

  it('refuses a sid Clerk does not know', async () => {
    const { records, authorize } = flow();
    const response = await authorize(await signToken({ sid: 'sess_unknown' }));
    assert.equal(response.status, 401);
    assert.equal(records.size, 0);
  });

  for (const [label, answer] of [
    ['a Clerk 5xx', { httpStatus: 503 }],
    ['a Clerk timeout', { throws: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }],
    ['a network failure', { throws: new TypeError('fetch failed') }],
  ] as const) {
    it(`fails closed with a retryable 503 on ${label}, never a code`, async () => {
      clerk.sessions.set('sess_live', answer);
      const { records, authorize } = flow();
      const response = await authorize(await signToken({ sid: 'sess_live' }));
      assert.equal(response.status, 503);
      assert.ok(response.headers.get('retry-after'));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(records.size, 0);
    });
  }

  it('refuses the ticket when the session is revoked between /authorize and /token', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const { records, authorize, token } = flow();
    const authorized = await authorize(await signToken({ sid: 'sess_live' }));
    assert.equal(authorized.status, 200);
    const { code } = await authorized.json() as { code: string };
    assert.deepEqual([...records.values()], [{ userId: 'user_victim', sessionId: 'sess_live', codeChallenge: CHALLENGE }]);

    // "Sign out" in the browser before the desktop redeems the code.
    clerk.sessions.set('sess_live', { status: 'ended' });
    const redeemed = await token(code);
    assert.equal(redeemed.status, 401);
    assert.deepEqual(await redeemed.json(), { error: 'session_inactive' });
    assert.equal(mintCalls().length, 0);
    assert.equal(records.size, 0, 'the code is burned either way');
  });

  it('fails closed at /token when Clerk cannot answer, and does not mint', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const { authorize, token } = flow();
    const { code } = await (await authorize(await signToken({ sid: 'sess_live' }))).json() as { code: string };

    clerk.sessions.set('sess_live', { httpStatus: 502 });
    const redeemed = await token(code);
    assert.equal(redeemed.status, 503);
    assert.deepEqual(await redeemed.json(), { error: 'session_check_unavailable' });
    // The code is single-use and already burned: no Retry-After, restart instead.
    assert.equal(redeemed.headers.get('retry-after'), null);
    assert.equal(mintCalls().length, 0);
  });

  it('still issues a ticket for a session that is live at both steps', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const { authorize, token } = flow();
    const { code } = await (await authorize(await signToken({ sid: 'sess_live' }))).json() as { code: string };
    const redeemed = await token(code);
    assert.equal(redeemed.status, 200);
    assert.deepEqual(await redeemed.json(), { ticket: 'ticket_durable' });
    assert.equal(sessionCalls().length, 2, 'checked once per step, never cached');
    assert.equal(mintCalls().length, 1);
    assert.equal(planLookups().length, 0, 'no plan lookup for a session token on this route');
  });
});

describe('Pro MCP grant: the handler requires a live Clerk session (production resolvers)', async () => {
  const { mintGrantHandler } = await import('../api/internal/mcp-grant-mint.ts');
  const { resolveVerifiedClerkSession } = await import('../server/_shared/auth-session.ts');
  const { verifyClerkSessionActive } = await import('../server/auth-session.ts');

  // Real bearer resolution and Clerk check; the Upstash-backed limiter and
  // Redis are injected so the test needs no Redis (the nonce never exists).
  function mint(bearer: string, rateLimit: () => Promise<Response | null> = async () => null) {
    const nonceReads: string[] = [];
    const response = mintGrantHandler(
      post('https://worldmonitor.app/api/internal/mcp-grant-mint', { nonce: 'nonce_xyz' }, bearer),
      {
        resolveSession: resolveVerifiedClerkSession,
        rateLimit,
        verifySession: verifyClerkSessionActive,
        redisGet: async (key) => { nonceReads.push(key); return null; },
        redisSetEx: async () => true,
        redisSetNxEx: async () => true,
        getEntitlements: async () => null,
        isAllowedRedirectUri: () => true,
        signGrant: async () => 'grant',
        now: () => Date.now(),
      },
    );
    return { response, nonceReads };
  }

  it('answers 401 for a revoked session before reading the nonce', async () => {
    clerk.sessions.set('sess_revoked', { status: 'revoked' });
    const { response, nonceReads } = mint(await signToken({ sid: 'sess_revoked' }));
    assert.equal((await response).status, 401);
    assert.deepEqual(await (await response).json(), { error: 'UNAUTHENTICATED', error_description: 'A valid Clerk session is required.' });
    assert.equal(nonceReads.length, 0);
    assert.equal(sessionCalls().length, 1);
  });

  it('answers 401 for a token without a sid, without asking Clerk', async () => {
    const { response } = mint(await signToken({}));
    assert.equal((await response).status, 401);
    assert.equal(sessionCalls().length, 0);
  });

  it('rate-limits on the locally verified identity before any Clerk call', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const { response, nonceReads } = mint(await signToken({ sid: 'sess_live' }), async () => new Response('{}', { status: 429 }));
    assert.equal((await response).status, 429);
    assert.equal(sessionCalls().length, 0, 'a limited caller never spends the Clerk quota');
    assert.equal(planLookups().length, 0, 'nor a plan lookup ahead of the limiter');
    assert.equal(nonceReads.length, 0);
  });

  it('answers a retryable 503 when Clerk cannot confirm the session', async () => {
    clerk.sessions.set('sess_live', { httpStatus: 500 });
    const { response, nonceReads } = mint(await signToken({ sid: 'sess_live' }));
    assert.equal((await response).status, 503);
    assert.equal((await (await response).json() as { error: string }).error, 'SERVICE_UNAVAILABLE');
    assert.ok((await response).headers.get('retry-after'));
    assert.equal(nonceReads.length, 0);
  });

  it('lets a live session through to the nonce lookup', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const { response, nonceReads } = mint(await signToken({ sid: 'sess_live' }));
    // Auth passed; the injected Redis has no such nonce.
    assert.equal((await response).status, 400);
    assert.equal((await (await response).json() as { error: string }).error, 'INVALID_NONCE');
    assert.deepEqual(nonceReads, ['oauth:nonce:nonce_xyz']);
    assert.equal(sessionCalls().length, 1);
  });
});

describe('the limiter in front of the Clerk session check fails closed', async () => {
  const { default: authorizeRoute, desktopAuthorizeRateLimitPolicy } = await import('../api/desktop-auth/authorize.ts');
  const { default: mintRoute, mintRateLimitPolicy } = await import('../api/internal/mcp-grant-mint.ts');

  // The fetch stub throws for every Upstash limiter call, so the production
  // limiter sees a Redis outage. Failing open would put one caller's requests
  // straight onto the shared Clerk Backend API quota.
  it('desktop sign-in answers 503 without asking Clerk when the limiter is down', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const bearer = await signToken({ sid: 'sess_live' });
    const response = await authorizeRoute(
      post('https://api.worldmonitor.app/api/desktop-auth/authorize', { code_challenge: CHALLENGE }, bearer),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(sessionCalls(), []);
  });

  it('the MCP grant mint answers 503 without asking Clerk when the limiter is down', async () => {
    clerk.sessions.set('sess_live', { status: 'active' });
    const bearer = await signToken({ sid: 'sess_live' });
    const response = await mintRoute(
      post('https://api.worldmonitor.app/api/internal/mcp-grant-mint', { nonce: 'n'.repeat(32) }, bearer),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(sessionCalls(), []);
  });

  it('both production policies are fail-closed', () => {
    assert.equal(desktopAuthorizeRateLimitPolicy('user_victim').failClosed, true);
    assert.equal(mintRateLimitPolicy('user_victim').failClosed, true);
  });
});
