// #7818 — a per-minute rate-limit denial must echo the caller's JSON-RPC id.
//
// The defect: `applyAnonDiscoveryLimit` and `applyPerMinuteLimit` built their
// -32029 envelope with a hardcoded `null` id, even though every POST caller had
// already parsed and validated `body.id`. An MCP client parses the response
// through the spec's `JSONRPCMessage` union, where `RequestId = string |
// number`; a null id matches no member, so the client reports `invalid_union` /
// "Invalid input: expected string, received null" and cannot associate the
// denial with its pending request. That is what the 2026-09-06 Ora scan saw.
//
// These tests drive the PRODUCTION handler (`api/mcp/handler.ts`) with the real
// limiter path, forcing a denial by stubbing only the Upstash sliding-window
// backend. Nothing here manufactures a response: every envelope asserted below
// is built by `rpcError` inside `api/mcp/auth.ts`.
//
// Test seam: `Ratelimit.slidingWindow` is a writable STATIC whose returned
// factory is what a `Ratelimit` instance delegates `limit()` to, so overriding
// it intercepts the decision before any Redis I/O. The three limiter singletons
// in auth.ts are memoized, so the stub is installed ONCE (before any test can
// construct one) and each test selects which limiter denies by mutating
// `deniedKeyPrefixes` — a decision read at call time, never captured at
// construction time.
import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { Ratelimit } from '@upstash/ratelimit';

import { mcpHandler } from '../api/mcp/handler.ts';
import {
  applyAnonDiscoveryLimit,
  applyPerMinuteLimit,
} from '../api/mcp/auth.ts';
import { HMAC_SECRET, PRO_BEARER, makeProDeps } from './helpers/mcp-pro-deps.mjs';
import { assertJsonRpcError, assertJsonRpcResult } from './helpers/mcp-jsonrpc-schema.mjs';

const BASE_URL = 'https://worldmonitor.app/mcp';
const ENV_KEY = 'wm_env_operator_key_7818';
// Named in the Ora failure list; a `ui://` read is anonymous-servable, so it
// reaches the discovery limiter with no credentials at all.
const UI_RESOURCE_URI = 'ui://worldmonitor/country-risk.html';

// Full Redis keys are `${prefix}:${identifier}`; each entry below therefore
// names exactly one limiter. `rl:mcp:key:` (not `rl:mcp:`) isolates the env-key
// limiter, whose prefix is a prefix of every other limiter's.
const ANON_KEYS = 'rl:mcp:anon:';
const PRO_MIN_KEYS = 'rl:mcp:pro-min:';
const ENV_KEY_KEYS = 'rl:mcp:key:';

const originalEnv = { ...process.env };
const ORIGINAL_SLIDING_WINDOW = Ratelimit.slidingWindow;

/** Key prefixes the stubbed limiter denies. Mutated per test. */
let deniedKeyPrefixes = [];
let limiterCalls = [];

function anonPost(body, headers = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.42', ...headers },
    body: JSON.stringify(body),
  });
}

function readBody(id) {
  return { jsonrpc: '2.0', id, method: 'resources/read', params: { uri: UI_RESOURCE_URI } };
}

before(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'test-convex-shared-secret';
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, key) {
      limiterCalls.push({ key, tokens, window });
      const denied = deniedKeyPrefixes.some((prefix) => key.startsWith(prefix));
      return {
        success: !denied,
        limit: tokens,
        remaining: denied ? 0 : tokens - 1,
        reset: Date.now() + 60_000,
        pending: Promise.resolve(),
      };
    },
  });
});

after(() => {
  Ratelimit.slidingWindow = ORIGINAL_SLIDING_WINDOW;
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

beforeEach(() => {
  deniedKeyPrefixes = [];
  limiterCalls = [];
});

// ---------------------------------------------------------------------------
// Anonymous discovery limiter — the branch the Ora scanner hits
// ---------------------------------------------------------------------------

describe('#7818 — anonymous discovery denials correlate to the request', () => {
  // Both the string and the numeric arm of the spec's `RequestId` union, plus
  // zero: a truthiness-based default (`id || null`) passes for 7 and 'read-1'
  // and silently nulls 0, so 0 is the case that isolates that mistake.
  const IDS = [
    { label: 'string id', id: 'ora-read-1' },
    { label: 'numeric id', id: 7 },
    { label: 'numeric id 0 (falsy, must survive)', id: 0 },
  ];

  for (const { label, id } of IDS) {
    it(`resources/read of a ui:// shell — ${label} survives a forced -32029`, async () => {
      deniedKeyPrefixes = [ANON_KEYS];
      const res = await mcpHandler(anonPost(readBody(id)));
      assert.equal(res.status, 200, 'JSON-RPC errors ride HTTP 200 on this surface');
      assertJsonRpcError(await res.json(), { id, code: -32029, label: 'anon resources/read denial' });
      assert.ok(
        limiterCalls.some((c) => c.key.startsWith(ANON_KEYS)),
        'the real anonymous discovery limiter must be the one that rejected',
      );
    });

    it(`tools/list (second public discovery method) — ${label} survives a forced -32029`, async () => {
      deniedKeyPrefixes = [ANON_KEYS];
      const res = await mcpHandler(anonPost({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }));
      assertJsonRpcError(await res.json(), { id, code: -32029, label: 'anon tools/list denial' });
    });
  }

  it('keeps the denial message, CORS and no-store unchanged', async () => {
    deniedKeyPrefixes = [ANON_KEYS];
    const res = await mcpHandler(anonPost(readBody('headers-1'), { Origin: 'https://example.com' }));
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const body = await res.json();
    assert.equal(
      body.error.message,
      'Rate limit exceeded. Max 60 unauthenticated discovery requests per minute per IP.',
    );
  });

  it('an allowed anonymous read still succeeds and still correlates', async () => {
    const res = await mcpHandler(anonPost(readBody('allowed-1')));
    assert.equal(res.status, 200);
    assertJsonRpcResult(await res.json(), { id: 'allowed-1', label: 'allowed anon read' });
  });

  it('the limiter keeps its per-IP key derivation (no policy change)', async () => {
    deniedKeyPrefixes = [ANON_KEYS];
    await mcpHandler(anonPost(readBody(1), { 'x-real-ip': '198.51.100.9' }));
    assert.equal(limiterCalls.at(-1)?.key, 'rl:mcp:anon:ip:198.51.100.9');
    assert.equal(limiterCalls.at(-1)?.tokens, 60, 'the 60/min discovery ceiling must not move');
  });
});

// ---------------------------------------------------------------------------
// Credentialed per-minute limiter — both POST call sites
// ---------------------------------------------------------------------------

describe('#7818 — credentialed per-minute denials correlate to the request', () => {
  it('env_key branch (gated POST) preserves the id', async () => {
    deniedKeyPrefixes = [ENV_KEY_KEYS];
    const { deps } = makeProDeps();
    const res = await mcpHandler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'env-key-9', method: 'tools/call', params: { name: 'get_market_data', arguments: {} } }),
    }), deps);
    assertJsonRpcError(await res.json(), { id: 'env-key-9', code: -32029, label: 'env_key denial' });
    assert.ok(limiterCalls.some((c) => c.key === `rl:mcp:key:${ENV_KEY}`), 'the env-key limiter must be the rejecting one');
  });

  it('per-user branch on a PUBLIC method (the default-burst caller) preserves the id', async () => {
    deniedKeyPrefixes = [PRO_MIN_KEYS];
    const { deps } = makeProDeps();
    const res = await mcpHandler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PRO_BEARER}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
    }), deps);
    assertJsonRpcError(await res.json(), { id: 0, code: -32029, label: 'pro public-method denial' });
  });

  it('per-user branch on a GATED method (the plan-burst caller) preserves the id', async () => {
    deniedKeyPrefixes = [PRO_MIN_KEYS];
    const { deps } = makeProDeps();
    const res = await mcpHandler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PRO_BEARER}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4242, method: 'tools/call', params: { name: 'get_market_data', arguments: {} } }),
    }), deps);
    assertJsonRpcError(await res.json(), { id: 4242, code: -32029, label: 'pro gated-method denial' });
  });
});

// ---------------------------------------------------------------------------
// The cases that must KEEP a null id
// ---------------------------------------------------------------------------

describe('#7818 — branches with no request id stay null', () => {
  it('the GET/SSE replay caller has no JSON-RPC id and must not invent one', async () => {
    deniedKeyPrefixes = [PRO_MIN_KEYS];
    const { deps } = makeProDeps();
    const res = await mcpHandler(new Request(BASE_URL, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Last-Event-ID': 'evt-1',
      },
    }), deps);
    const body = await res.json();
    assert.equal(body.id, null, 'the SSE replay transport carries no request id to echo');
    assert.equal(body.error.code, -32029);
  });

  it('a rate-limited notification has no id to echo and keeps null', async () => {
    // `notifications/initialized` normally dispatches to a bodyless 202. The
    // limiter sits upstream of dispatch, so a denied notification gets the
    // error envelope instead — and a notification carries no id by definition,
    // so `undefined ?? null` is the correct answer, not a lost id. This is the
    // second documented `"id": null` case alongside the SSE replay channel.
    deniedKeyPrefixes = [ANON_KEYS];
    const res = await mcpHandler(anonPost({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const body = await res.json();
    assert.equal(body.id, null, 'a notification carries no id to correlate');
    assert.equal(body.error.code, -32029);
  });

  it('an ALLOWED notification still dispatches to the bodyless 202', async () => {
    const res = await mcpHandler(anonPost({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(res.status, 202, 'threading an id must not disturb the notification dispatch arm');
    assert.equal(await res.text(), '');
  });

  it('a malformed id is still rejected with -32600 and a null id', async () => {
    const res = await mcpHandler(anonPost({ jsonrpc: '2.0', id: { nested: true }, method: 'tools/list' }));
    const body = await res.json();
    assert.equal(body.id, null, 'an id that fails validation must not be echoed back');
    assert.equal(body.error.code, -32600);
  });

  it('an over-cap id is rejected BEFORE the limiter can echo it', async () => {
    // Load-bearing ordering, not a nicety: the denial envelope now serializes a
    // caller-supplied id, so the 256-byte cap in `validJsonRpcId` has to run
    // first or a hostile id would be reflected back on a cheap unauthenticated
    // path. Proving the code is -32600 is not enough — the limiter must never
    // even be consulted, so an id that failed validation cannot reach `rpcError`
    // through some future branch.
    deniedKeyPrefixes = [ANON_KEYS];
    const res = await mcpHandler(anonPost({ jsonrpc: '2.0', id: 'x'.repeat(257), method: 'tools/list' }));
    const body = await res.json();
    assert.equal(body.error.code, -32600, 'an over-cap id is a malformed request, not a rate-limit hit');
    assert.equal(body.id, null, 'a rejected id must never be echoed');
    assert.deepEqual(limiterCalls, [], 'id validation must precede the limiter, not follow it');
  });

  it('both limiters default to a null id when a caller passes none', async () => {
    deniedKeyPrefixes = [ANON_KEYS, PRO_MIN_KEYS];
    const anon = await applyAnonDiscoveryLimit(new Request(BASE_URL, { headers: { 'x-real-ip': '203.0.113.1' } }), {});
    assert.equal((await anon.json()).id, null);
    const perUser = await applyPerMinuteLimit({ kind: 'pro', userId: 'user_x', mcpTokenId: 't' }, {});
    assert.equal((await perUser.json()).id, null);
  });
});
