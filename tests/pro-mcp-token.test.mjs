/**
 * Tests for `server/_shared/pro-mcp-token.ts` — Edge-runtime-safe wrappers
 * around the Convex Pro-MCP-token internal HTTP actions (U1).
 *
 * Tested invariants (load-bearing, see plan U2):
 *   - validate has NO positive cache: N validate calls produce N Convex calls.
 *   - validate writes a 60s negative-cache sentinel on null result.
 *   - subsequent validates within 60s on a known-bad tokenId short-circuit
 *     WITHOUT a Convex round-trip.
 *   - revoke writes the negative-cache sentinel on success.
 *   - issue propagates Convex 4xx as a typed error; 5xx as a different kind.
 *   - validate is fail-soft on Convex 5xx / timeout (returns null, no
 *     neg-cache write — a blip should not mark a legitimate token as bad
 *     for 60s).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const FAKE_CONVEX = 'https://fake.convex.site';
const FAKE_REDIS = 'https://fake.upstash.io';
const FAKE_SECRET = 'shared-secret-xyz';
const FAKE_REDIS_TOKEN = 'redis-token-abc';

/**
 * In-memory Redis stub for the negative-cache sentinel. Tracks SET writes
 * with their TTL so tests can assert TTL semantics. Reads are simple
 * presence checks — TTL is asserted separately, not enforced as expiry.
 */
function makeRedisStub() {
  const store = new Map(); // key → { value, ttlSeconds }
  return {
    store,
    handle(url) {
      // GET /get/<encodedKey>
      const getMatch = url.match(/\/get\/([^?]+)$/);
      if (getMatch) {
        const key = decodeURIComponent(getMatch[1]);
        const entry = store.get(key);
        return new Response(JSON.stringify({ result: entry ? entry.value : null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // SET /set/<encodedKey>/<encodedValue>/EX/<ttl>
      const setMatch = url.match(/\/set\/([^/]+)\/([^/]+)\/EX\/(\d+)/);
      if (setMatch) {
        const key = decodeURIComponent(setMatch[1]);
        const value = decodeURIComponent(setMatch[2]);
        const ttlSeconds = Number(setMatch[3]);
        store.set(key, { value, ttlSeconds });
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      // DEL /del/<encodedKey>
      const delMatch = url.match(/\/del\/([^?]+)$/);
      if (delMatch) {
        const key = decodeURIComponent(delMatch[1]);
        const existed = store.delete(key);
        return new Response(JSON.stringify({ result: existed ? 1 : 0 }), { status: 200 });
      }
      throw new Error(`Unexpected Redis URL: ${url}`);
    },
  };
}

/**
 * Build a fetch stub that routes Upstash REST through `redis.handle` and
 * Convex internal HTTP actions through the supplied `convexHandler`. Counts
 * Convex hits per route so tests can assert "no positive cache".
 */
function makeFetchStub(redis, convexHandler) {
  const counts = { issue: 0, validate: 0, revoke: 0 };
  const stub = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(FAKE_REDIS)) {
      return redis.handle(url);
    }
    if (url.startsWith(FAKE_CONVEX)) {
      // Verify the shared-secret header is present on every Convex call.
      const headers = new Headers(init?.headers ?? {});
      assert.equal(
        headers.get('x-convex-shared-secret'),
        FAKE_SECRET,
        'Convex calls MUST include the x-convex-shared-secret header',
      );
      if (url.endsWith('/api/internal-issue-pro-mcp-token')) counts.issue++;
      else if (url.endsWith('/api/internal-validate-pro-mcp-token')) counts.validate++;
      else if (url.endsWith('/api/internal-revoke-pro-mcp-token')) counts.revoke++;
      return convexHandler(url, init);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  stub.counts = counts;
  return stub;
}

let mod;

describe('pro-mcp-token', () => {
  beforeEach(async () => {
    process.env.CONVEX_SITE_URL = FAKE_CONVEX;
    process.env.CONVEX_SERVER_SHARED_SECRET = FAKE_SECRET;
    process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS;
    process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
    // Re-import per-test to ensure no module-level state pollutes across
    // tests — the helper has none today, but this is cheap insurance.
    mod = await import(`../server/_shared/pro-mcp-token.ts?cachebust=${Math.random()}`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // -----------------------------------------------------------------------
  // validateProMcpToken — no positive cache, negative-cache only
  // -----------------------------------------------------------------------

  describe('validateProMcpToken', () => {
    it('hits Convex on every call when the token is valid (NO positive cache) — returns ok:valid', async () => {
      const redis = makeRedisStub();
      const convex = (url) => {
        if (url.endsWith('/api/internal-validate-pro-mcp-token')) {
          return new Response(JSON.stringify({ userId: 'user_123' }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      };
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      // Three sequential calls on the SAME tokenId — each must round-trip.
      const r1 = await mod.validateProMcpToken('tok_abc');
      const r2 = await mod.validateProMcpToken('tok_abc');
      const r3 = await mod.validateProMcpToken('tok_abc');

      assert.deepEqual(r1, { ok: 'valid', userId: 'user_123' });
      assert.deepEqual(r2, { ok: 'valid', userId: 'user_123' });
      assert.deepEqual(r3, { ok: 'valid', userId: 'user_123' });
      assert.equal(stub.counts.validate, 3, 'every validate must hit Convex — no positive cache');
      // No neg-cache sentinel for a successful validate.
      assert.equal(redis.store.size, 0, 'positive validate must NOT write neg-cache');
    });

    it('returns ok:revoked + writes neg-cache sentinel on null result; short-circuits subsequent calls', async () => {
      const redis = makeRedisStub();
      let convexHits = 0;
      const convex = () => {
        convexHits++;
        return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      // First call hits Convex, gets null, writes neg-cache sentinel.
      const r1 = await mod.validateProMcpToken('tok_revoked');
      assert.deepEqual(r1, { ok: 'revoked' });
      assert.equal(convexHits, 1, 'first validate hits Convex');
      const sentinel = redis.store.get('pro-mcp-token-neg:tok_revoked');
      assert.ok(sentinel, 'neg-cache sentinel must be written');
      assert.equal(sentinel.value, '1');
      assert.equal(sentinel.ttlSeconds, 60, 'neg-cache TTL must be 60s');

      // Subsequent calls within the cache window short-circuit — Convex hit count stays at 1.
      const r2 = await mod.validateProMcpToken('tok_revoked');
      const r3 = await mod.validateProMcpToken('tok_revoked');
      assert.deepEqual(r2, { ok: 'revoked' });
      assert.deepEqual(r3, { ok: 'revoked' });
      assert.equal(convexHits, 1, 'subsequent validates with neg-cache present must NOT hit Convex');
    });

    it('never-existed tokenId behaves like revoked (Convex returns null → neg-cache set)', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('null', { status: 200 });
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      const r = await mod.validateProMcpToken('tok_never_existed');
      assert.deepEqual(r, { ok: 'revoked' });
      assert.ok(redis.store.has('pro-mcp-token-neg:tok_never_existed'));
      assert.equal(stub.counts.validate, 1);
    });

    it('returns ok:transient on Convex 5xx WITHOUT writing neg-cache (fail-soft, no false-poisoning)', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('upstream blip', { status: 503 });
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      const r = await mod.validateProMcpToken('tok_legit');
      assert.deepEqual(r, { ok: 'transient' }, 'transient Convex failure → ok:transient (caller decides)');
      assert.equal(
        redis.store.size, 0,
        'a transient blip must NOT write the neg-cache sentinel — that would mark a legitimate token bad for 60s',
      );
    });

    it('returns ok:transient on fetch network error (e.g. timeout) and does NOT poison the neg-cache', async () => {
      const redis = makeRedisStub();
      // Override the entire fetch — Convex calls reject; Redis stays in-memory.
      let validateAttempted = false;
      globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(FAKE_REDIS)) return redis.handle(url);
        if (url.startsWith(FAKE_CONVEX)) {
          validateAttempted = true;
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        throw new Error(`unexpected: ${url}`);
      };

      const r = await mod.validateProMcpToken('tok_legit2');
      assert.deepEqual(r, { ok: 'transient' });
      assert.ok(validateAttempted, 'Convex round-trip was attempted');
      assert.equal(redis.store.size, 0, 'timeout must NOT write neg-cache');
    });

    it('returns ok:transient on malformed Convex response (defensive shape check; no neg-cache poison)', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('not json{}{', { status: 200 });
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      const r = await mod.validateProMcpToken('tok_x');
      assert.deepEqual(r, { ok: 'transient' });
      // Malformed body is treated as a transient/unexpected failure → no
      // neg-cache write (would falsely poison a legitimate token).
      assert.equal(redis.store.size, 0);
    });

    it('returns ok:revoked on Convex response missing userId field (structurally not-found)', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ unrelated: 'payload' }), { status: 200 });
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      const r = await mod.validateProMcpToken('tok_y');
      assert.deepEqual(r, { ok: 'revoked' });
      // Missing userId is structurally equivalent to "not found" — write
      // the sentinel just like a null body.
      assert.ok(redis.store.has('pro-mcp-token-neg:tok_y'));
    });

    it('returns ok:revoked for empty tokenId without any fetch', async () => {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        throw new Error('should not fetch');
      };
      const r = await mod.validateProMcpToken('');
      assert.deepEqual(r, { ok: 'revoked' });
      assert.equal(fetched, false);
    });
  });

  // -----------------------------------------------------------------------
  // validateProMcpTokenOrNull — backward-compat wrapper (F3)
  // -----------------------------------------------------------------------

  describe('validateProMcpTokenOrNull (legacy null-shape wrapper)', () => {
    it('maps ok:valid → {userId}', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ userId: 'user_123' }), { status: 200 });
      globalThis.fetch = makeFetchStub(redis, convex);
      const r = await mod.validateProMcpTokenOrNull('tok_abc');
      assert.deepEqual(r, { userId: 'user_123' });
    });

    it('maps ok:revoked → null', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('null', { status: 200 });
      globalThis.fetch = makeFetchStub(redis, convex);
      const r = await mod.validateProMcpTokenOrNull('tok_revoked');
      assert.equal(r, null);
    });

    it('maps ok:transient → null (caller fail-closes)', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('blip', { status: 503 });
      globalThis.fetch = makeFetchStub(redis, convex);
      const r = await mod.validateProMcpTokenOrNull('tok_legit');
      assert.equal(r, null);
    });
  });

  // -----------------------------------------------------------------------
  // issueProMcpTokenForUser — typed errors
  // -----------------------------------------------------------------------

  describe('issueProMcpTokenForUser', () => {
    it('returns {tokenId} on Convex 200', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ tokenId: 'newly_issued_id' }), { status: 200 });
      globalThis.fetch = makeFetchStub(redis, convex);

      const out = await mod.issueProMcpTokenForUser('user_123', 'client_abc', 'Claude Desktop');
      assert.deepEqual(out, { tokenId: 'newly_issued_id' });
    });

    it('throws ProMcpIssueFailed{kind:pro-required} on Convex 403', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ error: 'PRO_REQUIRED' }), { status: 403 });
      globalThis.fetch = makeFetchStub(redis, convex);

      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_free', 'client_abc'),
        (err) =>
          err instanceof mod.ProMcpIssueFailed &&
          err.kind === 'pro-required' &&
          err.status === 403,
      );
    });

    it('throws ProMcpIssueFailed{kind:invalid-user-id} on Convex 400', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ error: 'INVALID_USER_ID' }), { status: 400 });
      globalThis.fetch = makeFetchStub(redis, convex);

      await assert.rejects(
        () => mod.issueProMcpTokenForUser('', 'client_abc'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'invalid-user-id',
      );
    });

    it('throws ProMcpIssueFailed{kind:network} on Convex 5xx', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('boom', { status: 503 });
      globalThis.fetch = makeFetchStub(redis, convex);

      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) =>
          err instanceof mod.ProMcpIssueFailed &&
          err.kind === 'network' &&
          err.status === 503,
      );
    });

    it('throws ProMcpIssueFailed{kind:network} on fetch rejection (timeout)', async () => {
      globalThis.fetch = async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      };
      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'network',
      );
    });

    it('throws ProMcpIssueFailed{kind:config} when CONVEX_SITE_URL is missing', async () => {
      delete process.env.CONVEX_SITE_URL;
      // Re-import so the helper picks up the fresh env at call time. Note the
      // helper reads env on every call, so this is defensive only.
      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'config',
      );
    });

    it('throws ProMcpIssueFailed{kind:network} on 200 with missing tokenId in body', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 });
      globalThis.fetch = makeFetchStub(redis, convex);

      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'network',
      );
    });
  });

  // -----------------------------------------------------------------------
  // revokeProMcpToken — happy path + sentinel side-effect
  // -----------------------------------------------------------------------

  describe('revokeProMcpToken', () => {
    it('returns {ok:true} on Convex 200 AND writes the neg-cache sentinel', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
      const stub = makeFetchStub(redis, convex);
      globalThis.fetch = stub;

      const out = await mod.revokeProMcpToken('user_123', 'tok_to_revoke');
      assert.deepEqual(out, { ok: true });
      assert.equal(stub.counts.revoke, 1);
      const sentinel = redis.store.get('pro-mcp-token-neg:tok_to_revoke');
      assert.ok(sentinel, 'revoke must write neg-cache sentinel for next-request safety');
      assert.equal(sentinel.value, '1');
      assert.equal(sentinel.ttlSeconds, 60);
    });

    it('returns {ok:false, reason:not-found} on Convex 404', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
      globalThis.fetch = makeFetchStub(redis, convex);

      const out = await mod.revokeProMcpToken('user_123', 'tok_missing');
      assert.deepEqual(out, { ok: false, reason: 'not-found' });
      // No neg-cache write on logical failure — the row never existed (or
      // belongs to another user) so polluting the cache is wrong.
      assert.equal(redis.store.size, 0);
    });

    it('returns {ok:false, reason:already-revoked} on Convex 409', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response(JSON.stringify({ error: 'ALREADY_REVOKED' }), { status: 409 });
      globalThis.fetch = makeFetchStub(redis, convex);

      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'already-revoked' });
      assert.equal(redis.store.size, 0);
    });

    it('returns {ok:false, reason:network} on Convex 5xx (does not throw)', async () => {
      const redis = makeRedisStub();
      const convex = () => new Response('boom', { status: 503 });
      globalThis.fetch = makeFetchStub(redis, convex);

      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'network' });
    });

    it('returns {ok:false, reason:network} on fetch rejection (does not throw — rollback callers must not be masked)', async () => {
      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };
      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'network' });
    });

    it('returns {ok:false, reason:not-found} on missing args without any fetch', async () => {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        throw new Error('should not fetch');
      };
      assert.deepEqual(await mod.revokeProMcpToken('', 'tok_x'), { ok: false, reason: 'not-found' });
      assert.deepEqual(await mod.revokeProMcpToken('user_123', ''), { ok: false, reason: 'not-found' });
      assert.equal(fetched, false);
    });
  });

  // -----------------------------------------------------------------------
  // invalidateProMcpTokenCache — direct sentinel writer
  // -----------------------------------------------------------------------

  describe('invalidateProMcpTokenCache', () => {
    it('writes a 60s neg-cache sentinel without contacting Convex', async () => {
      const redis = makeRedisStub();
      let convexHit = false;
      globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(FAKE_REDIS)) return redis.handle(url);
        if (url.startsWith(FAKE_CONVEX)) {
          convexHit = true;
          throw new Error('should not call Convex');
        }
        throw new Error(`unexpected: ${url}`);
      };

      await mod.invalidateProMcpTokenCache('tok_abc');
      assert.equal(convexHit, false);
      const entry = redis.store.get('pro-mcp-token-neg:tok_abc');
      assert.ok(entry);
      assert.equal(entry.value, '1');
      assert.equal(entry.ttlSeconds, 60);
    });

    it('is a no-op for empty tokenId', async () => {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        throw new Error('should not fetch');
      };
      await mod.invalidateProMcpTokenCache('');
      assert.equal(fetched, false);
    });
  });

  // -----------------------------------------------------------------------
  // Integration: revoke → next validate short-circuits without Convex
  // -----------------------------------------------------------------------

  describe('integration', () => {
    it('revoke → validate short-circuits via neg-cache (no Convex round-trip in the cache window)', async () => {
      const redis = makeRedisStub();
      // Convex returns 200 for revoke; never reached for the second validate.
      let validateHits = 0;
      const convex = (url) => {
        if (url.endsWith('/api/internal-revoke-pro-mcp-token')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith('/api/internal-validate-pro-mcp-token')) {
          validateHits++;
          // If we DID reach here, simulate "still valid" — the test's
          // assertion on validateHits is what guards against this.
          return new Response(JSON.stringify({ userId: 'user_123' }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      };
      globalThis.fetch = makeFetchStub(redis, convex);

      // Revoke → writes neg-cache sentinel.
      const revoked = await mod.revokeProMcpToken('user_123', 'tok_revoke_then_validate');
      assert.deepEqual(revoked, { ok: true });

      // Next validate must short-circuit on the sentinel.
      const r = await mod.validateProMcpToken('tok_revoke_then_validate');
      assert.deepEqual(r, { ok: 'revoked' }, 'revoked token must not validate');
      assert.equal(validateHits, 0, 'sentinel must short-circuit Convex round-trip');
    });

    it('clearProMcpTokenNegCache restores the next-validate Convex round-trip path', async () => {
      const redis = makeRedisStub();
      let validateHits = 0;
      const convex = (url) => {
        if (url.endsWith('/api/internal-validate-pro-mcp-token')) {
          validateHits++;
          return new Response(JSON.stringify({ userId: 'user_123' }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      };
      globalThis.fetch = makeFetchStub(redis, convex);

      // Pre-populate the sentinel as if the token had been revoked recently.
      await mod.invalidateProMcpTokenCache('tok_zz');
      assert.deepEqual((await mod.validateProMcpToken('tok_zz')), { ok: 'revoked' });
      assert.equal(validateHits, 0, 'sentinel short-circuited');

      // Clear the sentinel and verify the next validate hits Convex.
      await mod.clearProMcpTokenNegCache('tok_zz');
      const r = await mod.validateProMcpToken('tok_zz');
      assert.deepEqual(r, { ok: 'valid', userId: 'user_123' });
      assert.equal(validateHits, 1, 'after clear, validate must round-trip Convex');
    });
  });
});
