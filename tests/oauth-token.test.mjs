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
import { afterEach, beforeEach, describe, it } from 'node:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  tokenHandler,
  __resetOAuthTokenRateLimitForTest,
  __setOAuthTokenRatelimitForTest,
} from '../api/oauth/token.ts';
import {
  REFRESH_ATTEMPT_TTL_SECONDS,
  rawRedisBeginRefreshAttempt,
  rawRedisFinalizeRefreshAttempt,
  rawRedisProtectFailedRefreshAttempt,
  rawRedisRestoreRefreshAttempt,
} from '../api/oauth/_refresh-recovery.ts';
import {
  resolveBearerToContext,
  resolveApiKeyFromBearer,
} from '../api/_oauth-token.js';
import { sha256Hex, keyFingerprint } from '../api/_crypto.js';

beforeEach(() => {
  // Existing tokenHandler cases inject Redis deps. They must not share a
  // process-level Upstash limiter: this file reuses `client_abc`, and a
  // credentialed agent/CI environment would 429 later cases after 10 POSTs.
  __setOAuthTokenRatelimitForTest({
    limit: async () => ({ success: true }),
  });
});

afterEach(() => {
  __resetOAuthTokenRateLimitForTest();
});

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
  const parseStored = (value) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
  };
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
    redisBeginRefreshAttempt: async (refreshToken, attemptId) => {
      const refreshKey = `oauth:refresh:${refreshToken}`;
      const attemptKey = `oauth:famattempt:${refreshToken}`;
      const pointerKey = `oauth:famptr:${refreshToken}`;
      const attemptValue = JSON.stringify({ attempt_id: attemptId });
      const attemptMarker = JSON.stringify({ kind: 'refresh_attempt', attempt_id: attemptId });
      ops.push({ kind: 'begin-refresh-attempt', refreshToken, attemptValue });
      if (store.has(refreshKey)) {
        const refreshData = parseStored(store.get(refreshKey));
        if (refreshData?.kind === 'refresh_attempt') {
          return {
            kind: 'miss',
            recoveryPending: store.has(attemptKey),
            familyId: parseStored(store.get(pointerKey))?.family_id ?? parseStored(store.get(pointerKey)) ?? null,
          };
        }
        store.set(attemptKey, attemptValue);
        store.set(refreshKey, attemptMarker);
        return { kind: 'consumed', refreshData, attemptValue };
      }
      return {
        kind: 'miss',
        recoveryPending: store.has(attemptKey),
        familyId: parseStored(store.get(pointerKey))?.family_id ?? parseStored(store.get(pointerKey)) ?? null,
      };
    },
    redisRestoreRefreshAttempt: async (refreshToken, attemptValue, refreshData, familyId) => {
      const attemptKey = `oauth:famattempt:${refreshToken}`;
      ops.push({ kind: 'restore-refresh-attempt', refreshToken, attemptValue });
      if (store.get(attemptKey) !== attemptValue) return false;
      store.set(`oauth:refresh:${refreshToken}`, JSON.stringify(refreshData));
      if (familyId) store.set(`oauth:famptr:${refreshToken}`, JSON.stringify(familyId));
      store.delete(attemptKey);
      return true;
    },
    redisFinalizeRefreshAttempt: async (refreshToken, attemptValue) => {
      const attemptKey = `oauth:famattempt:${refreshToken}`;
      ops.push({ kind: 'finalize-refresh-attempt', refreshToken, attemptValue });
      if (store.get(attemptKey) !== attemptValue) return false;
      const marker = parseStored(store.get(`oauth:refresh:${refreshToken}`));
      if (marker?.kind === 'refresh_attempt') store.delete(`oauth:refresh:${refreshToken}`);
      store.delete(attemptKey);
      return true;
    },
    redisProtectFailedRefreshAttempt: async (refreshToken, attemptValue) => {
      const attemptKey = `oauth:famattempt:${refreshToken}`;
      ops.push({ kind: 'protect-failed-refresh-attempt', refreshToken, attemptValue });
      if (store.get(attemptKey) !== attemptValue) return false;
      const { attempt_id: attemptId } = JSON.parse(attemptValue);
      store.set(attemptKey, JSON.stringify({ attempt_id: attemptId, state: 'failed' }));
      store.set(
        `oauth:famptr:${refreshToken}`,
        JSON.stringify({ kind: 'refresh_recovery_failed', attempt_id: attemptId }),
      );
      const refreshKey = `oauth:refresh:${refreshToken}`;
      const currentRefresh = parseStored(store.get(refreshKey));
      if (!currentRefresh || currentRefresh.kind === 'refresh_attempt') {
        store.set(refreshKey, JSON.stringify({ kind: 'refresh_attempt', attempt_id: attemptId }));
      }
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
  assert.equal(pointer, expectedFamilyId, 'family pointers must remain legacy JSON strings');
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
      redisBeginRefreshAttempt: redis.redisBeginRefreshAttempt,
      redisRestoreRefreshAttempt: redis.redisRestoreRefreshAttempt,
      redisFinalizeRefreshAttempt: redis.redisFinalizeRefreshAttempt,
      redisProtectFailedRefreshAttempt: redis.redisProtectFailedRefreshAttempt,
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

describe('OAuth Redis refresh-attempt production contract', () => {
  it('atomically consumes a refresh token and creates a short-lived attempt', async () => {
    const realFetch = globalThis.fetch;
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ result: [1, JSON.stringify({ family_id: 'fam-contract' })] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const result = await rawRedisBeginRefreshAttempt('rt-contract', 'attempt-contract');
      assert.deepEqual(result, {
        kind: 'consumed',
        refreshData: { family_id: 'fam-contract' },
        attemptValue: JSON.stringify({ attempt_id: 'attempt-contract' }),
      });
      assert.equal(calls[0].url, 'https://test.upstash.io/');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
      assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
      assert.equal(calls[0].init.headers['User-Agent'], 'worldmonitor-edge/1.0');
      const command = JSON.parse(calls[0].init.body);
      assert.equal(command[0], 'EVAL');
      assert.equal(command[2], '3');
      assert.equal(command[3], 'oauth:refresh:rt-contract');
      assert.equal(command[4], 'oauth:famattempt:rt-contract');
      assert.equal(command[5], 'oauth:famptr:rt-contract');
      assert.equal(command[6], JSON.stringify({ attempt_id: 'attempt-contract' }));
      assert.deepEqual(JSON.parse(command[7]), { kind: 'refresh_attempt', attempt_id: 'attempt-contract' });
      assert.equal(command[8], REFRESH_ATTEMPT_TTL_SECONDS);
    } finally {
      globalThis.fetch = realFetch;
      if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    }
  });

  it('uses fenced EVAL transitions for restore, finalize, and failed recovery protection', async () => {
    const realFetch = globalThis.fetch;
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ result: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const attemptValue = JSON.stringify({ attempt_id: 'attempt-contract' });
    try {
      assert.equal(
        await rawRedisRestoreRefreshAttempt(
          'rt-contract',
          attemptValue,
          { family_id: 'fam-contract' },
          'fam-contract',
        ),
        true,
      );
      assert.equal(await rawRedisFinalizeRefreshAttempt('rt-contract', attemptValue), true);
      assert.equal(await rawRedisProtectFailedRefreshAttempt('rt-contract', attemptValue), true);

      const restore = JSON.parse(calls[0].init.body);
      assert.equal(restore[0], 'EVAL');
      assert.deepEqual(restore.slice(3, 6), [
        'oauth:refresh:rt-contract',
        'oauth:famptr:rt-contract',
        'oauth:famattempt:rt-contract',
      ]);
      assert.equal(restore[8], JSON.stringify('fam-contract'));

      const finalize = JSON.parse(calls[1].init.body);
      assert.deepEqual(finalize.slice(2, 5), [
        '2',
        'oauth:refresh:rt-contract',
        'oauth:famattempt:rt-contract',
      ]);
      assert.equal(finalize[5], attemptValue);
      assert.equal(JSON.parse(finalize[6]).kind, 'refresh_attempt');

      const protect = JSON.parse(calls[2].init.body);
      assert.equal(protect[2], '3');
      assert.equal(protect[3], 'oauth:refresh:rt-contract');
      assert.equal(protect[4], 'oauth:famattempt:rt-contract');
      assert.equal(protect[5], 'oauth:famptr:rt-contract');
      assert.equal(protect[6], attemptValue);
      assert.equal(JSON.parse(protect[7]).state, 'failed');
      assert.equal(JSON.parse(protect[8]).kind, 'refresh_attempt');
      assert.equal(JSON.parse(protect[9]).kind, 'refresh_recovery_failed');
      assert.equal(protect[10], REFRESH_TTL_SECONDS);
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
    assert.equal(
      JSON.parse(redis.store.get('oauth:famptr:rt-1')),
      FAMILY,
      'the merge-base handler must parse the pointer as a legacy family-id string after rollback',
    );
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

  it('reads object pointers from the prior deployment but only writes rollback-safe strings', async () => {
    await ensureFixtures();
    const { redis, deps } = makeDeps();
    const FAMILY = 'fam_prior_object_pointer';
    redis.store.set(
      'oauth:famptr:rt-prior-object',
      JSON.stringify({ family_id: FAMILY, pointer_id: 'prior-attempt' }),
    );

    const resp = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-prior-object', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(resp.status, 400);
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`));
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

  it('revocation-state read failure protects the attempt when the consumed token cannot be restored', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    redis.redisRestoreRefreshAttempt = async () => false;
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
    assert.equal(JSON.parse(redis.store.get('oauth:famptr:rt-read-fail')).kind, 'refresh_recovery_failed');
    assert.equal(JSON.parse(redis.store.get('oauth:famattempt:rt-read-fail')).state, 'failed');
    assert.deepEqual(restoreFailures, [
      { stage: 'read-family-revocation' },
    ]);
  });

  it('family-pointer preclaim failure leaves the token and pointer untouched', async () => {
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
    assert.equal(redis.store.has('oauth:refresh:rt-backfill-fail'), true);
    assert.equal(redis.store.has('oauth:famptr:rt-backfill-fail'), true);
    assert.deepEqual(restoreFailures, []);
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

  it('a failed transient restore protects the attempt so retry cannot revoke sibling sessions', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    redis.redisRestoreRefreshAttempt = async () => false;
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
    assert.deepEqual(JSON.parse(redis.store.get('oauth:refresh:rt-blip')), {
      kind: 'refresh_attempt',
      attempt_id: JSON.parse(redis.store.get('oauth:famattempt:rt-blip')).attempt_id,
    });
    assert.equal(JSON.parse(redis.store.get('oauth:famptr:rt-blip')).kind, 'refresh_recovery_failed');
    assert.equal(JSON.parse(redis.store.get('oauth:famattempt:rt-blip')).state, 'failed');
    assert.deepEqual(restoreFailures, [
      { stage: 'convex-transient' },
    ]);

    // A rollback handler consumes the marker on its first retry. The failed
    // recovery tombstone contains no family id, so later rollback retries also
    // cannot revoke sibling sessions.
    assert.equal((await redis.redisGetDel('oauth:refresh:rt-blip')).kind, 'refresh_attempt');
    assert.equal(JSON.parse(redis.store.get('oauth:famptr:rt-blip')).family_id, undefined);

    const retry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-blip', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(retry.status, 503);
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
    const originalRestore = redis.redisRestoreRefreshAttempt;
    redis.redisRestoreRefreshAttempt = async (refreshToken, _attemptValue, refreshData) => {
      redis.store.set(`oauth:refresh:${refreshToken}`, JSON.stringify(refreshData));
      return false;
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
      { stage: 'convex-transient' },
    ]);

    const retry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-partial', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(retry.status, 200, 'the restored token remains usable after cleanup');
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false);
    redis.redisRestoreRefreshAttempt = originalRestore;
  });

  it('a lost restore response preserves replay evidence when Redis committed both records', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalRestore = redis.redisRestoreRefreshAttempt;
    redis.redisRestoreRefreshAttempt = async (...args) => {
      await originalRestore(...args);
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
      { stage: 'convex-transient' },
    ]);

    const retry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-lost-response', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(retry.status, 200);
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false);
  });

  it('an in-flight concurrent retry does not revoke, but replay after success still does', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    let signalValidationStarted;
    const validationStarted = new Promise((resolve) => { signalValidationStarted = resolve; });
    let releaseValidation;
    const validationReleased = new Promise((resolve) => { releaseValidation = resolve; });
    const { deps } = makeDeps({
      redis,
      validateProMcpToken: async () => {
        signalValidationStarted();
        await validationReleased;
        return { ok: 'valid', userId: USER_ID };
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

    const firstRedemption = tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-concurrent', client_id: CLIENT_ID }),
      deps,
    );
    await validationStarted;

    const concurrentRetry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-concurrent', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(concurrentRetry.status, 503);
    assert.equal(
      redis.store.has(`oauth:famrev:${FAMILY}`),
      false,
      'an active recovery attempt must suppress family revocation',
    );

    // A merge-base handler ignores famattempt, but its GETDEL sees this marker
    // as a consumed record rather than a miss. It therefore returns an opaque
    // grant error instead of revoking the family during a mixed deployment.
    const rollbackRead = await redis.redisGetDel('oauth:refresh:rt-concurrent');
    assert.equal(rollbackRead.kind, 'refresh_attempt');
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false);

    releaseValidation();
    assert.equal((await firstRedemption).status, 200);
    assert.equal(redis.store.has('oauth:famattempt:rt-concurrent'), false);

    const replay = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-concurrent', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(replay.status, 400);
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`), 'replay must still revoke the token family');
  });

  it('a failed finalization cannot report success or create a refresh-TTL replay blind spot', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    redis.redisFinalizeRefreshAttempt = async () => false;
    const { deps } = makeDeps({ redis });
    const FAMILY = 'fam_finalize_failure';
    redis.store.set('oauth:refresh:rt-finalize-fail', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-finalize-fail', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const rotation = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-finalize-fail', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(rotation.status, 503, 'the handler must not report a successful rotation without finalization');
    assert.ok(redis.store.has('oauth:famattempt:rt-finalize-fail'));
    assert.equal(redis.store.get('oauth:famptr:rt-finalize-fail'), JSON.stringify(FAMILY));

    const immediateRetry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-finalize-fail', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(immediateRetry.status, 503);
    assert.equal(redis.store.has(`oauth:famrev:${FAMILY}`), false);

    // Production gives ordinary in-flight attempts a 60-second TTL. Once it
    // expires, the canonical legacy pointer resumes normal replay detection.
    redis.store.delete('oauth:famattempt:rt-finalize-fail');
    const afterAttemptExpiry = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-finalize-fail', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(afterAttemptExpiry.status, 400);
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`));
  });

  it('a lost finalization response resumes replay detection immediately', async () => {
    await ensureFixtures();
    const redis = makeRedis();
    const originalFinalize = redis.redisFinalizeRefreshAttempt;
    redis.redisFinalizeRefreshAttempt = async (...args) => {
      await originalFinalize(...args);
      throw new Error('response lost after Redis committed finalization');
    };
    const { deps } = makeDeps({ redis });
    const FAMILY = 'fam_finalize_response_lost';
    redis.store.set('oauth:refresh:rt-finalize-lost', {
      kind: 'pro',
      client_id: CLIENT_ID,
      userId: USER_ID,
      mcpTokenId: MCP_TOKEN_ID,
      scope: 'mcp_pro',
      family_id: FAMILY,
    });
    redis.store.set('oauth:famptr:rt-finalize-lost', JSON.stringify(FAMILY));
    redis.store.set(`oauth:client:${CLIENT_ID}`, CLIENT_RECORD);

    const rotation = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-finalize-lost', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(rotation.status, 503);
    assert.equal(redis.store.has('oauth:famattempt:rt-finalize-lost'), false);
    assert.equal(redis.store.has('oauth:refresh:rt-finalize-lost'), false);
    assert.equal(redis.store.get('oauth:famptr:rt-finalize-lost'), JSON.stringify(FAMILY));

    const replay = await tokenHandler(
      makeReq('refresh_token', { refresh_token: 'rt-finalize-lost', client_id: CLIENT_ID }),
      deps,
    );
    assert.equal(replay.status, 400);
    assert.ok(redis.store.has(`oauth:famrev:${FAMILY}`));
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

// ---------------------------------------------------------------------------
// Rate-limit degradation observability (#7270)
// ---------------------------------------------------------------------------

describe('oauth/token rate-limit degradation (#7270)', () => {
  const originalEnv = { ...process.env };
  const originalConsoleError = console.error;
  const originalFetch = globalThis.fetch;
  let consoleErrors = [];

  function restoreEnv() {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }

  function makeWaitUntilCtx() {
    const pending = [];
    return {
      ctx: { waitUntil: (promise) => pending.push(promise) },
      settle: async () => Promise.allSettled(pending),
    };
  }

  beforeEach(() => {
    consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '));
    };
    __resetOAuthTokenRateLimitForTest();
  });

  afterEach(() => {
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
    __resetOAuthTokenRateLimitForTest();
    restoreEnv();
  });

  it('source contract: missing-config and throw paths capture with a stable fingerprint', () => {
    const src = readFileSync(fileURLToPath(new URL('../api/oauth/token.ts', import.meta.url)), 'utf8');
    assert.match(src, /oauthToken:missing-config/);
    assert.match(
      src,
      /fingerprint:\s*\['rate-limit',\s*'redis-error',\s*rateLimitFingerprintStage\(stage\)\]/,
    );
    assert.match(src, /X-RateLimit-Mode',\s*'degraded'/);
    assert.match(src, /emitOAuthTokenUsage/);
    assert.match(src, /captureSilentError\(sanitized,/);
  });

  it('missing Upstash config fail-opens every grant type with a degraded marker and one ops log', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const cases = [
      { grant: 'authorization_code', params: {}, status: 400 },
      { grant: 'refresh_token', params: {}, status: 400 },
      { grant: 'client_credentials', params: {}, status: 401 },
    ];
    for (const { grant, params, status } of cases) {
      const { deps } = makeDeps();
      const resp = await tokenHandler(makeReq(grant, params), deps);
      assert.equal(resp.status, status, `${grant} must remain fail-open (not 503)`);
      assert.equal(resp.headers.get('X-RateLimit-Mode'), 'degraded', `${grant} must carry the degraded marker`);
      assert.match(
        resp.headers.get('Access-Control-Expose-Headers') ?? '',
        /\bX-RateLimit-Mode\b/,
        `${grant} must expose X-RateLimit-Mode so cross-origin JS can read the marker`,
      );
      assert.notEqual(resp.status, 429);
    }

    const degradedLogs = consoleErrors.filter((line) =>
      line.includes('[rate-limit] redis-error') && line.includes('stage=oauthToken:missing-config'),
    );
    assert.equal(degradedLogs.length, 1, 'missing-config ops signal must be deduplicated per isolate');
  });

  it('limiter throw fail-opens with a degraded marker and does not log secrets', async () => {
    const secret = 'wm_super_secret_value_xyz';
    const clientId = 'full-client-identifier-must-not-log';
    __setOAuthTokenRatelimitForTest({
      limit: async () => {
        throw new Error('upstash unreachable');
      },
    });
    const { deps } = makeDeps();
    const resp = await tokenHandler(
      makeReq('client_credentials', { client_secret: secret, client_id: clientId }),
      deps,
    );
    assert.equal(resp.status, 401, 'throw path must fail open into credential validation, not 503');
    assert.equal(resp.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.ok(
      consoleErrors.some((line) => line.includes('[rate-limit] redis-error') && line.includes('stage=oauthToken')),
      `expected throw-path ops log, got: ${consoleErrors.join('\n')}`,
    );
    const joined = consoleErrors.join('\n');
    assert.equal(joined.includes(secret), false, 'client_secret must not appear in ops logs');
    assert.equal(joined.includes(clientId), false, 'full client_id must not appear in ops logs');
  });

  it('redacts full client_id from Upstash command-key errors before log and Sentry', async () => {
    const clientId = 'full-client-identifier-must-not-log';
    const upstashMsg = `ERR Error running script, command was: ${JSON.stringify([
      'evalsha',
      'deadbeef',
      '1',
      `rl:oauth-token:cid:${clientId}`,
      `rl:oauth-token:cid:${clientId}:1`,
    ])}`;
    __setOAuthTokenRatelimitForTest({
      limit: async () => {
        throw new Error(upstashMsg);
      },
    });
    const { deps } = makeDeps();
    const resp = await tokenHandler(
      makeReq('authorization_code', { client_id: clientId }),
      deps,
    );
    assert.equal(resp.status, 400, 'throw path must fail open, not 503');
    assert.equal(resp.headers.get('X-RateLimit-Mode'), 'degraded');
    const joined = consoleErrors.join('\n');
    assert.ok(
      consoleErrors.some((line) => line.includes('[rate-limit] redis-error') && line.includes('stage=oauthToken')),
      `expected throw-path ops log, got: ${joined}`,
    );
    assert.equal(joined.includes(clientId), false, 'full client_id must not appear in ops logs');
    assert.ok(
      joined.includes('rl:oauth-token:<redacted>'),
      `expected identifier-bearing keys to be redacted, got: ${joined}`,
    );
    const src = readFileSync(fileURLToPath(new URL('../api/oauth/token.ts', import.meta.url)), 'utf8');
    assert.match(
      src,
      /const sanitized = sanitizeTokenRateLimitError\(err\)/,
      'Sentry must receive the sanitized Error, not the original Upstash error',
    );
    assert.match(src, /captureSilentError\(sanitized,/);
  });

  it('limiter timeout reason fail-opens as degraded, not as a silent allow', async () => {
    __setOAuthTokenRatelimitForTest({
      limit: async () => ({ success: true, reason: 'timeout' }),
    });
    const { deps } = makeDeps();
    const resp = await tokenHandler(makeReq('unsupported', {}), deps);
    assert.equal(resp.status, 400);
    assert.equal(resp.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.ok(
      consoleErrors.some((line) => line.includes('stage=oauthToken:timeout')),
      `expected timeout degraded log, got: ${consoleErrors.join('\n')}`,
    );
  });

  it('limiter rejection returns 429 without a degraded marker', async () => {
    __setOAuthTokenRatelimitForTest({
      limit: async () => ({ success: false }),
    });
    const { deps } = makeDeps();
    const resp = await tokenHandler(makeReq('client_credentials', { client_secret: 'x' }), deps);
    assert.equal(resp.status, 429);
    const body = await resp.json();
    assert.equal(body.error, 'rate_limit_exceeded');
    assert.equal(resp.headers.get('X-RateLimit-Mode'), null);
    assert.ok(
      !consoleErrors.some((line) => line.includes('[rate-limit] redis-error')),
      `healthy 429 must not look like limiter degradation: ${consoleErrors.join(' | ')}`,
    );
  });

  it('healthy limiter headroom does not mark the response degraded', async () => {
    __setOAuthTokenRatelimitForTest({
      limit: async () => ({ success: true }),
    });
    const { deps } = makeDeps();
    const resp = await tokenHandler(makeReq('unsupported', {}), deps);
    assert.equal(resp.status, 400);
    assert.equal(resp.headers.get('X-RateLimit-Mode'), null);
    assert.ok(
      !consoleErrors.some((line) => line.includes('[rate-limit] redis-error')),
      `granted headroom must not log redis-error: ${consoleErrors.join(' | ')}`,
    );
  });

  it('degraded fail-open emits a usage event without credentials', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'axiom-test-token';
    const events = [];
    const deliveryHeaders = [];
    globalThis.fetch = async (_input, init) => {
      deliveryHeaders.push(init.headers);
      events.push(...JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    };
    const { ctx, settle } = makeWaitUntilCtx();
    const { deps } = makeDeps();
    const secret = 'wm_must_not_reach_axiom';
    const resp = await tokenHandler(
      makeReq('client_credentials', { client_secret: secret }),
      { ...deps, ctx },
    );
    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('X-RateLimit-Mode'), 'degraded');
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].route, '/api/oauth/token');
    assert.equal(events[0].reason, 'rate_limit_degraded');
    assert.equal(events[0].status, 401);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(Object.hasOwn(events[0], 'client_secret'), false);
    assert.equal(Object.hasOwn(events[0], 'client_id'), false);
    assert.equal(deliveryHeaders.length, 1);
    assert.equal(deliveryHeaders[0]['User-Agent'], 'worldmonitor-edge/1.0');
  });

  it('limiter 429 emits usage reason rate_limit_429', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'axiom-test-token';
    __setOAuthTokenRatelimitForTest({
      limit: async () => ({ success: false }),
    });
    const events = [];
    const deliveryHeaders = [];
    globalThis.fetch = async (_input, init) => {
      deliveryHeaders.push(init.headers);
      events.push(...JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    };
    const { ctx, settle } = makeWaitUntilCtx();
    const { deps } = makeDeps();
    const resp = await tokenHandler(makeReq('unsupported', {}), { ...deps, ctx });
    assert.equal(resp.status, 429);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'rate_limit_429');
    assert.equal(events[0].route, '/api/oauth/token');
    assert.equal(deliveryHeaders.length, 1);
    assert.equal(deliveryHeaders[0]['User-Agent'], 'worldmonitor-edge/1.0');
  });
});
