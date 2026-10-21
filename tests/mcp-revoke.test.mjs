/**
 * Tests for `api/user/mcp-revoke.ts` — Clerk-authenticated revoke endpoint
 * for Pro MCP tokens (plan 2026-05-10-001 U9).
 *
 * Tested invariants:
 *   - userId forwarded to Convex is ALWAYS taken from the verified Clerk
 *     session, never from the request body. Tenancy is enforced inside
 *     Convex (`internalRevokeProMcpToken` checks row.userId === userId).
 *   - Successful revoke calls `invalidateProMcpTokenCache(tokenId)` so
 *     in-flight bearers carrying that tokenId resolve to null on the next
 *     validate (60s neg-cache window).
 *   - Cache-invalidation failure does NOT mask success — the Convex revoke
 *     is the authoritative state.
 *   - Convex 404 → 404; 409 → 409; 5xx/transport → 503 + Retry-After.
 *   - 400 on missing/malformed body. 401 on no session. 405 on non-POST.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { revokeHandler } from '../api/user/mcp-revoke.ts';

function makeReq({ method = 'POST', body = { tokenId: 'tok_abc' }, auth = true, raw = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer fake-jwt';
  return new Request('https://api.worldmonitor.app/api/user/mcp-revoke', {
    method,
    headers,
    body: raw !== null ? raw : (method === 'POST' ? JSON.stringify(body) : undefined),
  });
}

function makeDeps(overrides = {}) {
  const observed = { revokeArgs: null, invalidateArgs: null };
  const deps = {
    resolveUserId: async () => 'user_pro_123',
    convexRevoke: async (userId, tokenId) => {
      observed.revokeArgs = { userId, tokenId };
      return { ok: true };
    },
    invalidateCache: async (tokenId) => {
      observed.invalidateArgs = { tokenId };
    },
    ...overrides,
  };
  return { deps, observed };
}

describe('mcp-revoke handler', () => {
  it('happy: forwards verified userId + tokenId to Convex and invalidates cache', async () => {
    const { deps, observed } = makeDeps();
    const resp = await revokeHandler(makeReq({ body: { tokenId: 'tok_xyz' } }), deps);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.deepEqual(observed.revokeArgs, { userId: 'user_pro_123', tokenId: 'tok_xyz' });
    assert.deepEqual(observed.invalidateArgs, { tokenId: 'tok_xyz' });
  });

  it('tenancy: userId forwarded is from the Clerk session, NEVER from request body', async () => {
    // Attacker supplies userId in body trying to revoke another user's token.
    // The handler MUST use the session-derived userId only.
    const { deps, observed } = makeDeps({
      resolveUserId: async () => 'user_legit_session',
    });
    const req = new Request('https://api.worldmonitor.app/api/user/mcp-revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-jwt' },
      body: JSON.stringify({ tokenId: 'tok_target', userId: 'user_VICTIM' }),
    });
    const resp = await revokeHandler(req, deps);
    assert.equal(resp.status, 200);
    assert.equal(observed.revokeArgs.userId, 'user_legit_session');
    assert.notEqual(observed.revokeArgs.userId, 'user_VICTIM');
  });

  it('returns 400 when tokenId is missing', async () => {
    const { deps } = makeDeps();
    const resp = await revokeHandler(makeReq({ body: {} }), deps);
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error, 'missing_token_id');
  });

  it('returns 400 when tokenId is empty string', async () => {
    const { deps } = makeDeps();
    const resp = await revokeHandler(makeReq({ body: { tokenId: '' } }), deps);
    assert.equal(resp.status, 400);
  });

  it('returns 400 when tokenId is not a string', async () => {
    const { deps } = makeDeps();
    const resp = await revokeHandler(makeReq({ body: { tokenId: 123 } }), deps);
    assert.equal(resp.status, 400);
  });

  it('returns 400 on malformed JSON body', async () => {
    const { deps } = makeDeps();
    const resp = await revokeHandler(makeReq({ raw: '{not-json' }), deps);
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error, 'invalid_json');
  });

  it('returns 401 when no Clerk session is present', async () => {
    const { deps } = makeDeps({ resolveUserId: async () => null });
    const resp = await revokeHandler(makeReq(), deps);
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.equal(body.error, 'unauthenticated');
  });

  it('returns 405 on non-POST methods with Allow header', async () => {
    const { deps } = makeDeps();
    const resp = await revokeHandler(makeReq({ method: 'GET' }), deps);
    assert.equal(resp.status, 405);
    assert.match(resp.headers.get('Allow') ?? '', /POST/);
  });

  it('handles OPTIONS preflight as 204', async () => {
    const { deps } = makeDeps();
    const resp = await revokeHandler(makeReq({ method: 'OPTIONS', auth: false }), deps);
    assert.equal(resp.status, 204);
  });

  it('returns 404 when Convex returns NOT_FOUND (non-owner or invalid id)', async () => {
    const { deps, observed } = makeDeps({
      convexRevoke: async () => ({ ok: false, reason: 'not-found' }),
    });
    const resp = await revokeHandler(makeReq(), deps);
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error, 'not_found');
    // Cache invalidation MUST NOT fire on failure paths — the row is not
    // necessarily revoked; pre-emptively cache-blocking would be incorrect.
    assert.equal(observed.invalidateArgs, null);
  });

  it('returns 409 when Convex returns ALREADY_REVOKED', async () => {
    const { deps, observed } = makeDeps({
      convexRevoke: async () => ({ ok: false, reason: 'already-revoked' }),
    });
    const resp = await revokeHandler(makeReq(), deps);
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.error, 'already_revoked');
    assert.equal(observed.invalidateArgs, null);
  });

  it('returns 503 + Retry-After when Convex network/5xx fails', async () => {
    const { deps, observed } = makeDeps({
      convexRevoke: async () => ({ ok: false, reason: 'network' }),
    });
    const resp = await revokeHandler(makeReq(), deps);
    assert.equal(resp.status, 503);
    assert.equal(resp.headers.get('Retry-After'), '5');
    const body = await resp.json();
    assert.equal(body.error, 'service_unavailable');
    assert.equal(observed.invalidateArgs, null);
  });

  it('cache-invalidation failure does NOT mask success', async () => {
    // The Convex revoke succeeded — that's the authoritative state. A failed
    // negative-cache write only widens the staleness window from "next
    // validate" to "next validate" (the validate already round-trips Convex
    // every time per U2). Surfacing the cache failure as an error here would
    // confuse the user about whether the revoke landed.
    const { deps } = makeDeps({
      invalidateCache: async () => { throw new Error('redis down'); },
    });
    // Wrap in try/catch — the handler should swallow the throw and still 200.
    let resp;
    let threw = null;
    try {
      resp = await revokeHandler(makeReq(), deps);
    } catch (err) {
      threw = err;
    }
    // The handler awaits invalidateCache; if it doesn't catch, the throw
    // bubbles. To protect against the regression, allow either:
    //   (a) handler swallows + 200s   ← preferred
    //   (b) handler still 200s but throws AFTER returning (impossible here)
    // We accept (a) by asserting no throw + 200 status.
    assert.equal(threw, null, 'handler must swallow cache-invalidation failure');
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
  });

  it('sets Cache-Control: no-store on every response', async () => {
    const { deps } = makeDeps();
    const ok = await revokeHandler(makeReq(), deps);
    const unauth = await revokeHandler(makeReq({ auth: false }), { ...deps, resolveUserId: async () => null });
    const badMethod = await revokeHandler(makeReq({ method: 'GET' }), deps);
    const badBody = await revokeHandler(makeReq({ raw: '{' }), deps);
    assert.equal(ok.headers.get('Cache-Control'), 'no-store');
    assert.equal(unauth.headers.get('Cache-Control'), 'no-store');
    assert.equal(badMethod.headers.get('Cache-Control'), 'no-store');
    assert.equal(badBody.headers.get('Cache-Control'), 'no-store');
  });
});
