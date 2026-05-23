import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';
const BASE_URL = 'https://worldmonitor.app/mcp';

function makeReq(body = null, headers = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function initBody(id = 1) {
  return {
    jsonrpc: '2.0', id,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jmespath-test', version: '1.0' } },
  };
}

// Fresh module import per test so module-load side effects (collision
// guard, TOOL_LIST_RESPONSE construction) re-run cleanly.
async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

describe('api/mcp.ts — JMESPath projection (v1.7.0)', () => {
  let mod;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    mod = await freshMod();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // ============================================================
  // applyJmespath helper — unit
  // ============================================================
  describe('applyJmespath helper', () => {
    it('identity: undefined exprArg returns JSON.stringify(value)', () => {
      const v = { a: [1, 2, 3] };
      const r = mod.applyJmespath(v, undefined);
      assert.equal(r.text, JSON.stringify(v));
      assert.equal(r.failed, undefined);
    });

    it('identity: empty string exprArg returns identity', () => {
      const v = { a: 1 };
      const r = mod.applyJmespath(v, '');
      assert.equal(r.text, JSON.stringify(v));
      assert.equal(r.failed, undefined);
    });

    it('identity: non-string exprArg (number) returns identity', () => {
      const v = { a: 1 };
      const r = mod.applyJmespath(v, 42);
      assert.equal(r.text, JSON.stringify(v));
    });

    it('identity: null exprArg returns identity', () => {
      const v = { a: 1 };
      const r = mod.applyJmespath(v, null);
      assert.equal(r.text, JSON.stringify(v));
    });

    it('identity: undefined value with absent expr returns "null" string, not undefined', () => {
      // Guard against JSON.stringify(undefined) === undefined (not the
      // string "null"), which would propagate up to content[0].text and
      // serialize the field away. Same shape as the projection path.
      const r = mod.applyJmespath(undefined, undefined);
      assert.equal(r.text, 'null', `expected literal string "null", got ${JSON.stringify(r.text)}`);
      assert.equal(r.failed, undefined);
    });

    it('happy: simple key path', () => {
      const r = mod.applyJmespath({ a: { b: [1, 2, 3] } }, 'a.b[1]');
      assert.equal(r.text, '2');
      assert.equal(r.failed, undefined);
    });

    it('happy: multiselect-hash projection', () => {
      const r = mod.applyJmespath(
        { items: [{ symbol: 'AAPL', price: 100 }, { symbol: 'MSFT', price: 200 }] },
        'items[*].{s:symbol, p:price}',
      );
      assert.deepEqual(JSON.parse(r.text), [{ s: 'AAPL', p: 100 }, { s: 'MSFT', p: 200 }]);
    });

    it('happy: identity-expression @ returns original shape', () => {
      const v = { a: [1, 2] };
      const r = mod.applyJmespath(v, '@');
      assert.deepEqual(JSON.parse(r.text), v);
      assert.equal(r.failed, undefined);
    });

    it('error: invalid expression returns invalid_expression soft-fail', () => {
      const r = mod.applyJmespath({ a: 1 }, 'a.');
      assert.equal(r.failed, 'invalid_expression');
      const env = JSON.parse(r.text);
      assert.ok(env._jmespath_error?.startsWith('invalid_expression:'), `prefix mismatch: ${env._jmespath_error}`);
      assert.deepEqual(env.original_keys, ['a']);
    });

    it('input gate: expression > JMESPATH_MAX_EXPR_BYTES returns expression_too_long', () => {
      const longExpr = 'a'.repeat(mod.JMESPATH_MAX_EXPR_BYTES + 1);
      const r = mod.applyJmespath({ x: 1 }, longExpr);
      assert.equal(r.failed, 'expression_too_long');
      const env = JSON.parse(r.text);
      assert.ok(env._jmespath_error?.startsWith('expression_too_long:'));
      assert.ok(env._jmespath_error.includes(String(mod.JMESPATH_MAX_EXPR_BYTES)));
    });

    it('input gate UTF-8: emoji expression rejected even when .length < cap', () => {
      // Each "🚀" is 2 UTF-16 code units (surrogate pair) and 4 UTF-8 bytes.
      // With N=300 emoji:
      //   .length = 600 (well under the 1024 byte cap if measured as
      //                  UTF-16 code units — would PASS a .length check)
      //   utf8    = 1200 (above the 1024 byte cap — must FAIL the real
      //                   UTF-8 check)
      // If the gate ever silently fell back to .length, this passes through.
      const expr = '🚀'.repeat(300);
      assert.equal(expr.length, 600, 'sanity: UTF-16 .length is 600');
      assert.equal(mod.utf8ByteLength(expr), 1200, 'sanity: UTF-8 byte length is 1200');
      assert.ok(expr.length < mod.JMESPATH_MAX_EXPR_BYTES,
        `test premise: .length (${expr.length}) must be < cap (${mod.JMESPATH_MAX_EXPR_BYTES})`);
      assert.ok(mod.utf8ByteLength(expr) > mod.JMESPATH_MAX_EXPR_BYTES,
        `test premise: utf8 (${mod.utf8ByteLength(expr)}) must be > cap (${mod.JMESPATH_MAX_EXPR_BYTES})`);
      const r = mod.applyJmespath({ x: 1 }, expr);
      assert.equal(r.failed, 'expression_too_long');
    });

    it('output gate: projection > JMESPATH_MAX_OUTPUT_BYTES returns projection_too_large', () => {
      // Build a payload whose multiselect-hash projection exceeds 256 KB.
      // Each item duplicated into 5 keys, ~80 bytes each → ~400 bytes/item.
      // 1000 items → ~400 KB. Safely over the 256 KB cap.
      const items = Array.from({ length: 1000 }, (_, i) => ({
        x: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${i}`,
      }));
      const r = mod.applyJmespath({ items }, 'items[*].{a:x, b:x, c:x, d:x, e:x}');
      assert.equal(r.failed, 'projection_too_large');
      const env = JSON.parse(r.text);
      assert.ok(env._jmespath_error?.startsWith('projection_too_large:'));
      assert.ok(env._jmespath_error.includes(String(mod.JMESPATH_MAX_OUTPUT_BYTES)));
      // The returned envelope itself must be SMALL — proves the cap actually
      // rejected the bloated projection, didn't just label it.
      assert.ok(mod.utf8ByteLength(r.text) < 8 * 1024, `envelope size ${r.text.length} should be << 256 KB`);
    });

    it('output gate UTF-8: 4-byte chars push utf8 over cap even when JS string .length is under', () => {
      // Build a payload whose JS-string .length is well below 256 KB but whose
      // UTF-8 byte length exceeds the cap. Each "🌍" is 2 UTF-16 code units
      // (.length=2) but 4 UTF-8 bytes. JSON.stringify keeps emoji as raw
      // UTF-8 (NOT \u escape sequences), so the projected text's byte length
      // is dominated by the emoji content.
      const chunk = '🌍'.repeat(40_000);            // .length = 80_000, utf8 = 160_000
      const v = { a: chunk, b: chunk };             // doubled → ~320 KB UTF-8 in JSON form
      // Sanity-check the test premise BEFORE invoking the helper. If these
      // fail, the test fixture itself is wrong, not the helper.
      const naiveStringified = JSON.stringify(v);
      assert.ok(naiveStringified.length < mod.JMESPATH_MAX_OUTPUT_BYTES,
        `premise: JS-string .length (${naiveStringified.length}) must be < cap (${mod.JMESPATH_MAX_OUTPUT_BYTES})`);
      assert.ok(mod.utf8ByteLength(naiveStringified) > mod.JMESPATH_MAX_OUTPUT_BYTES,
        `premise: UTF-8 byte length (${mod.utf8ByteLength(naiveStringified)}) must be > cap (${mod.JMESPATH_MAX_OUTPUT_BYTES})`);
      // The real assertion: the helper MUST reject. If the gate ever silently
      // fell back to .length, this fails.
      const r = mod.applyJmespath(v, '@');
      assert.equal(r.failed, 'projection_too_large',
        `expected projection_too_large but got ${r.failed ?? '<no failure>'}`);
      assert.ok(mod.utf8ByteLength(r.text) < 8 * 1024,
        `error envelope must be SMALL, got ${r.text.length} chars`);
    });

    it('enum consistency: failed field matches the leading token of _jmespath_error for each kind', () => {
      const cases = [
        { value: { x: 1 }, expr: 'a'.repeat(mod.JMESPATH_MAX_EXPR_BYTES + 1), expected: 'expression_too_long' },
        { value: { x: 1 }, expr: 'a.', expected: 'invalid_expression' },
      ];
      for (const c of cases) {
        const r = mod.applyJmespath(c.value, c.expr);
        assert.equal(r.failed, c.expected, `failed field mismatch for ${c.expected}`);
        const env = JSON.parse(r.text);
        const leading = env._jmespath_error.split(':')[0];
        assert.equal(leading, c.expected, `envelope prefix mismatch for ${c.expected}: got "${leading}"`);
      }
    });

    it('original_keys: array shows length tag', () => {
      const r = mod.applyJmespath([1, 2, 3, 4, 5], 'a.');
      const env = JSON.parse(r.text);
      assert.deepEqual(env.original_keys, ['<array length=5>']);
    });

    it('original_keys: object returns up to 50 keys', () => {
      const big = {};
      for (let i = 0; i < 100; i++) big[`k${i}`] = i;
      const r = mod.applyJmespath(big, 'a.');
      const env = JSON.parse(r.text);
      assert.equal(env.original_keys.length, 51); // 50 keys + the "...N more" marker
      assert.ok(env.original_keys.at(-1).startsWith('...<50 more'));
    });

    it('original_keys: primitive returns typeof tag', () => {
      const r = mod.applyJmespath('hello', 'a.');
      const env = JSON.parse(r.text);
      assert.deepEqual(env.original_keys, ['<string>']);
    });

    it('utf8ByteLength: ASCII matches .length', () => {
      assert.equal(mod.utf8ByteLength('hello world'), 11);
    });

    it('utf8ByteLength: emoji is 4 bytes per char', () => {
      assert.equal(mod.utf8ByteLength('🚀'), 4);
      assert.equal(mod.utf8ByteLength('🚀🚀'), 8);
    });
  });

  // ============================================================
  // Constants + schema parity
  // ============================================================
  describe('constants + schema parity', () => {
    it('JMESPATH_MAX_EXPR_BYTES === 1024', () => {
      assert.equal(mod.JMESPATH_MAX_EXPR_BYTES, 1024);
    });

    it('JMESPATH_MAX_OUTPUT_BYTES === 256 KiB', () => {
      assert.equal(mod.JMESPATH_MAX_OUTPUT_BYTES, 256 * 1024);
    });

    it('JMESPATH_SCHEMA.type === "string"', () => {
      assert.equal(mod.JMESPATH_SCHEMA.type, 'string');
    });

    it('JMESPATH_SCHEMA.description is terse (< 150 bytes)', () => {
      // Regression guard: keeping per-tool advertisement terse is what
      // makes the v1.4.0 addition net-positive on `tools/list` token cost.
      assert.ok(
        mod.JMESPATH_SCHEMA.description.length < 150,
        `description is ${mod.JMESPATH_SCHEMA.description.length} bytes — should be < 150. Move detail to initialize.instructions.`,
      );
    });

    it('JMESPATH_SCHEMA.description points to initialize.instructions', () => {
      assert.ok(/initialize\.instructions/i.test(mod.JMESPATH_SCHEMA.description));
    });

    it('every tool in tools/list advertises jmespath in inputSchema.properties', async () => {
      const res = await mod.default(makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      const body = await res.json();
      const tools = body.result.tools;
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        assert.ok(tool.inputSchema?.properties?.jmespath,
          `tool "${tool.name}" missing inputSchema.properties.jmespath`);
        assert.equal(tool.inputSchema.properties.jmespath.type, 'string');
        // Must NOT be in required.
        const req = tool.inputSchema.required ?? [];
        assert.ok(!req.includes('jmespath'),
          `tool "${tool.name}" has jmespath in required — must be optional`);
      }
    });

    it('cache tools also have summary; RPC tools only have jmespath (no summary)', async () => {
      // Without UPSTASH env, the registry is built the same way. Cache vs RPC
      // is determined by whether _execute is undefined in the registry.
      // From the public tools/list we can't tell — we infer from the
      // presence of `summary` (cache-only injection).
      const res = await mod.default(makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      const body = await res.json();
      const tools = body.result.tools;
      // At minimum, SOME tools have summary (cache) and SOME don't (RPC).
      const withSummary = tools.filter(t => t.inputSchema?.properties?.summary);
      const withoutSummary = tools.filter(t => !t.inputSchema?.properties?.summary);
      assert.ok(withSummary.length > 0, 'expected at least one cache tool with summary');
      assert.ok(withoutSummary.length > 0, 'expected at least one RPC tool without summary');
      // All of them advertise jmespath universally (already asserted above).
    });
  });

  // ============================================================
  // Initialize handshake — version + instructions
  // ============================================================
  describe('initialize handshake', () => {
    it('serverInfo.version === "1.7.0"', async () => {
      // Tracks current SERVER_VERSION. Each minor bump needs to update
      // this assertion + the cross-check at line 327 below.
      const res = await mod.default(makeReq(initBody(1)));
      const body = await res.json();
      assert.equal(body.result?.serverInfo?.version, '1.7.0');
    });

    it('result.instructions is present and mentions jmespath', async () => {
      const res = await mod.default(makeReq(initBody(2)));
      const body = await res.json();
      assert.ok(typeof body.result?.instructions === 'string',
        `expected instructions field, got ${typeof body.result?.instructions}`);
      assert.ok(/jmespath/i.test(body.result.instructions));
    });

    it('instructions includes grammar URL + the caps + the quota note', async () => {
      const res = await mod.default(makeReq(initBody(3)));
      const body = await res.json();
      const inst = body.result.instructions;
      assert.ok(inst.includes('https://jmespath.org'), 'missing grammar URL');
      assert.ok(inst.includes(String(mod.JMESPATH_MAX_EXPR_BYTES)), 'missing expression cap value');
      assert.ok(inst.includes(String(mod.JMESPATH_MAX_OUTPUT_BYTES)), 'missing output cap value');
      assert.ok(/daily quota/i.test(inst), 'missing quota note');
    });

    it('server-card.json version matches SERVER_VERSION (currently 1.7.0)', () => {
      // Cross-check the comment at api/mcp.ts:~56 — discovery scanners
      // verify both values; a future bump that misses one would break
      // discovery. This is the test that prevents that drift.
      const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
      assert.equal(card.serverInfo.version, '1.7.0');
      assert.equal(card.features?.responseProjection, 'jmespath');
    });

    it('initialize still includes capabilities + protocolVersion unchanged', async () => {
      const res = await mod.default(makeReq(initBody(4)));
      const body = await res.json();
      assert.equal(body.result?.protocolVersion, '2025-03-26');
      assert.deepEqual(body.result?.capabilities, { tools: {}, logging: {} });
      assert.equal(body.result?.serverInfo?.name, 'worldmonitor');
    });
  });

  // ============================================================
  // Dispatch integration — JMESPath wired into tools/call
  // ============================================================
  describe('dispatch integration', () => {
    // Mock cache reads for the get_market_data tool. Only need a subset of
    // its keys — applyJmespath runs on whatever shape executeTool assembles.
    function mockMarketDataCache() {
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
      const stocks = { quotes: [{ symbol: 'AAPL', price: 100 }, { symbol: 'MSFT', price: 200 }, { symbol: 'GOOG', price: 150 }] };
      const meta = { fetchedAt: Date.now(), recordCount: 3 };
      const keyMap = {
        'market:stocks-bootstrap:v1': stocks,
        'market:commodities-bootstrap:v1': null,
        'market:crypto:v1': null,
        'market:sectors:v2': null,
        'market:etf-flows:v1': null,
        'market:gulf-quotes:v1': null,
        'market:fear-greed:v1': null,
        'seed-meta:market:stocks': meta,
      };
      globalThis.fetch = async (url) => {
        const u = url.toString();
        for (const [k, v] of Object.entries(keyMap)) {
          if (u.includes(`/get/${encodeURIComponent(k)}`)) {
            return new Response(JSON.stringify({ result: v === null ? null : JSON.stringify(v) }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        if (u.includes('/get/')) {
          return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // Setting UPSTASH_REDIS_REST_URL above enables the @upstash/ratelimit
        // sliding-window limiter, which makes EVALSHA / pipeline calls to
        // the same host. Without this catch-all, those fall through to
        // `originalFetch('https://fake.upstash.io/...')` and burn ~5-30s of
        // DNS-fail timeout per dispatch test. Return a benign rate-limit
        // shape that the Upstash REST client interprets as "limiter
        // unavailable" → graceful degradation, no rate-limit applied.
        if (u.startsWith('https://fake.upstash.io')) {
          return new Response(JSON.stringify({ result: null }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(url);
      };
    }

    async function callTool(name, args = {}, id = 999) {
      const fresh = await freshMod();
      const res = await fresh.default(makeReq({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
      }));
      const body = await res.json();
      return { res, body };
    }

    it('omitting jmespath returns the v1.3.0 payload byte-for-byte (additive guarantee)', async () => {
      mockMarketDataCache();
      const { body: a } = await callTool('get_market_data');
      const { body: b } = await callTool('get_market_data');
      assert.equal(a.result.content[0].text, b.result.content[0].text,
        'two no-arg calls produce identical wire text (deterministic baseline)');
      // The baseline content[0].text must include the expected fields.
      const payload = JSON.parse(a.result.content[0].text);
      assert.ok(payload.data, 'baseline envelope must contain `data`');
    });

    it('cache tool with jmespath projects correctly and shrinks the response', async () => {
      mockMarketDataCache();
      const { body: unproj } = await callTool('get_market_data', {}, 1);
      // Cache keys are labelled by the LAST meaningful segment after stripping
      // version tags (NON_LABEL = /^(v\d+|\d+|stale|sebuf)$/). So
      // `market:stocks-bootstrap:v1` becomes `data["stocks-bootstrap"]` —
      // a hyphenated key that JMESPath requires backtick-quoting on.
      const { body: proj } = await callTool('get_market_data',
        { jmespath: 'data."stocks-bootstrap".quotes[*].symbol' }, 2);
      const unprojText = unproj.result.content[0].text;
      const projText = proj.result.content[0].text;
      const projected = JSON.parse(projText);
      assert.deepEqual(projected, ['AAPL', 'MSFT', 'GOOG'],
        `expected ['AAPL','MSFT','GOOG'], got ${projText}`);
      assert.ok(mod.utf8ByteLength(projText) < mod.utf8ByteLength(unprojText),
        'projected response must be smaller than unprojected');
    });

    it('jmespath="" and jmespath=null behave as if absent (byte-identical baseline)', async () => {
      mockMarketDataCache();
      const { body: a } = await callTool('get_market_data', {}, 1);
      const { body: b } = await callTool('get_market_data', { jmespath: '' }, 2);
      const { body: c } = await callTool('get_market_data', { jmespath: null }, 3);
      assert.equal(a.result.content[0].text, b.result.content[0].text);
      assert.equal(a.result.content[0].text, c.result.content[0].text);
    });

    it('invalid jmespath returns soft _jmespath_error envelope (HTTP 200, no JSON-RPC error)', async () => {
      mockMarketDataCache();
      const { res, body } = await callTool('get_market_data', { jmespath: 'data.markets[invalid' });
      assert.equal(res.status, 200);
      assert.equal(body.error, undefined, 'must NOT be a JSON-RPC error');
      assert.ok(body.result?.content?.[0]?.text, 'must have a content envelope');
      const env = JSON.parse(body.result.content[0].text);
      assert.ok(env._jmespath_error?.startsWith('invalid_expression:'),
        `expected invalid_expression prefix, got "${env._jmespath_error}"`);
      assert.ok(Array.isArray(env.original_keys));
    });

    it('oversized jmespath expression returns expression_too_long soft envelope', async () => {
      mockMarketDataCache();
      const longExpr = 'a'.repeat(mod.JMESPATH_MAX_EXPR_BYTES + 1);
      const { res, body } = await callTool('get_market_data', { jmespath: longExpr });
      assert.equal(res.status, 200);
      const env = JSON.parse(body.result.content[0].text);
      assert.ok(env._jmespath_error?.startsWith('expression_too_long:'));
    });

    it('cache_all_null still triggers -32603 (rollback path preserved — applyJmespath did NOT regress it)', async () => {
      // No mock — all Redis reads return null → cache_all_null → throw → -32603.
      // Confirms applyJmespath's no-throw guarantee didn't accidentally
      // swallow the genuine tool-execution error path.
      const { body } = await callTool('get_market_data', { jmespath: 'data' });
      assert.equal(body.error?.code, -32603, 'cache_all_null must still surface as -32603');
    });

    it('jmespath composes with the existing summary flag (summary first, then projection)', async () => {
      mockMarketDataCache();
      // With summary=true, executeTool collapses lists to counts + 3 samples.
      // Then jmespath projects over the summarised shape.
      const { body } = await callTool('get_market_data', { summary: true, jmespath: 'keys(data)' });
      const env = JSON.parse(body.result.content[0].text);
      assert.ok(Array.isArray(env), 'jmespath result must be an array (keys()) over summarised data');
    });
  });
});
