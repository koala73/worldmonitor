// Closed-key allowlist contract for the two MCP telemetry events
// (`mcp.toolcall` + `mcp.tools_list_emitted`). The exported allowlists in
// api/mcp.ts are the schema of what is allowed to land in the log drain.
// This file is what makes them load-bearing: any new top-level key on an
// emitted JSON line that isn't in the matching allowlist fails by name,
// and a positive sentinel assertion catches the specific case the
// allowlist exists to prevent (a tool-argument value leaking into the
// emitted log string).
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

const VALID_KEY = 'wm_test_key_123';
const BASE_URL = 'https://worldmonitor.app/mcp';

// Top-level keys that name a request- or response-body shape. If any of
// these appears in either allowlist, the redaction contract is broken at
// the source — fail at the declaration site before any runtime check.
const FORBIDDEN_TELEMETRY_KEYS = Object.freeze([
  'arguments',
  'params',
  'payload',
  'response',
  'content',
  'text',
  'result',
]);

// A sentinel string seeded into a tool-call argument value. The redaction
// contract: this exact string MUST NOT appear in the stringified emitted
// telemetry. If a future emit-site change attaches `arguments` (or any
// other un-allowlisted field that includes the request body) to the log,
// this string surfaces and the assertion fails.
const ARG_SENTINEL = 'TELEMETRY_REDACTION_SENTINEL_ARG_VALUE_xyzzy_9f3a';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeReq(body) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
    },
    body: JSON.stringify(body),
  });
}

function initBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  };
}

// Mirrors the cache-mock helper in tests/mcp.test.mjs so a single
// `get_market_data` call succeeds without hitting the network. Any GET
// not in the supplied maps resolves to "key absent" — keeps multi-key
// bundle tools' unmocked siblings from throwing.
function mockCacheKeys(keyMap, metaKeys = {}) {
  const all = { ...keyMap, ...metaKeys };
  globalThis.fetch = async (url) => {
    const u = url.toString();
    for (const [k, v] of Object.entries(all)) {
      if (u.includes(`/get/${encodeURIComponent(k)}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(v) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (u.includes('/get/')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url);
  };
}

describe('api/mcp.ts — telemetry redaction (closed-key allowlist)', () => {
  let handler;
  let MCP_TOOLCALL_TELEMETRY_KEYS;
  let MCP_TOOLS_LIST_TELEMETRY_KEYS;
  let MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS;
  let emitMcpRateLimitHit;
  let captured;
  let origLog;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    process.env.MCP_TELEMETRY = 'true';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
    const mod = await import(`../api/mcp.ts?t=${Date.now()}`);
    handler = mod.default;
    MCP_TOOLCALL_TELEMETRY_KEYS = mod.MCP_TOOLCALL_TELEMETRY_KEYS;
    MCP_TOOLS_LIST_TELEMETRY_KEYS = mod.MCP_TOOLS_LIST_TELEMETRY_KEYS;
    MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS = mod.MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS;
    emitMcpRateLimitHit = mod.emitMcpRateLimitHit;
    captured = [];
    origLog = console.log;
    console.log = (line) => captured.push(line);
  });

  afterEach(() => {
    console.log = origLog;
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('declares non-empty allowlists exported from api/mcp.ts', () => {
    assert.ok(Array.isArray(MCP_TOOLCALL_TELEMETRY_KEYS), 'MCP_TOOLCALL_TELEMETRY_KEYS must be exported as an array');
    assert.ok(MCP_TOOLCALL_TELEMETRY_KEYS.length > 0, 'MCP_TOOLCALL_TELEMETRY_KEYS must be non-empty');
    assert.ok(Array.isArray(MCP_TOOLS_LIST_TELEMETRY_KEYS), 'MCP_TOOLS_LIST_TELEMETRY_KEYS must be exported as an array');
    assert.ok(MCP_TOOLS_LIST_TELEMETRY_KEYS.length > 0, 'MCP_TOOLS_LIST_TELEMETRY_KEYS must be non-empty');
    assert.ok(Array.isArray(MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS), 'MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS must be exported as an array');
    assert.ok(MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS.length > 0, 'MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS must be non-empty');
  });

  it('declared allowlists exclude every request/response body key', () => {
    for (const forbidden of FORBIDDEN_TELEMETRY_KEYS) {
      assert.ok(
        !MCP_TOOLCALL_TELEMETRY_KEYS.includes(forbidden),
        `MCP_TOOLCALL_TELEMETRY_KEYS must not include "${forbidden}" — request/response bodies are never logged`,
      );
      assert.ok(
        !MCP_TOOLS_LIST_TELEMETRY_KEYS.includes(forbidden),
        `MCP_TOOLS_LIST_TELEMETRY_KEYS must not include "${forbidden}" — request/response bodies are never logged`,
      );
      assert.ok(
        !MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS.includes(forbidden),
        `MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS must not include "${forbidden}" — request/response bodies are never logged`,
      );
    }
  });

  it('mcp.rate_limit_hit emitted line keys ⊆ MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS', () => {
    emitMcpRateLimitHit(
      { kind: 'env_key', apiKey: VALID_KEY },
      { dimension: 'mcp_minute_burst', limit: 60, windowSeconds: 60 },
    );

    const ev = captured.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && l.tag === 'mcp.rate_limit_hit');
    assert.equal(ev.length, 1, `expected exactly one mcp.rate_limit_hit line, got ${ev.length}`);
    assert.equal(ev[0].user_id, null, 'env-key rate-limit telemetry must not log a raw user id');
    assert.notEqual(ev[0].principal_id, VALID_KEY, 'env-key rate-limit telemetry must not log the raw API key');
    const offending = Object.keys(ev[0]).filter((k) => !MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(offending, [], `unauthorized telemetry keys on mcp.rate_limit_hit: ${offending.join(', ')} — add to MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS or remove from the emit site`);
  });

  it('mcp.toolcall emitted line keys ⊆ MCP_TOOLCALL_TELEMETRY_KEYS', async () => {
    mockCacheKeys(
      { 'market:stocks-bootstrap:v1': { quotes: [{ symbol: 'AAPL', price: 100 }] }, 'market:crypto:v1': { quotes: [] } },
      { 'seed-meta:market:stocks': { fetchedAt: Date.now() - 60_000, recordCount: 1 } },
    );
    const res = await handler(makeReq({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_market_data', arguments: {} },
    }));
    assert.equal(res.status, 200);

    const tc = captured.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && l.tag === 'mcp.toolcall');
    assert.equal(tc.length, 1, `expected exactly one mcp.toolcall line, got ${tc.length}`);
    const offending = Object.keys(tc[0]).filter((k) => !MCP_TOOLCALL_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(offending, [], `unauthorized telemetry keys on mcp.toolcall: ${offending.join(', ')} — add to MCP_TOOLCALL_TELEMETRY_KEYS or remove from the emit site`);
  });

  it('mcp.toolcall ERROR-path emitted line keys ⊆ MCP_TOOLCALL_TELEMETRY_KEYS', async () => {
    // The catch-block emit site in dispatchToolsCall adds `error_kind` —
    // a key the success path never sends. Without this case the allowlist
    // promise has a hole on the error branch (greptile review on PR
    // #3849). Force the cache-tool fetch to throw so dispatchToolsCall's
    // outer catch fires and emits the ok:false telemetry line.
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };

    const origErr = console.error;
    console.error = () => {}; // swallow the captureSilentError stderr noise

    let res;
    try {
      res = await handler(makeReq({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'get_market_data', arguments: {} },
      }));
    } finally {
      console.error = origErr;
    }
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'tool throw must surface as JSON-RPC -32603');

    const tc = captured.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && l.tag === 'mcp.toolcall');
    assert.equal(tc.length, 1, `expected exactly one mcp.toolcall line on the error path, got ${tc.length}`);
    assert.equal(tc[0].ok, false, 'sanity: we hit the catch branch');
    assert.equal(tc[0].error_kind, 'server_error', 'sanity: error_kind is populated (without it this case would not differ from success)');
    const offending = Object.keys(tc[0]).filter((k) => !MCP_TOOLCALL_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(offending, [], `unauthorized telemetry keys on mcp.toolcall (error path): ${offending.join(', ')} — add to MCP_TOOLCALL_TELEMETRY_KEYS or remove from the catch-branch emit site`);
  });

  it('mcp.tools_list_emitted line keys ⊆ MCP_TOOLS_LIST_TELEMETRY_KEYS', async () => {
    const res = await handler(makeReq(initBody(2)));
    assert.equal(res.status, 200);

    const ev = captured.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && l.tag === 'mcp.tools_list_emitted');
    assert.equal(ev.length, 1, `expected exactly one mcp.tools_list_emitted line, got ${ev.length}`);
    const offending = Object.keys(ev[0]).filter((k) => !MCP_TOOLS_LIST_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(offending, [], `unauthorized telemetry keys on mcp.tools_list_emitted: ${offending.join(', ')} — add to MCP_TOOLS_LIST_TELEMETRY_KEYS or remove from the emit site`);
  });

  it('tool-argument value in the request body never appears in any emitted telemetry line', async () => {
    // Seed an argument value the test owns end-to-end. The jmespath
    // expression is well-formed (no `_jmespath_error` envelope to muddy
    // the assertion); it just doesn't resolve to anything in the mocked
    // response, so the projected text is empty. The whole point is what
    // happens to the *argument* — telemetry MUST NOT echo it back.
    mockCacheKeys(
      { 'market:stocks-bootstrap:v1': { quotes: [{ symbol: 'AAPL', price: 100 }] }, 'market:crypto:v1': { quotes: [] } },
      { 'seed-meta:market:stocks': { fetchedAt: Date.now() - 60_000, recordCount: 1 } },
    );
    const res = await handler(makeReq({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_market_data', arguments: { jmespath: `data.${ARG_SENTINEL}` } },
    }));
    assert.equal(res.status, 200);

    const tc = captured.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && l.tag === 'mcp.toolcall');
    assert.equal(tc.length, 1, `expected exactly one mcp.toolcall line, got ${tc.length}`);

    const serialized = JSON.stringify(captured);
    assert.ok(
      !serialized.includes(ARG_SENTINEL),
      `tool-argument sentinel "${ARG_SENTINEL}" leaked into emitted telemetry — request bodies must never be logged. Emitted: ${serialized}`,
    );
  });
});
