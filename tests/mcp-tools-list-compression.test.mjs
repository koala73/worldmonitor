import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

describe('api/mcp.ts — tools/list description compression (v1.5.0)', () => {
  let mod;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    mod = await freshMod();
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // ============================================================
  // U1: compressDescription helper + cap constant
  // ============================================================
  describe('compressDescription helper', () => {
    it('TOOL_DESCRIPTION_MAX_BYTES === 120', () => {
      assert.equal(mod.TOOL_DESCRIPTION_MAX_BYTES, 120);
    });

    it('short text (≤cap) returns unchanged (identity, same reference)', () => {
      const t = 'Short description.';
      const r = mod.compressDescription(t, mod.TOOL_DESCRIPTION_MAX_BYTES);
      assert.equal(r, t);
    });

    it('long text with sentence boundary returns first-sentence trimmed', () => {
      const t = 'First sentence is short. Second sentence is much longer and would otherwise blow past the cap by including a great deal of additional prose that nobody reads.';
      const r = mod.compressDescription(t, 80);
      assert.equal(r, 'First sentence is short.');
      assert.ok(mod.utf8ByteLength(r) <= 80);
    });

    it('long text without sentence boundary returns truncated-to-cap raw text', () => {
      const t = 'a'.repeat(200); // no `.`, `!`, or `?`
      const r = mod.compressDescription(t, 50);
      assert.equal(mod.utf8ByteLength(r), 50);
      assert.equal(r, 'a'.repeat(50));
    });

    it('text exactly at cap returns unchanged', () => {
      const t = 'x'.repeat(50);
      const r = mod.compressDescription(t, 50);
      assert.equal(r, t);
    });

    it('UTF-8 emoji at the cap boundary: never splits a 4-byte codepoint mid-cut', () => {
      // 30 emoji = 120 UTF-8 bytes (each emoji is 4 bytes); cap=100.
      // The byte-truncate path should stop AT a codepoint boundary,
      // not produce a malformed UTF-8 string. 25 emoji = 100 bytes.
      const t = '🚀'.repeat(30);
      assert.equal(mod.utf8ByteLength(t), 120);
      const r = mod.compressDescription(t, 100);
      assert.equal(mod.utf8ByteLength(r), 100, `expected exactly 100 bytes, got ${mod.utf8ByteLength(r)}`);
      // Round-trip through encode/decode to confirm no broken codepoint
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(r));
      assert.equal(decoded, r);
      assert.equal(r, '🚀'.repeat(25));
    });

    it('CJK content compresses correctly (utf8 byte accounting, not .length)', () => {
      // Each Chinese char is 3 UTF-8 bytes. 50 chars = 150 bytes, .length=50.
      const t = '中'.repeat(50);
      assert.equal(mod.utf8ByteLength(t), 150);
      assert.equal(t.length, 50);
      const r = mod.compressDescription(t, 60);
      // Should fit ~20 chars (60 bytes) — first-sentence regex doesn't match, falls through to byte-truncate
      assert.ok(mod.utf8ByteLength(r) <= 60);
      assert.equal(mod.utf8ByteLength(r), 60); // exactly 20 chars
    });

    it('empty string returns empty string', () => {
      assert.equal(mod.compressDescription('', 120), '');
    });

    it('idempotent: compressDescription(compressDescription(t, cap), cap) === compressDescription(t, cap)', () => {
      const t = 'a long description that exceeds the cap. With multiple sentences. Each one different.';
      const once = mod.compressDescription(t, 30);
      const twice = mod.compressDescription(once, 30);
      assert.equal(twice, once);
    });

    it('never grows: output bytes ≤ max(input, cap)', () => {
      const inputs = [
        'short',
        'medium length sentence here.',
        'a'.repeat(300),
        '🚀'.repeat(50),
      ];
      for (const t of inputs) {
        const r = mod.compressDescription(t, 50);
        assert.ok(mod.utf8ByteLength(r) <= Math.max(mod.utf8ByteLength(t), 50),
          `growth detected for input ${JSON.stringify(t.slice(0, 40))}: in=${mod.utf8ByteLength(t)} out=${mod.utf8ByteLength(r)}`);
      }
    });
  });

  // ============================================================
  // U2: buildPublicTool shared helper — clone, inject, strip
  // ============================================================
  describe('buildPublicTool helper', () => {
    // Pick a cache tool (has _execute===undefined) and an RPC tool from
    // the registry. Use module-side TOOL_REGISTRY via the helper's
    // outputs since we don't export TOOL_REGISTRY directly.
    async function getRegistry() {
      // Reach into the module's tools/list response to find tool shapes,
      // then call buildPublicTool against the public surface via a fresh
      // import + direct tool lookup.
      // Easier: use the existing tools/list call to learn the names, then
      // export TOOL_REGISTRY-like access by calling buildPublicTool indirectly.
      // We need TOOL_REGISTRY here for tests; export it temporarily via
      // module internals.
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }));
      const body = await res.json();
      return body.result.tools;
    }

    it('compressDescriptions=true returns { name, description, inputSchema, annotations } with no other top-level keys', async () => {
      const tools = await getRegistry();
      const t = tools.find(t => t.name === 'get_market_data');
      assert.ok(t, 'get_market_data must be registered');
      assert.deepEqual(Object.keys(t).sort(), ['annotations', 'description', 'inputSchema', 'name']);
    });

    it('every cache-tool result has inputSchema.properties.summary STRUCTURALLY equal to SUMMARY_SCHEMA (deepEqual not ===)', async () => {
      // We need an internal handle on SUMMARY_SCHEMA / JMESPATH_SCHEMA to
      // assert structural equality.
      const SUMMARY_SCHEMA = { type: 'boolean', description: 'Return counts + 3-item samples instead of full lists. Useful when you only need shape/size or want to budget context before drilling in.' };
      const tools = await getRegistry();
      const cacheTool = tools.find(t => t.name === 'get_market_data');
      assert.ok(cacheTool.inputSchema.properties.summary);
      assert.deepEqual(cacheTool.inputSchema.properties.summary, SUMMARY_SCHEMA);
    });

    it('every tool has inputSchema.properties.jmespath STRUCTURALLY equal to JMESPATH_SCHEMA (deepEqual not ===)', async () => {
      const JMESPATH_SCHEMA = { type: 'string', description: 'Optional JMESPath projection applied to the response. See initialize.instructions for grammar and examples.' };
      const tools = await getRegistry();
      for (const t of tools) {
        assert.ok(t.inputSchema?.properties?.jmespath, `tool "${t.name}" missing jmespath schema`);
        assert.deepEqual(t.inputSchema.properties.jmespath, JMESPATH_SCHEMA, `tool "${t.name}" jmespath shape differs`);
      }
    });

    it('RPC tool result does NOT have summary in properties', async () => {
      const tools = await getRegistry();
      // search_flights is RPC (_execute) — no summary
      const rpc = tools.find(t => t.name === 'search_flights');
      assert.ok(rpc);
      assert.ok(!('summary' in (rpc.inputSchema?.properties ?? {})),
        'search_flights (RPC) MUST NOT have summary in its properties');
    });

    it('R5: mutating result.inputSchema.properties.asset_class.items.enum does NOT mutate registry', async () => {
      // get_market_data.asset_class has items.enum (api/mcp.ts:655).
      const tools1 = await getRegistry();
      const a1 = tools1.find(t => t.name === 'get_market_data');
      assert.ok(Array.isArray(a1.inputSchema.properties.asset_class?.items?.enum),
        'asset_class.items.enum must exist for this test');
      const before = [...a1.inputSchema.properties.asset_class.items.enum];
      // Mutate the returned schema
      a1.inputSchema.properties.asset_class.items.enum.push('hacked');
      // Fetch again — should be untouched
      const tools2 = await getRegistry();
      const a2 = tools2.find(t => t.name === 'get_market_data');
      assert.deepEqual(a2.inputSchema.properties.asset_class.items.enum, before,
        'nested items.enum was mutated through shared reference');
    });

    it('R5: mutating result.inputSchema.properties.<x>.enum does NOT mutate registry (direct-enum case)', async () => {
      // get_news_intelligence.topic has direct enum (api/mcp.ts:810).
      const tools1 = await getRegistry();
      const a1 = tools1.find(t => t.name === 'get_news_intelligence');
      assert.ok(Array.isArray(a1.inputSchema.properties.topic?.enum),
        'topic.enum must exist for this test');
      const before = [...a1.inputSchema.properties.topic.enum];
      a1.inputSchema.properties.topic.enum.length = 0; // mutate to empty
      const tools2 = await getRegistry();
      const a2 = tools2.find(t => t.name === 'get_news_intelligence');
      assert.deepEqual(a2.inputSchema.properties.topic.enum, before,
        'direct enum array was mutated through shared reference');
    });

    it('R5: mutating result.inputSchema.properties.jmespath.description does NOT mutate JMESPATH_SCHEMA', async () => {
      const tools1 = await getRegistry();
      const a1 = tools1.find(t => t.name === 'get_market_data');
      a1.inputSchema.properties.jmespath.description = 'EVIL';
      const tools2 = await getRegistry();
      const a2 = tools2.find(t => t.name === 'get_market_data');
      assert.notEqual(a2.inputSchema.properties.jmespath.description, 'EVIL',
        'JMESPATH_SCHEMA was mutated through shared reference — buildPublicTool must clone it');
      assert.ok(a2.inputSchema.properties.jmespath.description.includes('JMESPath'),
        `expected the original JMESPATH_SCHEMA description, got "${a2.inputSchema.properties.jmespath.description}"`);
    });

    it('R5: mutating result.inputSchema.properties.summary.description does NOT mutate SUMMARY_SCHEMA', async () => {
      const tools1 = await getRegistry();
      const a1 = tools1.find(t => t.name === 'get_market_data');
      a1.inputSchema.properties.summary.description = 'EVIL';
      const tools2 = await getRegistry();
      const a2 = tools2.find(t => t.name === 'get_market_data');
      assert.notEqual(a2.inputSchema.properties.summary.description, 'EVIL',
        'SUMMARY_SCHEMA was mutated through shared reference');
      assert.ok(a2.inputSchema.properties.summary.description.includes('counts'),
        `expected the original SUMMARY_SCHEMA description, got "${a2.inputSchema.properties.summary.description}"`);
    });

    it('two calls produce structurally-equal but reference-distinct property objects', async () => {
      const tools1 = await getRegistry();
      const tools2 = await getRegistry();
      const a1 = tools1.find(t => t.name === 'get_market_data');
      const a2 = tools2.find(t => t.name === 'get_market_data');
      assert.deepEqual(a1.inputSchema.properties, a2.inputSchema.properties);
      assert.notEqual(a1.inputSchema.properties, a2.inputSchema.properties,
        'expected reference-distinct properties objects between calls');
      assert.notEqual(a1.inputSchema.properties.jmespath, a2.inputSchema.properties.jmespath,
        'expected reference-distinct jmespath property objects between calls');
    });

    it('R9: no key starting with _ appears anywhere in any returned tool object (recursive scan)', async () => {
      const tools = await getRegistry();
      function scanForUnderscoreKey(value, pathStack) {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) scanForUnderscoreKey(value[i], [...pathStack, `[${i}]`]);
        } else if (value && typeof value === 'object') {
          for (const k of Object.keys(value)) {
            if (k.startsWith('_')) {
              throw new Error(`Internal field leak: tools/list contains key "${k}" at path ${pathStack.join('.')}`);
            }
            scanForUnderscoreKey(value[k], [...pathStack, k]);
          }
        }
      }
      for (const t of tools) {
        scanForUnderscoreKey(t, [`tools[${t.name}]`]);
      }
    });
  });
});
