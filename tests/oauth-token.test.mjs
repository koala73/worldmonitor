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

import { tokenHandler } from '../api/oauth/token.ts';
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
      return v ?? null;
    },
    redisGet: async (key) => {
      ops.push({ kind: 'get', key });
      return store.get(key) ?? null;
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

let _uuidCounter = 0;
function deterministicUuid() {
  _uuidCounter += 1;
  return `uuid_${String(_uuidCounter).padStart(4, '0')}`;
}

function makeDeps(overrides = {}) {
  const redis = overrides.redis ?? makeRedis();
  return {
    redis, // for assertions (not part of TokenHandlerDeps)
    deps: {
      redisGetDel: redis.redisGetDel,
      redisGet: redis.redisGet,
      redisPipeline: redis.redisPipeline,
      // F3 (U7+U8 review pass): validateProMcpToken now returns the
      // ProMcpValidateUnion. Tests passing `null` are normalised here to
      // `{ok:'revoked'}` so the existing assertions remain meaningful;
      // tests passing the new shape pass through unchanged.
      validateProMcpToken: overrides.validateProMcpToken ?? (async () => ({ ok: 'valid', userId: USER_ID })),
      randomUuid: overrides.randomUuid ?? deterministicUuid,
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
      if (decodeURIComponent(u.pathname).startsWith('/get/oauth:token:')) {
        return new Response(JSON.stringify({ result: value === undefined ? null : value }), {
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
      if (decodeURIComponent(u.pathname).startsWith('/get/oauth:token:')) {
        return new Response(JSON.stringify({ result: value === undefined ? null : value }), {
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
