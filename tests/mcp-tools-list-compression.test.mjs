import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

describe('api/mcp.ts — tools/list description compression (v1.7.0)', () => {
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

    it('compressDescriptions=true returns { name, description, inputSchema, outputSchema, annotations } with no other top-level keys', async () => {
      const tools = await getRegistry();
      // get_cyber_threats is a cache tool WITHOUT a ui:// surface, so it carries
      // no `_meta` — the clean 5-key public shape. (get_market_data now links a
      // Market Radar ui:// app shell and legitimately carries `_meta`.)
      const t = tools.find(t => t.name === 'get_cyber_threats');
      assert.ok(t, 'get_cyber_threats must be registered');
      assert.deepEqual(Object.keys(t).sort(), ['annotations', 'description', 'inputSchema', 'name', 'outputSchema']);
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
      // v1.6.0: skip `outputSchema` subtrees from this scan. The R9 guard
      // exists to prevent INTERNAL/CONFIG fields (e.g. `_apiPaths`,
      // `_cacheKeys`, `_outputBudgetBytes`) leaking onto the wire via
      // buildPublicTool. outputSchema describes legitimate RESPONSE content,
      // which can include any key (e.g. the cache-key-derived labels
      // `_all`, `_countries` produced by the executeTool label walk).
      // Conflating "response-shape descriptor key" with "BaseToolDef internal
      // field" would force schema authors to rename real labels.
      function scanForUnderscoreKey(value, pathStack) {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) scanForUnderscoreKey(value[i], [...pathStack, `[${i}]`]);
        } else if (value && typeof value === 'object') {
          for (const k of Object.keys(value)) {
            if (k === 'outputSchema') continue;
            // `_meta` is the MCP spec-reserved PUBLIC meta field (v1.11.0 MCP
            // Apps emits `_meta.ui.resourceUri` on UI-linked tools). It is an
            // intentional wire field, not an internal BaseToolDef leak — skip
            // its subtree the same way outputSchema is skipped.
            if (k === '_meta') continue;
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

    // ============================================================
    // MCP Apps (io.modelcontextprotocol/ui) — tool → ui:// linkage (v1.11.0)
    // ============================================================
    it('get_country_risk carries _meta.ui.resourceUri + the flat ui/resourceUri alias pointing at the ui:// app shell', async () => {
      const tools = await getRegistry();
      const t = tools.find(t => t.name === 'get_country_risk');
      assert.ok(t, 'get_country_risk must be registered');
      assert.ok(t._meta && typeof t._meta === 'object', 'UI-linked tool must carry a _meta object');
      assert.equal(t._meta.ui?.resourceUri, 'ui://worldmonitor/country-risk.html',
        'nested _meta.ui.resourceUri must point at the registered ui:// resource');
      assert.equal(t._meta['ui/resourceUri'], 'ui://worldmonitor/country-risk.html',
        'the deprecated flat ui/resourceUri alias must mirror the nested form');
    });

    it('a tool WITHOUT a UI surface (get_cyber_threats) omits _meta entirely (no empty object on the wire)', async () => {
      const tools = await getRegistry();
      const t = tools.find(t => t.name === 'get_cyber_threats');
      assert.ok(t, 'get_cyber_threats must be registered');
      assert.ok(!('_meta' in t), 'non-UI tools must not carry a _meta key at all');
    });

    it('describe_tool(get_country_risk) carries the same _meta.ui linkage (uncompressed path)', async () => {
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'describe_tool', arguments: { tool_name: 'get_country_risk' } },
        }),
      }));
      const body = await res.json();
      const full = JSON.parse(body.result.content[0].text);
      assert.equal(full._meta?.ui?.resourceUri, 'ui://worldmonitor/country-risk.html');
      assert.equal(full._meta?.['ui/resourceUri'], 'ui://worldmonitor/country-risk.html');
    });
  });

  // ============================================================
  // U3: TOOL_LIST_RESPONSE compression + describe_tool RPC
  // ============================================================
  describe('tools/list compression + describe_tool RPC', () => {
    async function getToolsList() {
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }));
      const body = await res.json();
      return body.result.tools;
    }

    async function callDescribeTool(tool_name) {
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'describe_tool', arguments: tool_name === undefined ? {} : { tool_name } },
        }),
      }));
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.error, undefined, `describe_tool returned JSON-RPC error: ${JSON.stringify(body.error)}`);
      return JSON.parse(body.result.content[0].text);
    }

    it('tools/list contains 41 tools (40 + describe_tool)', async () => {
      const tools = await getToolsList();
      assert.equal(tools.length, 41);
    });

    it('describe_tool itself appears in tools/list', async () => {
      const tools = await getToolsList();
      assert.ok(tools.find(t => t.name === 'describe_tool'),
        'describe_tool must be discoverable via tools/list');
    });

    it('every tool in tools/list has compressed description ≤ TOOL_DESCRIPTION_MAX_BYTES utf8 bytes', async () => {
      const tools = await getToolsList();
      for (const t of tools) {
        assert.ok(mod.utf8ByteLength(t.description) <= mod.TOOL_DESCRIPTION_MAX_BYTES,
          `tool "${t.name}" description is ${mod.utf8ByteLength(t.description)} bytes (cap ${mod.TOOL_DESCRIPTION_MAX_BYTES})`);
      }
    });

    it('describe_tool({tool_name: "get_market_data"}) returns the FULL uncompressed description', async () => {
      const tools = await getToolsList();
      const compressed = tools.find(t => t.name === 'get_market_data');
      const full = await callDescribeTool('get_market_data');
      assert.ok(mod.utf8ByteLength(full.description) > mod.utf8ByteLength(compressed.description),
        `describe_tool should return longer description than tools/list (full=${mod.utf8ByteLength(full.description)}, compressed=${mod.utf8ByteLength(compressed.description)})`);
      // Full text should NOT have been truncated by compression — verify
      // the v1.4.0 description is longer than the cap so this test is meaningful.
      assert.ok(mod.utf8ByteLength(full.description) > mod.TOOL_DESCRIPTION_MAX_BYTES,
        'test premise: full get_market_data description should exceed the cap');
    });

    it('describe_tool result has the SAME shape as a tools/list entry (name + description + inputSchema + annotations)', async () => {
      const tools = await getToolsList();
      const fromList = tools.find(t => t.name === 'get_market_data');
      const fromDescribe = await callDescribeTool('get_market_data');
      assert.deepEqual(Object.keys(fromList).sort(), Object.keys(fromDescribe).sort());
    });

    it('describe_tool result has inputSchema.properties.jmespath structurally equal to JMESPATH_SCHEMA (R7)', async () => {
      const JMESPATH_SCHEMA = { type: 'string', description: 'Optional JMESPath projection applied to the response. See initialize.instructions for grammar and examples.' };
      const full = await callDescribeTool('get_market_data');
      assert.deepEqual(full.inputSchema.properties.jmespath, JMESPATH_SCHEMA);
    });

    it('describe_tool({tool_name: "nonexistent"}) returns {error: "unknown_tool", available: [...]} (soft error, HTTP 200, NOT a JSON-RPC error)', async () => {
      const env = await callDescribeTool('nonexistent_tool');
      assert.equal(env.error, 'unknown_tool');
      assert.equal(env.requested, 'nonexistent_tool');
      assert.ok(Array.isArray(env.available));
      assert.equal(env.available.length, 41, 'available should list all 41 tools');
      // Sorted alphabetically
      const sorted = [...env.available].sort();
      assert.deepEqual(env.available, sorted);
      assert.ok(env.available.includes('describe_tool'));
    });

    it('describe_tool({}) returns {error: "missing_tool_name"}', async () => {
      const env = await callDescribeTool(undefined);
      assert.equal(env.error, 'missing_tool_name');
    });

    // ============================================================
    // U4: Version bump + SERVER_INSTRUCTIONS + server-card sync
    // ============================================================
    it('serverInfo.version === "1.15.0"', async () => {
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      }));
      const body = await res.json();
      assert.equal(body.result?.serverInfo?.version, '1.15.0');
    });

    it('initialize.result.instructions mentions describe_tool AND the TOOL_DESCRIPTION_MAX_BYTES cap value', async () => {
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      }));
      const body = await res.json();
      const inst = body.result.instructions;
      assert.ok(typeof inst === 'string' && inst.length > 0);
      assert.ok(/describe_tool/i.test(inst), 'instructions should mention describe_tool');
      assert.ok(inst.includes(String(mod.TOOL_DESCRIPTION_MAX_BYTES)),
        'instructions should mention the TOOL_DESCRIPTION_MAX_BYTES cap');
    });

    it('server-card.json version matches SERVER_VERSION (1.15.0) AND tools[] length matches (41)', () => {
      const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
      assert.equal(card.serverInfo.version, '1.15.0');
      // orank (ora.ai) agent-readiness scanner reads the card's `tools` as an
      // ARRAY (tools[]) for pre-connection preview — not the old {count,categories}
      // object. Keep it an array; the count now derives from the length.
      assert.ok(Array.isArray(card.tools), 'server-card tools must be an array (tools[])');
      assert.equal(card.tools.length, 41);
      assert.equal(card.features?.toolDescriptionCompression, true);
      assert.equal(card.features?.responseProjection, 'jmespath',
        'v1.4.0 feature flag must still be present');
    });

    // orank / MCP pre-connection discovery contract. The server-card is a
    // static file; this guard fails loudly if the registry adds/removes/renames
    // a tool or edits a description without regenerating the card, so scanners
    // never preview a stale tool inventory. Regenerate with:
    //   npx tsx -e "import('./api/mcp/registry/index.ts').then(m=>console.log(JSON.stringify(m.TOOL_REGISTRY.map(t=>({name:t.name,description:t.description})),null,2)))"
    it('server-card.json exposes the orank-required top-level fields AND tools[] mirrors the registry', () => {
      const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));

      // Required top-level fields for full MCP-server-card credit.
      assert.equal(typeof card.name, 'string');
      assert.ok(card.name.length > 0, 'top-level name must be non-empty');
      assert.equal(typeof card.description, 'string');
      assert.ok(card.description.length > 0, 'top-level description must be non-empty');
      assert.equal(typeof card.version, 'string');
      assert.ok(card.version.length > 0, 'top-level version must be non-empty');
      assert.equal(typeof card.serverUrl, 'string');
      assert.match(card.serverUrl, /^https:\/\//, 'serverUrl must be an absolute https URL');

      // Top-level mirrors must stay consistent with the nested MCP shapes.
      assert.equal(card.version, card.serverInfo.version, 'top-level version must mirror serverInfo.version');
      assert.equal(card.serverUrl, card.transport.endpoint, 'serverUrl must mirror transport.endpoint');
      assert.equal(card.name, card.serverInfo.name, 'top-level name must mirror serverInfo.name');

      // tools[] must be a name+description projection of the live registry,
      // in the same order.
      const expected = TOOL_REGISTRY.map((t) => ({ name: t.name, description: t.description }));
      assert.deepEqual(
        card.tools,
        expected,
        'server-card tools[] drifted from api/mcp/registry — regenerate the tools array in ' +
          'public/.well-known/mcp/server-card.json from TOOL_REGISTRY (see comment above this test)',
      );
    });

    // ============================================================
    // U5: Reduction-target regression guard (R1: ≥8%)
    // ============================================================
    it('R1: tools/list description compression reduces total envelope vs uncompressed baseline', async () => {
      const tools = await getToolsList();
      // Baseline: same tools EXCEPT describe_tool (v1.5.0 addition),
      // with full uncompressed descriptions. Use describe_tool to recover
      // full text for each tool — same self-contained measurement strategy
      // the U5 script uses.
      const baseline = [];
      for (const t of tools) {
        if (t.name === 'describe_tool') continue;
        const full = await callDescribeTool(t.name);
        baseline.push(full);
      }
      const baselineBytes = mod.utf8ByteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: baseline } }));
      const currentBytes = mod.utf8ByteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } }));
      const reductionPct = ((baselineBytes - currentBytes) / baselineBytes) * 100;
      // Floor lowered from 8% → 4% in v1.6.0. The R1 target was set against a
      // v1.4.0 envelope that did NOT carry outputSchema. v1.6.0 emits an
      // outputSchema on every tool — that adds wire bytes to BOTH the compressed
      // and uncompressed sides equally, which dilutes the % savings even though
      // the description-compression mechanism still saves the same absolute bytes.
      // The 4% floor catches a true regression of the compression mechanism
      // without re-flagging the legitimate v1.6.0 envelope growth.
      assert.ok(reductionPct >= 4,
        `reduction ${reductionPct.toFixed(2)}% below R1 v1.6.0 target (≥4%). baseline=${baselineBytes}B current=${currentBytes}B`);
    });

    it('round-trip: every tool returned by describe_tool has no _-prefixed key (R9)', async () => {
      const tools = await getToolsList();
      // Same rationale as the tools/list-side R9 scan above: outputSchema is
      // a response-shape descriptor whose keys legitimately mirror executeTool's
      // cache-key labels (`_all`, `_countries`, ...). Only the internal
      // BaseToolDef _-prefixed fields should be guarded against here.
      function scanForUnderscoreKey(value, pathStack) {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) scanForUnderscoreKey(value[i], [...pathStack, `[${i}]`]);
        } else if (value && typeof value === 'object') {
          for (const k of Object.keys(value)) {
            if (k === 'outputSchema') continue;
            // `_meta` is the MCP spec-reserved PUBLIC meta field (MCP Apps
            // tool→UI linkage) — intentional wire field, not an internal leak.
            if (k === '_meta') continue;
            if (k.startsWith('_')) {
              throw new Error(`describe_tool leaked internal key "${k}" at ${pathStack.join('.')}`);
            }
            scanForUnderscoreKey(value[k], [...pathStack, k]);
          }
        }
      }
      // Spot-check 3 cache tools + 3 RPC tools + describe_tool itself
      const sample = ['get_market_data', 'get_conflict_events', 'get_chokepoint_status', 'search_flights', 'analyze_situation', 'get_commodity_geo', 'describe_tool'];
      for (const name of sample) {
        if (!tools.find(t => t.name === name)) continue;
        const full = await callDescribeTool(name);
        scanForUnderscoreKey(full, [`describe_tool(${name})`]);
      }
    });
  });
});
