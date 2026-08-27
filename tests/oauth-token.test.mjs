/**
 * Tests for U6 — OAuth `/oauth/token` endpoint + bearer resolver
 * discriminated union.
 *
 * Coverage focus:
 *   - `authorization_code` grant branches on `codeData.kind` and writes
 *     the correct Redis shape (Pro: object, legacy: bare string).
 *   - `refresh_token` grant branches on `refreshData.kind`, calls
 *     `validateProMcpToken` for Pro, preserves `family_id` + `mcpTokenId`
 *     across rotation, and rejects with `invalid_grant` on revoke.
 *   - `resolveBearerToContext` returns the correct discriminated union
 *     for legacy bare-string AND Pro object shapes; null on malformed /
 *     unknown / missing.
 *   - `resolveApiKeyFromBearer` (legacy wrapper) returns the env-key
 *     cleartext for env-key contexts and null for Pro contexts (so
 *     pre-U7 callers can't mis-handle a Pro bearer).
 *   - The legacy `client_credentials` grant remains a 16-char
 *     fingerprint write (regression guard).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';

import { rawRedisCompareAndDeleteIfAbsent, tokenHandler } from '../api/oauth/token.ts';
import {
  resolveBearerToContext,
  resolveApiKeyFromBearer,
} from '../api/_oauth-token.js';
import { sha256Hex, keyFingerprint } from '../api/_crypto.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = 'client_abc';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const USER_ID = 'user_pro_123';
const MCP_TOKEN_ID = 'k57_mcp_token_id';
const TOKEN_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 604800;

// PKCE: known verifier → known challenge (BASE64URL of SHA-256).
const CODE_VERIFIER = 'a'.repeat(64);
function makeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const CODE_CHALLENGE = makeChallenge(CODE_VERIFIER);

const CLIENT_RECORD = {
  client_name: 'Claude Desktop',
  redirect_uris: [REDIRECT_URI],
};

// Sample env-key + its hash (used for legacy code-record fixtures).
const ENV_KEY = 'wm_test_key_12345';
let ENV_KEY_HASH;
let ENV_KEY_FINGERPRINT;

// Async test setup — sha256 is async (uses WebCrypto via _crypto.js).
async function ensureFixtures() {
  if (!ENV_KEY_HASH) {
    ENV_KEY_HASH = await sha256Hex(ENV_KEY);
    ENV_KEY_FINGERPRINT = await keyFingerprint(ENV_KEY);
  }
}

// ---------------------------------------------------------------------------
// Deps factory — every test calls with overrides for the specific surface.
// ---------------------------------------------------------------------------

function makeRedis() {
  const store = new Map();
  const ops = [];
  return {
    store,
    ops,
    redisGetDel: async (key) => {
      ops.push({ kind: 'getdel', key });
      const v = store.get(key);
      store.delete(key);
      if (v === undefined) return null;
      // Mirror production rawRedisGetDel: pipeline writes JSON strings and
      // the handler receives their parsed value on the next redemption.
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    redisGet: async (key) => {
      ops.push({ kind: 'get', key });
      const v = store.get(key);
      if (v === undefined) return null;
      // Mirror production rawRedisGet: values are stored as JSON strings and
      // returned parsed. Pipeline-written values (e.g. the famptr) are JSON
      // strings; objects a test pre-seeds directly pass through unchanged.
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    redisCompareAndDeleteIfAbsent: async (key, expectedValue, absentKey) => {
      ops.push({ kind: 'compare-delete', key, expectedValue, absentKey });
      if (store.has(absentKey)) return false;
      if (store.get(key) !== expectedValue) return false;
      store.delete(key);
      return true;
    },
    redisPipeline: async (commands) => {
      const results = [];
      for (const cmd of commands) {
        ops.push({ kind: 'pipeline', cmd });
        const op = String(cmd[0]).toUpperCase();
        if (op === 'SET') {
          const [, key, value] = cmd;
          store.set(key, value); // raw JSON-string from the writer
          results.push({ result: 'OK' });
        } else if (op === 'EXPIRE') {
          results.push({ result: '1' });
        } else {
          results.push({ result: 'OK' });
        }
      }
      return results;
    },
  };
}

function findSetCommand(ops, key) {
  return ops
    .filter((op) => op.kind === 'pipeline')
    .map((op) => op.cmd)
    .find((cmd) => String(cmd[0]).toUpperCase() === 'SET' && cmd[1] === key);
}

function assertSetEx(ops, key, expectedValue, expectedTtl) {
  const cmd = findSetCommand(ops, key);
  assert.ok(cmd, `expected SET command for ${key}`);
  assert.deepEqual(cmd, ['SET', key, expectedValue, 'EX', expectedTtl]);
}

function assertFamilyPointerSetEx(ops, key, expectedFamilyId, expectedTtl) {
  const cmd = findSetCommand(ops, key);
  assert.ok(cmd, `expected SET command for ${key}`);
  assert.equal(cmd[0], 'SET');
  assert.equal(cmd[1], key);
  assert.equal(cmd[3], 'EX');
  assert.equal(cmd[4], expectedTtl);
  const pointer = JSON.parse(cmd[2]);
  if (typeof pointer === 'string') {
    assert.equal(pointer, expectedFamilyId);
    return;
  }
  assert.equal(pointer.family_id, expectedFamilyId);
  assert.equal(typeof pointer.pointer_id, 'string');
  assert.ok(pointer.pointer_id);
}

let _uuidCounter = 0;
let _pointerCounter = 0;
function deterministicUuid() {
  _uuidCounter += 1;
  return `uuid_${String(_uuidCounter).padStart(4, '0')}`;
}

function deterministicPointerId() {
  _pointerCounter += 1;
  return `pointer_${String(_pointerCounter).padStart(4, '0')}`;
}

function makeDeps(overrides = {}) {
  const redis = overrides.redis ?? makeRedis();
  const restoreFailures = [];
  return {
    redis, // for assertions (not part of TokenHandlerDeps)
    restoreFailures,
    deps: {
      redisGetDel: redis.redisGetDel,
      redisGet: redis.redisGet,
      redisCompareAndDeleteIfAbsent: redis.redisCompareAndDeleteIfAbsent,
      redisPipeline: redis.redisPipeline,
      // F3 (U7+U8 review pass): validateProMcpToken now returns the
      // ProMcpValidateUnion. Tests passing `null` are normalised here to
      // `{ok:'revoked'}` so the existing assertions remain meaningful;
      // tests passing the new shape pass through unchanged.
      validateProMcpToken: overrides.validateProMcpToken ?? (async () => ({ ok: 'valid', userId: USER_ID })),
      randomUuid: overrides.randomUuid ?? deterministicUuid,
      randomPointerId: overrides.randomPointerId ?? deterministicPointerId,
      captureRestoreFailure: overrides.captureRestoreFailure ?? ((context) => restoreFailures.push(context)),
    },
  };
}

function makeReq(grantType, params) {
  const body = new URLSearchParams({ grant_type: grantType, ...params }).toString();
  return new Request('https://example.com/oauth/token', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

describe('OAuth Redis compare-and-delete production contract', () => {
  it('uses POST EVAL and validates the Upstash response body', async () => {
    const realFetch = globalThis.fetch;
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ result: calls.length === 1 ? 1 : '1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      assert.equal(
        await rawRedisCompareAndDeleteIfAbsent(
          'oauth:famptr:rt-contract',
          'expected-pointer',
          'oauth:refresh:rt-contract',
        ),
        true,
      );
      assert.equal(calls[0].url, 'https://test.upstash.io/');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
      assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
      assert.equal(calls[0].init.headers['User-Agent'], 'worldmonitor-edge/1.0');
      const command = JSON.parse(calls[0].init.body);
      assert.equal(command[0], 'EVAL');
      assert.equal(command[2], '2');
      assert.equal(command[3], 'oauth:famptr:rt-contract');
      assert.equal(command[4], 'oauth:refresh:rt-contract');
      assert.equal(command[5], 'expected-pointer');

      await assert.rejects(
        rawRedisCompareAndDeleteIfAbsent(
          'oauth:famptr:rt-contract',
          'expected-pointer',
          'oauth:refresh:rt-contract',
        ),
        /invalid response/,
      );
    } finally {
      globalThis.fetch = realFetch;
      if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    }
  });
});

// ---------------------------------------------------------------------------
// authorization_code — Pro path
// ---------------------------------------------------------------------------

describe('U6 tokenHandler — authorization_code (Pro)', () => {
  it('exchanges Pro code → token; Redis records carry kind:"pro"; response scope is mcp_pro', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set(`oauth:code:abc`, {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp_pro',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 0;
    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.access_token, 'uuid_0001');
    assert.equal(body.refresh_token, 'uuid_0002');
    assert.equal(body.scope, 'mcp_pro');
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 3600);

    // Access token record is the Pro object shape.
    const accessRaw = redis.store.get('oauth:token:uuid_0001');
    assert.deepEqual(JSON.parse(accessRaw), {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
    });

    // Refresh record carries client_id, userId, mcpTokenId, scope, family_id.
    const refreshRaw = redis.store.get('oauth:refresh:uuid_0002');
    const refresh = JSON.parse(refreshRaw);
    assert.equal(refresh.kind, 'pro');
    assert.equal(refresh.client_id, CLIENT_ID);
    assert.equal(refresh.userId, USER_ID);
    assert.equal(refresh.mcpTokenId, MCP_TOKEN_ID);
    assert.equal(refresh.scope, 'mcp_pro');
    assert.equal(refresh.family_id, 'uuid_0003');
    assertSetEx(redis.ops, 'oauth:tokenfam:uuid_0001', JSON.stringify('uuid_0003'), TOKEN_TTL_SECONDS);
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:uuid_0002', 'uuid_0003', REFRESH_TTL_SECONDS);

    // The auth code was consumed via GETDEL.
    assert.equal(redis.store.has('oauth:code:abc'), false);
  });

  it('rejects when code.client_id !== request client_id (binding violation)', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set('oauth:code:abc', {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      client_id: 'someone_else',
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp_pro',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'invalid_grant');
  });

  it('rejects when code.redirect_uri !== request redirect_uri', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set('oauth:code:abc', {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      client_id: CLIENT_ID,
      redirect_uri: 'https://attacker.example/callback',
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp_pro',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'invalid_grant');
  });

  it('rejects when PKCE verifier does not match challenge', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set('oauth:code:abc', {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: makeChallenge('different_verifier_'.padEnd(64, 'X')),
      scope: 'mcp_pro',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// authorization_code — legacy env-key path (regression guard)
// ---------------------------------------------------------------------------

describe('U6 tokenHandler — authorization_code (legacy)', () => {
  it('legacy code without `kind` writes bare-string hash; response scope defaults to mcp', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set('oauth:code:abc', {
      // NOTE: no `kind` field — this is the pre-U6 shape.
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp',
      api_key_hash: ENV_KEY_HASH,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 100;
    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.scope, 'mcp');

    // Access token record is a bare JSON-string of the SHA-256 hex.
    const accessRaw = redis.store.get('oauth:token:uuid_0101');
    const parsed = JSON.parse(accessRaw);
    assert.equal(typeof parsed, 'string');
    assert.equal(parsed.length, 64);
    assert.equal(parsed, ENV_KEY_HASH);

    // Refresh record carries the legacy {client_id, api_key_hash, scope, family_id} shape.
    const refresh = JSON.parse(redis.store.get('oauth:refresh:uuid_0102'));
    assert.equal(refresh.kind, undefined);
    assert.equal(refresh.client_id, CLIENT_ID);
    assert.equal(refresh.api_key_hash, ENV_KEY_HASH);
    assert.equal(refresh.scope, 'mcp');
    assert.equal(typeof refresh.family_id, 'string');
    assertSetEx(redis.ops, 'oauth:tokenfam:uuid_0101', JSON.stringify(refresh.family_id), TOKEN_TTL_SECONDS);
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:uuid_0102', refresh.family_id, REFRESH_TTL_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// refresh_token grant
// ---------------------------------------------------------------------------

describe('U6 tokenHandler — refresh_token (Pro)', () => {
  it('Pro refresh preserves kind, userId, mcpTokenId, scope, family_id', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    const FAMILY = 'family_original_xxx';
    redis.store.set('oauth:refresh:rt-1', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 200;
    const resp = await tokenHandler(
      makeReq('refresh_token', {
        refresh_token: 'rt-1',
        client_id: CLIENT_ID,
      }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.scope, 'mcp_pro');
    assert.equal(body.refresh_token, 'uuid_0202');

    // New access record is Pro object-shape.
    const access = JSON.parse(redis.store.get('oauth:token:uuid_0201'));
    assert.deepEqual(access, { kind: 'pro', userId: USER_ID, mcpTokenId: MCP_TOKEN_ID });

    // New refresh record preserves family_id (load-bearing for theft-revoke).
    const refresh = JSON.parse(redis.store.get('oauth:refresh:uuid_0202'));
    assert.equal(refresh.kind, 'pro');
    assert.equal(refresh.userId, USER_ID);
    assert.equal(refresh.mcpTokenId, MCP_TOKEN_ID);
    assert.equal(refresh.scope, 'mcp_pro');
    assert.equal(refresh.family_id, FAMILY); // PRESERVED across rotation
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-1', FAMILY, REFRESH_TTL_SECONDS);
    assertSetEx(redis.ops, 'oauth:tokenfam:uuid_0201', JSON.stringify(FAMILY), TOKEN_TTL_SECONDS);
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:uuid_0202', FAMILY, REFRESH_TTL_SECONDS);

    // Old refresh token consumed.
    assert.equal(redis.store.has('oauth:refresh:rt-1'), false);
  });

  it('Pro refresh fails invalid_grant when validateProMcpToken returns revoked', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps({ validateProMcpToken: async () => ({ ok: 'revoked' }) });
    redis.store.set('oauth:refresh:rt-1', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: 'fam',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-1', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error, 'invalid_grant');
    // Error description does NOT leak revocation specifically (avoids
    // probing). Same copy as expired/used.
    assert.match(body.error_description, /invalid, expired, or already used/);
  });

  it('F3: Pro refresh on Convex transient → 503 + Retry-After + refresh token preserved', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps({ validateProMcpToken: async () => ({ ok: 'transient' }) });
    redis.store.set('oauth:refresh:rt-1', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: 'fam',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-1', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 503, 'transient Convex failure → 503');
    const body = await resp.json();
    assert.equal(body.error, 'server_error');
    // F3: refresh token must be restored to Redis with the original payload.
    const restored = redis.store.get('oauth:refresh:rt-1');
    assert.ok(restored, 'refresh token MUST be restored on transient failure');
    // The restored value is a JSON string written via SET; parse before comparing.
    const restoredObj = typeof restored === 'string' ? JSON.parse(restored) : restored;
    assert.equal(restoredObj.kind, 'pro');
    assert.equal(restoredObj.userId, USER_ID);
    assert.equal(restoredObj.mcpTokenId, MCP_TOKEN_ID);
    assert.equal(restoredObj.family_id, 'fam');
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-1', 'fam', REFRESH_TTL_SECONDS);
  });

  it('Pro refresh rejects when client_id does not match', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set('oauth:refresh:rt-1', {
      kind: 'pro',
      client_id: 'other_client',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: 'fam',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-1', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'invalid_grant');
  });

  it('Pro refresh rejects when validate returns a different userId (defensive cross-user guard)', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps({
      validateProMcpToken: async () => ({ ok: 'valid', userId: 'somebody_else' }),
    });
    redis.store.set('oauth:refresh:rt-1', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: 'fam',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-1', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'invalid_grant');
  });
});

describe('U6 tokenHandler — refresh_token (legacy)', () => {
  it('legacy refresh continues to work; access record is bare-string hash; family_id preserved', async () => {
    await ensureFixtures();
    let validateCalls = 0;
    const { redis, deps } = makeDeps({
      validateProMcpToken: async () => {
        validateCalls += 1;
        return { ok: 'revoked' };
      },
    });
    const FAMILY = 'fam_legacy_aaa';
    redis.store.set('oauth:refresh:rt-old', {
      // No `kind` — legacy shape.
      client_id: CLIENT_ID,
      api_key_hash: ENV_KEY_HASH,
      scope: 'mcp',
      family_id: FAMILY,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 300;
    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-old', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.scope, 'mcp');

    // Pro validator was NOT called for a legacy refresh.
    assert.equal(validateCalls, 0);

    // New access is bare-string hash.
    const access = JSON.parse(redis.store.get('oauth:token:uuid_0301'));
    assert.equal(typeof access, 'string');
    assert.equal(access, ENV_KEY_HASH);

    // family_id preserved.
    const refresh = JSON.parse(redis.store.get('oauth:refresh:uuid_0302'));
    assert.equal(refresh.kind, undefined);
    assert.equal(refresh.api_key_hash, ENV_KEY_HASH);
    assert.equal(refresh.family_id, FAMILY);
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-old', FAMILY, REFRESH_TTL_SECONDS);
    assertSetEx(redis.ops, 'oauth:tokenfam:uuid_0301', JSON.stringify(FAMILY), TOKEN_TTL_SECONDS);
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:uuid_0302', FAMILY, REFRESH_TTL_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// refresh_token grant — reuse detection / family revocation (GHSA-f6gj)
// ---------------------------------------------------------------------------

describe('U6 tokenHandler — refresh-token reuse revokes the family (GHSA-f6gj)', () => {
  it('reuse of a rotated refresh token revokes the family, killing the attacker\'s rotated token', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    const FAMILY = 'fam_reuse_xyz';
    // A valid refresh token + its persistent family pointer (as the writers now emit).
    redis.store.set('oauth:refresh:rt-1', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-1', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 700;
    // (1) First redemption rotates rt-1 → a new token (attacker holds it).
    const r1 = await tokenHandler(makeReq('refresh_token', { refresh_token: 'rt-1', client_id: CLIENT_ID }), deps);
    assert.equal(r1.status, 200);
    const rotated = (await r1.json()).refresh_token;
    assert.equal(redis.store.has('oauth:refresh:rt-1'), false, 'rt-1 consumed by GETDEL');
    assert.ok(redis.store.has('oauth:famptr:rt-1'), 'family pointer survives rotation (enables reuse detection)');
    assert.ok(redis.store.has(`oauth:famptr:${rotated}`), 'rotated token also gets a family pointer');
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false, 'family not revoked yet');

    // (2) Victim replays the now-stale rt-1 → GETDEL-miss → REUSE → revoke family.
    const r2 = await tokenHandler(makeReq('refresh_token', { refresh_token: 'rt-1', client_id: CLIENT_ID }), deps);
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).error, 'invalid_grant');
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`), 'reuse of a rotated token must revoke the whole family');

    // (3) Attacker's rotated token is now rejected — family is revoked.
    const r3 = await tokenHandler(makeReq('refresh_token', { refresh_token: rotated, client_id: CLIENT_ID }), deps);
    assert.equal(r3.status, 400, 'a revoked family must not rotate — the attacker is contained');
    assert.equal((await r3.json()).error, 'invalid_grant');
  });

  it('pre-patch Pro refresh token with no pointer still backfills pointer and revokes on replay', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    const FAMILY = 'fam_prepatch_pro';
    redis.store.set('oauth:refresh:rt-old', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 800;
    const r1 = await tokenHandler(makeReq('refresh_token', { refresh_token: 'rt-old', client_id: CLIENT_ID }), deps);
    assert.equal(r1.status, 200);
    const rotated = (await r1.json()).refresh_token;
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-old', FAMILY, REFRESH_TTL_SECONDS);

    const r2 = await tokenHandler(makeReq('refresh_token', { refresh_token: 'rt-old', client_id: CLIENT_ID }), deps);
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).error, 'invalid_grant');
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`));

    const r3 = await tokenHandler(makeReq('refresh_token', { refresh_token: rotated, client_id: CLIENT_ID }), deps);
    assert.equal(r3.status, 400);
    assert.equal((await r3.json()).error, 'invalid_grant');
  });

  it('legacy refresh-token reuse revokes the family too', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    const FAMILY = 'fam_legacy_reuse';
    redis.store.set('oauth:refresh:rt-legacy', {
      client_id: CLIENT_ID,
      api_key_hash: ENV_KEY_HASH,
      scope: 'mcp',
      family_id: FAMILY,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 900;
    const r1 = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-legacy', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(r1.status, 200);
    const rotated = (await r1.json()).refresh_token;
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-legacy', FAMILY, REFRESH_TTL_SECONDS);

    const r2 = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-legacy', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).error, 'invalid_grant');
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`));

    const r3 = await tokenHandler(makeReq('refresh_token', { refresh_token: rotated, client_id: CLIENT_ID }), deps);
    assert.equal(r3.status, 400);
    assert.equal((await r3.json()).error, 'invalid_grant');
  });

  it('reuse detection returns retryable 503 when family revocation cannot be recorded', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalPipeline = redis.redisPipeline;
    redis.redisPipeline = async (commands) => {
      if (commands.some((cmd) => String(cmd[1]).startsWith('oauth:famrev:'))) return null;
      return originalPipeline(commands);
    };
    const { deps } = makeDeps({ redis });
    redis.store.set('oauth:famptr:rt-used', JSON.stringify('fam_write_fail'));

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-used', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 503);
    assert.equal((await resp.json()).error, 'server_error');
  });

  it('revocation-state read failure restores the consumed token and does not rotate', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    const FAMILY = 'fam_read_fail';
    redis.store.set('oauth:refresh:rt-live', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);
    const originalRedisGet = deps.redisGet;
    deps.redisGet = async (key) => {
      if (key === `oauth:famrev:${FAMILY}`) throw new Error('redis down');
      return originalRedisGet(key);
    };

    _uuidCounter = 950;
    const resp = await tokenHandler(makeReq('refresh_token', { refresh_token: 'rt-live', client_id: CLIENT_ID }), deps);
    assert.equal(resp.status, 503);
    assert.equal((await resp.json()).error, 'server_error');
    const restored = redis.store.get('oauth:refresh:rt-live');
    assert.ok(restored, 'refresh token is restored when revocation state is unknown');
    assert.equal(redis.store.has('oauth:token:uuid_0951'), false, 'must not mint a new access token');
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-live', FAMILY, REFRESH_TTL_SECONDS);
  });

  it('revocation-state read failure clears the pointer when the consumed token cannot be restored', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalPipeline = redis.redisPipeline;
    redis.redisPipeline = async (commands) => {
      if (commands.some((cmd) => cmd[1] === 'oauth:refresh:rt-read-fail')) return null;
      return originalPipeline(commands);
    };
    const { deps, restoreFailures } = makeDeps({ redis });
    const FAMILY = 'fam_read_restore_fail';
    redis.store.set('oauth:refresh:rt-read-fail', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-read-fail', JSON.stringify(FAMILY));
    const originalRedisGet = deps.redisGet;
    deps.redisGet = async (key) => {
      if (key === `oauth:famrev:${FAMILY}`) throw new Error('redis down');
      return originalRedisGet(key);
    };

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-read-fail', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 503);
    assert.equal(redis.store.has('oauth:famptr:rt-read-fail'), false);
    assert.deepEqual(restoreFailures, [
      { stage: 'read-family-revocation', familyPointerRemoved: true },
    ]);
  });

  it('family-pointer backfill failure clears the stale pointer when token restore also fails', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const { deps, restoreFailures } = makeDeps({ redis });
    const FAMILY = 'fam_backfill_restore_fail';
    redis.store.set('oauth:refresh:rt-backfill-fail', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-backfill-fail', JSON.stringify(FAMILY));
    deps.redisPipeline = async (commands) => {
      for (const cmd of commands) redis.ops.push({ kind: 'pipeline', cmd });
      return null;
    };

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-backfill-fail', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 503);
    assert.equal(redis.store.has('oauth:famptr:rt-backfill-fail'), false);
    assert.deepEqual(restoreFailures, [
      { stage: 'persist-family-pointer', familyPointerRemoved: true },
    ]);
  });

  it('transient Pro validation restores the refresh token and its family pointer together', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps({ validateProMcpToken: async () => ({ ok: 'transient' }) });
    const FAMILY = 'fam_transient_restore';
    redis.store.set('oauth:refresh:rt-transient', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-transient', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 503);
    assert.ok(redis.store.has('oauth:refresh:rt-transient'));
    assertFamilyPointerSetEx(redis.ops, 'oauth:famptr:rt-transient', FAMILY, REFRESH_TTL_SECONDS);
  });

  it('a failed transient restore removes the stale pointer so retry cannot revoke sibling sessions', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalPipeline = redis.redisPipeline;
    redis.redisPipeline = async (commands) => {
      const isFailedRestore = commands.some((cmd) => cmd[1] === 'oauth:refresh:rt-blip');
      if (isFailedRestore) return null;
      return originalPipeline(commands);
    };
    const { deps, restoreFailures } = makeDeps({
      redis,
      validateProMcpToken: async (mcpTokenId) => (
        mcpTokenId === 'mcp-blip'
          ? { ok: 'transient' }
          : { ok: 'valid', userId: USER_ID }
      ),
    });
    const FAMILY = 'fam_restore_blip';
    redis.store.set('oauth:refresh:rt-blip', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: 'mcp-blip',
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-blip', JSON.stringify(FAMILY));
    redis.store.set('oauth:refresh:rt-sibling', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: 'mcp-sibling',
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-sibling', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const first = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-blip', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(first.status, 503);
    assert.equal(redis.store.has('oauth:refresh:rt-blip'), false, 'failed restore leaves the token consumed');
    assert.equal(redis.store.has('oauth:famptr:rt-blip'), false, 'failed restore removes its stale reuse pointer');
    assert.deepEqual(restoreFailures, [
      { stage: 'convex-transient', familyPointerRemoved: true },
    ]);

    const retry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-blip', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(retry.status, 400);
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false, 'retry must not revoke the family');

    const sibling = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-sibling', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(sibling.status, 200, 'a sibling session in the family must still validate');
  });

  it('a partial restore that writes the token keeps replay evidence and remains retryable', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalPipeline = redis.redisPipeline;
    redis.redisPipeline = async (commands) => {
      const isPartialRestore = commands.length === 2 && commands[0]?.[1] === 'oauth:refresh:rt-partial';
      if (!isPartialRestore) return originalPipeline(commands);

      for (const cmd of commands) redis.ops.push({ kind: 'pipeline', cmd });
      redis.store.set(commands[0][1], commands[0][2]);
      return [{ result: 'OK' }, { error: 'pointer write failed' }];
    };
    let validationCalls = 0;
    const { deps, restoreFailures } = makeDeps({
      redis,
      validateProMcpToken: async () => {
        validationCalls += 1;
        return validationCalls === 1
          ? { ok: 'transient' }
          : { ok: 'valid', userId: USER_ID };
      },
    });
    const FAMILY = 'fam_partial_restore';
    redis.store.set('oauth:refresh:rt-partial', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-partial', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const first = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-partial', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(first.status, 503);
    assert.ok(redis.store.has('oauth:refresh:rt-partial'), 'partial pipeline restored the token record');
    assert.equal(
      redis.store.has('oauth:famptr:rt-partial'),
      true,
      'cleanup preserves replay evidence while the restored token exists',
    );
    assert.deepEqual(restoreFailures, [
      { stage: 'convex-transient', familyPointerRemoved: false },
    ]);

    const retry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-partial', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(retry.status, 200, 'the restored token remains usable after cleanup');
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false);
  });

  it('a lost restore response preserves replay evidence when Redis committed both records', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalPipeline = redis.redisPipeline;
    redis.redisPipeline = async (commands) => {
      const isRestore = commands.length === 2 && commands[0]?.[1] === 'oauth:refresh:rt-lost-response';
      if (!isRestore) return originalPipeline(commands);

      await originalPipeline(commands);
      throw new Error('response lost after Redis committed the restore');
    };
    let validationCalls = 0;
    const { deps, restoreFailures } = makeDeps({
      redis,
      validateProMcpToken: async () => {
        validationCalls += 1;
        return validationCalls === 1
          ? { ok: 'transient' }
          : { ok: 'valid', userId: USER_ID };
      },
    });
    const FAMILY = 'fam_lost_restore_response';
    redis.store.set('oauth:refresh:rt-lost-response', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-lost-response', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const first = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-lost-response', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(first.status, 503);
    assert.ok(redis.store.has('oauth:refresh:rt-lost-response'), 'Redis committed the restored token');
    assert.ok(
      redis.store.has('oauth:famptr:rt-lost-response'),
      'cleanup must preserve the pointer while the restored token exists',
    );
    assert.deepEqual(restoreFailures, [
      { stage: 'convex-transient', familyPointerRemoved: false },
    ]);

    const retry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-lost-response', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(retry.status, 200);
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false);
  });

  it('late failed-restore cleanup preserves a newer pointer written by a concurrent redemption', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalPipeline = redis.redisPipeline;
    redis.redisPipeline = async (commands) => {
      const isPartialRestore = commands.length === 2 && commands[0]?.[1] === 'oauth:refresh:rt-concurrent';
      if (!isPartialRestore) return originalPipeline(commands);

      for (const cmd of commands) redis.ops.push({ kind: 'pipeline', cmd });
      redis.store.set(commands[0][1], commands[0][2]);
      return [{ result: 'OK' }, { error: 'pointer write failed' }];
    };

    let signalCleanupStarted;
    const cleanupStarted = new Promise((resolve) => { signalCleanupStarted = resolve; });
    let releaseCleanup;
    const cleanupReleased = new Promise((resolve) => { releaseCleanup = resolve; });
    redis.redisCompareAndDeleteIfAbsent = async (key, expectedValue, absentKey) => {
      redis.ops.push({ kind: 'compare-delete', key, expectedValue, absentKey });
      signalCleanupStarted();
      await cleanupReleased;
      if (redis.store.has(absentKey)) return false;
      if (redis.store.get(key) !== expectedValue) return false;
      redis.store.delete(key);
      return true;
    };

    let validationCalls = 0;
    const { deps } = makeDeps({
      redis,
      validateProMcpToken: async () => {
        validationCalls += 1;
        return validationCalls === 1
          ? { ok: 'transient' }
          : { ok: 'valid', userId: USER_ID };
      },
    });
    const FAMILY = 'fam_concurrent_restore';
    redis.store.set('oauth:refresh:rt-concurrent', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-concurrent', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const failedRestore = tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-concurrent', client_id: CLIENT_ID }),
      deps,
    );
    await cleanupStarted;

    const concurrentRedemption = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-concurrent', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(concurrentRedemption.status, 200);

    releaseCleanup();
    assert.equal((await failedRestore).status, 503);
    assert.ok(
      redis.store.has('oauth:famptr:rt-concurrent'),
      'late cleanup must preserve the pointer advanced by the concurrent redemption',
    );

    const replay = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-concurrent', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(replay.status, 400);
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`), 'replay must still revoke the token family');
  });

  it('a genuine expired/unknown refresh token (no family pointer) does NOT revoke anything', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    // No oauth:refresh:* and no oauth:famptr:* for this token → plain miss.
    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'never-issued', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'invalid_grant');
    // No famrev marker created — a garbage token must not let an attacker
    // revoke an unrelated family by guessing token strings.
    const famrevKeys = [...redis.store.keys()].filter((k) => k.startsWith('oauth:famrev:'));
    assert.deepEqual(famrevKeys, [], 'a miss with no family pointer must not create a revocation marker');
  });
});

// ---------------------------------------------------------------------------
// resolveBearerToContext — discriminated-union resolver
// ---------------------------------------------------------------------------

describe('resolveBearerToContext (U6 resolver)', () => {
  // Stub fetch() so tests don't hit Upstash. The resolver percent-encodes
  // `oauth:token:<uuid>` so the pathname is `/get/oauth%3Atoken%3A<uuid>`.
  // Restores fetch + env on cleanup (env restoration prevents the
  // module-cached Ratelimit in api/oauth/token.ts from initialising
  // against this test URL on subsequent describe blocks).
  function withRedisGet(value) {
    const realFetch = globalThis.fetch;
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      const decoded = decodeURIComponent(u.pathname);
      const match = decoded.match(/^\/get\/(.+)$/);
      if (match) {
        const result = match[1].startsWith('oauth:token:') ? value : undefined;
        return new Response(JSON.stringify({ result: result === undefined ? null : result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    return () => {
      globalThis.fetch = realFetch;
      if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      if (savedTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
    };
  }

  it('returns null for null/empty/non-string bearer', async () => {
    assert.equal(await resolveBearerToContext(null), null);
    assert.equal(await resolveBearerToContext(''), null);
    assert.equal(await resolveBearerToContext(undefined), null);
  });

  it('returns kind:"env_key" for legacy 64-char SHA-256 bare-string', async () => {
    await ensureFixtures();
    process.env.WORLDMONITOR_VALID_KEYS = `${ENV_KEY},another_key`;
    const restore = withRedisGet(JSON.stringify(ENV_KEY_HASH));
    try {
      const ctx = await resolveBearerToContext('uuid-x');
      assert.deepEqual(ctx, { kind: 'env_key', apiKey: ENV_KEY });
    } finally {
      restore();
    }
  });

  it('returns kind:"env_key" for legacy 16-char fingerprint bare-string (client_credentials)', async () => {
    await ensureFixtures();
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    const restore = withRedisGet(JSON.stringify(ENV_KEY_FINGERPRINT));
    try {
      const ctx = await resolveBearerToContext('uuid-x');
      assert.deepEqual(ctx, { kind: 'env_key', apiKey: ENV_KEY });
    } finally {
      restore();
    }
  });

  it('returns kind:"pro" for object shape with valid userId + mcpTokenId', async () => {
    const restore = withRedisGet(
      JSON.stringify({ kind: 'pro', userId: USER_ID, mcpTokenId: MCP_TOKEN_ID }),
    );
    try {
      const ctx = await resolveBearerToContext('uuid-x');
      assert.deepEqual(ctx, {
        kind: 'pro',
        userId: USER_ID,
        mcpTokenId: MCP_TOKEN_ID,
      });
    } finally {
      restore();
    }
  });

  it('returns null for kind:"pro" with missing/empty userId', async () => {
    const restore = withRedisGet(
      JSON.stringify({ kind: 'pro', userId: '', mcpTokenId: MCP_TOKEN_ID }),
    );
    try {
      assert.equal(await resolveBearerToContext('uuid-x'), null);
    } finally {
      restore();
    }
  });

  it('returns null for kind:"pro" with missing mcpTokenId', async () => {
    const restore = withRedisGet(JSON.stringify({ kind: 'pro', userId: USER_ID }));
    try {
      assert.equal(await resolveBearerToContext('uuid-x'), null);
    } finally {
      restore();
    }
  });

  it('returns null for unknown kind:"future" (defensive against new shapes)', async () => {
    const restore = withRedisGet(
      JSON.stringify({ kind: 'unknown', userId: USER_ID, mcpTokenId: MCP_TOKEN_ID }),
    );
    try {
      assert.equal(await resolveBearerToContext('uuid-x'), null);
    } finally {
      restore();
    }
  });

  it('returns null for malformed JSON in Redis', async () => {
    const restore = withRedisGet('not-valid-json{');
    try {
      assert.equal(await resolveBearerToContext('uuid-x'), null);
    } finally {
      restore();
    }
  });

  it('returns null for Redis miss', async () => {
    const restore = withRedisGet(undefined); // result: null
    try {
      assert.equal(await resolveBearerToContext('uuid-x'), null);
    } finally {
      restore();
    }
  });

  it('returns null for bare-string of unrecognized length (not 16 or 64)', async () => {
    const restore = withRedisGet(JSON.stringify('abc')); // 3 chars
    try {
      assert.equal(await resolveBearerToContext('uuid-x'), null);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveApiKeyFromBearer — backward-compat wrapper
// ---------------------------------------------------------------------------

describe('resolveApiKeyFromBearer (legacy wrapper)', () => {
  function withRedisGet(value) {
    const realFetch = globalThis.fetch;
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      const decoded = decodeURIComponent(u.pathname);
      const match = decoded.match(/^\/get\/(.+)$/);
      if (match) {
        const result = match[1].startsWith('oauth:token:') ? value : undefined;
        return new Response(JSON.stringify({ result: result === undefined ? null : result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    return () => {
      globalThis.fetch = realFetch;
      if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      if (savedTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
    };
  }

  it('returns the cleartext api key for a legacy env-key bearer (backward compat)', async () => {
    await ensureFixtures();
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    const restore = withRedisGet(JSON.stringify(ENV_KEY_HASH));
    try {
      assert.equal(await resolveApiKeyFromBearer('uuid-x'), ENV_KEY);
    } finally {
      restore();
    }
  });

  it('returns null for a Pro bearer (legacy callers must not see Pro identity)', async () => {
    const restore = withRedisGet(
      JSON.stringify({ kind: 'pro', userId: USER_ID, mcpTokenId: MCP_TOKEN_ID }),
    );
    try {
      // Crucially NOT returning the userId or mcpTokenId — preserves the
      // legacy contract that the wrapper either yields a `wm_*` key string
      // or null. U7's MCP edge will switch to resolveBearerToContext.
      assert.equal(await resolveApiKeyFromBearer('uuid-x'), null);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip: write Pro token via tokenHandler → read via resolveBearerToContext.
// ---------------------------------------------------------------------------

describe('U6 round-trip — tokenHandler → resolveBearerToContext', () => {
  it('a Pro authorization_code exchange yields a token resolvable to {kind:"pro"}', async () => {
    await ensureFixtures();
    // Unset Upstash env so the production Ratelimit init returns null
    // (it's module-cached so this only matters on the first call).
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { redis, deps } = makeDeps();
    redis.store.set('oauth:code:abc', {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp_pro',
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 400;
    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    const accessUuid = body.access_token;

    // Stub the resolver's fetch to read directly from our test Redis store.
    const realFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      const decoded = decodeURIComponent(u.pathname);
      const match = decoded.match(/^\/get\/(.+)$/);
      if (match) {
        const stored = redis.store.get(match[1]);
        return new Response(JSON.stringify({ result: stored === undefined ? null : stored }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      const ctx = await resolveBearerToContext(accessUuid);
      assert.deepEqual(ctx, {
        kind: 'pro',
        userId: USER_ID,
        mcpTokenId: MCP_TOKEN_ID,
      });
      const familyId = JSON.parse(redis.store.get(`oauth:tokenfam:${accessUuid}`));
      redis.store.set(`oauth:famrev:${familyId}`, '1');
      assert.equal(await resolveBearerToContext(accessUuid), null, 'famrev must invalidate issued Pro access token');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a legacy authorization_code exchange yields a token resolvable to {kind:"env_key"}', async () => {
    await ensureFixtures();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    const { redis, deps } = makeDeps();
    redis.store.set('oauth:code:abc', {
      // Legacy shape — no kind.
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp',
      api_key_hash: ENV_KEY_HASH,
    });
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    _uuidCounter = 500;
    const resp = await tokenHandler(
      makeReq('authorization_code', {
        code: 'abc',
        code_verifier: CODE_VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    const accessUuid = body.access_token;

    const realFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      const decoded = decodeURIComponent(u.pathname);
      const match = decoded.match(/^\/get\/(.+)$/);
      if (match) {
        const stored = redis.store.get(match[1]);
        return new Response(JSON.stringify({ result: stored === undefined ? null : stored }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      const ctx = await resolveBearerToContext(accessUuid);
      assert.deepEqual(ctx, { kind: 'env_key', apiKey: ENV_KEY });
      const familyId = JSON.parse(redis.store.get(`oauth:tokenfam:${accessUuid}`));
      redis.store.set(`oauth:famrev:${familyId}`, '1');
      assert.equal(await resolveBearerToContext(accessUuid), null, 'famrev must invalidate issued legacy access token');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// client_credentials grant — regression guard (U6 must NOT touch this branch).
// ---------------------------------------------------------------------------

describe('U6 tokenHandler — client_credentials (regression guard)', () => {
  it('client_credentials writes 16-char fingerprint, scope:"mcp", no refresh_token', async () => {
    await ensureFixtures();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    const { redis, deps } = makeDeps();

    _uuidCounter = 600;
    const resp = await tokenHandler(
      makeReq('client_credentials', { client_secret: ENV_KEY }),
      deps,
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.scope, 'mcp');
    assert.equal(body.token_type, 'Bearer');
    // No refresh_token is issued by the legacy client_credentials grant.
    assert.equal(body.refresh_token, undefined);

    // Bare-string fingerprint (16 hex chars).
    const access = JSON.parse(redis.store.get(`oauth:token:${body.access_token}`));
    assert.equal(typeof access, 'string');
    assert.equal(access.length, 16);
    assert.equal(access, ENV_KEY_FINGERPRINT);
  });
});
