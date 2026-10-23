import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

import { SERVER_VERSION, TOOL_DESCRIPTION_MAX_BYTES, TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES } from '../api/mcp/constants.ts';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { TOOL_CATEGORY_BY_NAME } from '../api/mcp/domains.ts';

const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

// tools/list shipped first-sentence descriptions (≤120 B) from v1.5.0 to
// v1.33.0 and routed agents to describe_tool for the full text. Since v1.34.0
// every registered description must fit TOOL_DESCRIPTION_MAX_BYTES and
// tools/list ships it whole, so the two surfaces carry identical text. These
// tests own that budget: the per-tool cap, the total cap, the no-truncation
// guarantee, and full description coverage of every input-schema property
// (nested oneOf branches included), which is what tool-definition graders
// and agents actually read.
describe('api/mcp.ts — tools/list description budget (v1.34.0)', () => {
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
  // U1: compressDescription backstop + budget constants
  // ============================================================
  describe('compressDescription backstop', () => {
    it('TOOL_DESCRIPTION_MAX_BYTES === 1024 (the OpenAI function-description limit, in bytes)', () => {
      assert.equal(mod.TOOL_DESCRIPTION_MAX_BYTES, 1024);
      assert.equal(TOOL_DESCRIPTION_MAX_BYTES, 1024);
    });

    it('TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES === 64 KiB and exceeds the per-tool cap times a few tools', () => {
      assert.equal(TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES, 65536);
      assert.ok(TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES > TOOL_DESCRIPTION_MAX_BYTES * 8);
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

    it('compressDescriptions=true returns the public shape plus access and weight metadata and no internal keys', async () => {
      const tools = await getRegistry();
      const t = tools.find(t => t.name === 'get_cyber_threats');
      assert.ok(t, 'get_cyber_threats must be registered');
      assert.deepEqual(Object.keys(t).sort(), ['_meta', 'annotations', 'description', 'inputSchema', 'name', 'outputSchema', 'title']);
      assert.deepEqual(t._meta, {
        'worldmonitor/access': 'free-account',
        'worldmonitor/weight': 1,
      });
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

    it('EVERY tool has the JMESPath schema — the projection is universal', async () => {
      const JMESPATH_SCHEMA = { type: 'string', description: 'Optional JMESPath projection applied to the response. See initialize.instructions for grammar and examples.' };
      const tools = await getRegistry();
      for (const t of tools) {
        assert.ok(t.inputSchema?.properties?.jmespath, `tool "${t.name}" missing jmespath schema`);
        assert.deepEqual(t.inputSchema.properties.jmespath, JMESPATH_SCHEMA, `tool "${t.name}" jmespath shape differs`);
      }
      // No roster of tools that omit it. A licence-bearing tool declares an
      // `_attribution` extraction instead and the dispatcher re-attaches its
      // sources after the projection runs — see shared/attribution-rider.ts
      // and the gate in tests/mcp-attribution-rider.test.mjs.
      assert.deepEqual(
        tools.filter((t) => !('jmespath' in (t.inputSchema?.properties ?? {}))).map((t) => t.name),
        [],
      );
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
      assert.equal(t._meta.ui?.resourceUri, 'ui://worldmonitor/country-risk-v3.html',
        'nested _meta.ui.resourceUri must point at the registered ui:// resource');
      assert.equal(t._meta['ui/resourceUri'], 'ui://worldmonitor/country-risk-v3.html',
        'the deprecated flat ui/resourceUri alias must mirror the nested form');
    });

    it('a tool WITHOUT a UI surface carries only the universal markers in _meta', async () => {
      const tools = await getRegistry();
      const t = tools.find(t => t.name === 'get_cyber_threats');
      assert.ok(t, 'get_cyber_threats must be registered');
      assert.deepEqual(t._meta, {
        'worldmonitor/access': 'free-account',
        'worldmonitor/weight': 1,
      });
    });

    it('describe_tool(get_country_risk) carries the same _meta.ui linkage', async () => {
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
      assert.equal(full._meta?.ui?.resourceUri, 'ui://worldmonitor/country-risk-v3.html');
      assert.equal(full._meta?.['ui/resourceUri'], 'ui://worldmonitor/country-risk-v3.html');
    });
  });

  // ============================================================
  // U3: tools/list description budget + describe_tool RPC
  // ============================================================
  describe('tools/list description budget + describe_tool RPC', () => {
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
      if (tool_name === undefined) return body;
      assert.equal(body.error, undefined, `describe_tool returned JSON-RPC error: ${JSON.stringify(body.error)}`);
      return JSON.parse(body.result.content[0].text);
    }

    it('tools/list contains every registered tool', async () => {
      const tools = await getToolsList();
      assert.equal(tools.length, TOOL_REGISTRY.length);
    });

    it('describe_tool itself appears in tools/list', async () => {
      const tools = await getToolsList();
      assert.ok(tools.find(t => t.name === 'describe_tool'),
        'describe_tool must be discoverable via tools/list');
    });

    it('every registered description fits TOOL_DESCRIPTION_MAX_BYTES, so tools/list ships it whole', async () => {
      const over = TOOL_REGISTRY
        .filter((t) => mod.utf8ByteLength(t.description) > mod.TOOL_DESCRIPTION_MAX_BYTES)
        .map((t) => `${t.name}=${mod.utf8ByteLength(t.description)}B`);
      assert.deepEqual(over, [], `descriptions over the ${mod.TOOL_DESCRIPTION_MAX_BYTES}B per-tool budget: ${over.join(', ')}`);
      const tools = await getToolsList();
      for (const t of tools) {
        assert.ok(mod.utf8ByteLength(t.description) <= mod.TOOL_DESCRIPTION_MAX_BYTES,
          `tool "${t.name}" description is ${mod.utf8ByteLength(t.description)} bytes (cap ${mod.TOOL_DESCRIPTION_MAX_BYTES})`);
      }
    });

    it('tools/list carries every description untruncated (identical to the registry text)', async () => {
      const tools = await getToolsList();
      const truncated = [];
      for (const t of tools) {
        const registered = TOOL_REGISTRY.find((r) => r.name === t.name);
        if (t.description !== registered.description) truncated.push(t.name);
      }
      assert.deepEqual(truncated, [], 'tools/list must not compress any registered description');
      // The budget is a real constraint, not a formality: most descriptions
      // are longer than the one-sentence entries v1.5.0 shipped.
      const longer = tools.filter((t) => mod.utf8ByteLength(t.description) > 120).length;
      assert.ok(longer > tools.length / 2, `expected most descriptions to exceed the old 120 B first-sentence cap, got ${longer}/${tools.length}`);
    });

    it('all tools/list descriptions together stay under TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES', async () => {
      const tools = await getToolsList();
      const total = tools.reduce((sum, t) => sum + mod.utf8ByteLength(t.description), 0);
      assert.ok(total <= TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES,
        `tools/list descriptions total ${total} B, over the ${TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES} B budget — tighten descriptions rather than raising the budget`);
    });

    it('access and cost claims in every description agree with _meta access and weight', async () => {
      // The descriptions state tier and cost in prose because hosts show the
      // model the description, not `_meta`. A later tier or fan-out change
      // must fail here rather than leave the prose lying.
      const tools = await getToolsList();
      const failures = [];
      for (const t of tools) {
        const access = t._meta['worldmonitor/access'];
        const weight = t._meta['worldmonitor/weight'];
        const d = t.description;
        for (const [, claimed] of d.matchAll(/weight (\d+) on API plans/g)) {
          if (Number(claimed) !== weight) failures.push(`${t.name}: description says weight ${claimed}, _meta weight is ${weight}`);
        }
        if (/signed-in free allowance/.test(d) && access !== 'free-account') failures.push(`${t.name}: claims the signed-in free allowance but access is ${access}`);
        if (/requires (a |the )?(paid plan|pro\b|[\w ]*subscription)/i.test(d) && access !== 'subscription') failures.push(`${t.name}: claims a paid plan or subscription is required but access is ${access}`);
        if (/credential-free|without credentials|no credentials|anonymous/i.test(d) && access !== 'free') failures.push(`${t.name}: claims anonymous or credential-free access but access is ${access}`);
        if (access === 'free' && !/credential-free|without credentials|no credentials|anonymous|quota-free/i.test(d)) failures.push(`${t.name}: is free but its description does not say so`);
      }
      assert.deepEqual(failures, [], `description claims drifted from _meta:\n${failures.join('\n')}`);
    });

    it('every input-schema property, nested oneOf branches included, carries a description', async () => {
      // Tool-definition graders score schema description coverage; agents read
      // the same text to fill arguments. Walk properties, array items and
      // oneOf/anyOf/allOf branches so a dispatcher tool's per-branch
      // `arguments` objects count too.
      function missingDescriptions(schema, path, out) {
        if (!schema || typeof schema !== 'object') return;
        if (schema.properties && typeof schema.properties === 'object') {
          for (const [key, value] of Object.entries(schema.properties)) {
            const here = `${path}.${key}`;
            if (!(value && typeof value === 'object' && typeof value.description === 'string' && value.description.trim().length > 0)) out.push(here);
            missingDescriptions(value, here, out);
          }
        }
        if (schema.items) missingDescriptions(schema.items, `${path}[]`, out);
        for (const branch of ['oneOf', 'anyOf', 'allOf']) {
          if (Array.isArray(schema[branch])) schema[branch].forEach((s, i) => missingDescriptions(s, `${path}<${branch}${i}>`, out));
        }
      }
      const tools = await getToolsList();
      const missing = [];
      for (const t of tools) missingDescriptions(t.inputSchema, t.name, missing);
      assert.deepEqual(missing, [], `input-schema properties without a description:\n${missing.join('\n')}`);
    });

    it('discovery descriptions identify supply and economic data without unsupported capabilities', async () => {
      const tools = await getToolsList();
      const supply = tools.find(t => t.name === 'get_supply_vulnerabilities');
      const chokepoint = tools.find(t => t.name === 'get_chokepoint_dependencies');
      const economic = tools.find(t => t.name === 'get_economic_data');
      assert.match(supply.description, /country.*commodity.*supply/i);
      assert.match(chokepoint.description, /country.*commodity.*chokepoint/i);
      for (const tool of [supply, chokepoint]) {
        assert.match(tool.description, /absent score means insufficient.*never zero risk/i);
      }
      assert.match(economic.description, /rates.*calendars.*fuel prices/i);
      const full = await callDescribeTool('get_economic_data');
      assert.doesNotMatch(full.description, /energy storage/i);
    });

    it('get_price_and_debt_indicators advertises price and debt indicators without a tariff series', async () => {
      const tools = await getToolsList();
      const listed = tools.find(t => t.name === 'get_price_and_debt_indicators').description;
      assert.ok(mod.utf8ByteLength(listed) <= mod.TOOL_DESCRIPTION_MAX_BYTES);
      assert.match(listed, /Big Mac/);
      assert.match(listed, /FAO/);
      assert.match(listed, /debt/i);
      assert.match(listed, /No tariff rates/);
      assert.doesNotMatch(listed, /Despite the name/);
      const full = await callDescribeTool('get_price_and_debt_indicators');
      assert.match(full.description, /Big Mac/);
      assert.match(full.description, /FAO/);
      assert.match(full.description, /debt/i);
      assert.match(full.description, /No tariff rates/);
    });

    for (const name of ['get_tariff_averages', 'get_bilateral_tariff']) {
      it(`${name} describes its schedule coverage before the call without routing to another tool`, async () => {
        const tools = await getToolsList();
        const listed = tools.find(t => t.name === name).description;
        assert.ok(mod.utf8ByteLength(listed) <= mod.TOOL_DESCRIPTION_MAX_BYTES);
        assert.match(listed, /schedule/i);
        if (name === 'get_tariff_averages') {
          assert.match(listed, /coverage\.dataset/);
          assert.match(listed, /coverage\.latestYear/);
          assert.doesNotMatch(listed, /schedule rates through \d{4}|Series run from about 1990 to \d{4}/);
          assert.match(listed, /US preferences.*2021/);
        } else {
          assert.match(listed, /2023/);
        }
        assert.match(listed, /Section 301/);
        const full = await callDescribeTool(name);
        assert.match(full.description, /unilateral duties are NOT included/);
        assert.doesNotMatch(full.description, /get_us_import_duty/);
      });
    }

    it('get_us_import_duty says "current" and "Section 301" before the call', async () => {
      const tools = await getToolsList();
      const listed = tools.find(t => t.name === 'get_us_import_duty').description;
      assert.ok(mod.utf8ByteLength(listed) <= mod.TOOL_DESCRIPTION_MAX_BYTES);
      assert.match(listed, /current/i);
      assert.match(listed, /Section 301/i);
    });

    it('describe_tool({tool_name: "get_market_data"}) returns the same description tools/list ships', async () => {
      const tools = await getToolsList();
      const listed = tools.find(t => t.name === 'get_market_data');
      const full = await callDescribeTool('get_market_data');
      assert.equal(full.description, listed.description);
      assert.ok(mod.utf8ByteLength(full.description) > 120,
        'test premise: get_market_data carries more than a one-sentence description');
    });

    it('describe_tool result has the SAME shape as a tools/list entry (name + description + inputSchema + annotations)', async () => {
      const tools = await getToolsList();
      const fromList = tools.find(t => t.name === 'get_market_data');
      const fromDescribe = await callDescribeTool('get_market_data');
      assert.deepEqual(Object.keys(fromList).sort(), Object.keys(fromDescribe).sort());
    });

    it('describe_tool returns the complete country section definition, equal to its tools/list entry, within its budget', async () => {
      const tools = await getToolsList();
      const listed = tools.find(tool => tool.name === 'get_country_brief_section');
      const definition = await callDescribeTool('get_country_brief_section');
      const registered = TOOL_REGISTRY.find(tool => tool.name === 'get_country_brief_section');
      assert.equal(definition._budget_exceeded, undefined);
      assert.equal(definition.description, registered.description);
      assert.deepEqual(definition, listed);
    });

    // describe_tool's own output budget must hold the largest full definition;
    // otherwise that tool's describe_tool call returns _budget_exceeded.
    it('describe_tool returns the full definition of every registered tool within its budget', async () => {
      const overBudget = [];
      for (const tool of TOOL_REGISTRY) {
        const definition = await callDescribeTool(tool.name);
        if (definition._budget_exceeded !== undefined) overBudget.push(tool.name);
      }
      assert.deepEqual(overBudget, []);
    });

    it('country output schema requires raw evidence only for the raw Signals section', async () => {
      const { assembleRawSignals, failedRawSignal, RAW_SIGNAL_FAMILIES } = await import('../shared/country-raw-signals.ts');
      const time = '2026-10-05T12:00:00Z';
      const sources = Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => [family, failedRawSignal(family, 'unavailable', time, 'Controlled failure')]));
      const result = assembleRawSignals('US', sources, time);
      const schema = TOOL_REGISTRY.find(tool => tool.name === 'get_country_brief_section').outputSchema;
      const validate = new Ajv2020({ strict: false }).compile(schema);
      assert.equal(validate(result), true);
      for (const state of ['ready', 'locked', 'unavailable']) {
        assert.equal(validate({ state, section: 'signalsRaw' }), false,
          `raw Signals ${state} output must include source evidence`);
      }
      const missingFamily = structuredClone(result);
      delete missingFamily.value.sources.thermal;
      assert.equal(validate(missingFamily), false);
      assert.equal(validate({ ...result, value: { countryCode: 'US' } }), false);
      assert.equal(validate({ state: 'ready', section: 'facts', value: { capital: 'Washington' } }), true);
      assert.equal(validate({ state: 'ready', value: {} }), false);
    });

    it('country section input schema still validates each branch after the descriptions were added', () => {
      const schema = TOOL_REGISTRY.find(tool => tool.name === 'get_country_brief_section').inputSchema;
      const validate = new Ajv2020({ strict: false }).compile(schema);
      assert.equal(validate({ section: 'facts', arguments: { country_code: 'US' } }), true);
      assert.equal(validate({ section: 'flows', arguments: { reporter_code: '840', cmd_code: '', anomalies_only: 'false' } }), true);
      assert.equal(validate({ section: 'facts', arguments: { country_code: 'US', extra: 1 } }), false, 'unknown keys stay rejected');
      assert.equal(validate({ section: 'facts', arguments: { iso2: 'US' } }), false, 'a branch keeps its own key names');
      for (const branch of schema.oneOf) {
        assert.equal(typeof branch.properties.section.description, 'string');
        assert.equal(typeof branch.properties.arguments.description, 'string');
      }
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
      assert.equal(
        env.available.length,
        TOOL_REGISTRY.length,
        'available should list every registered tool',
      );
      // Sorted alphabetically
      const sorted = [...env.available].sort();
      assert.deepEqual(env.available, sorted);
      assert.ok(env.available.includes('describe_tool'));
    });

    it('describe_tool({}) returns Invalid params', async () => {
      const env = await callDescribeTool(undefined);
      assert.equal(env.error?.code, -32602);
      assert.equal(env.error.data.violations[0].field, 'tool_name');
    });

    // ============================================================
    // U4: Version bump + SERVER_INSTRUCTIONS + server-card sync
    // ============================================================
    it('serverInfo.version === SERVER_VERSION', async () => {
      const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      }));
      const body = await res.json();
      assert.equal(body.result?.serverInfo?.version, SERVER_VERSION);
    });

    it('initialize.result.instructions mentions describe_tool, the per-tool cap value, and no longer claims compression', async () => {
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
      assert.match(inst, /complete description/i, 'instructions should say tools/list ships the complete description');
      assert.doesNotMatch(inst, /compressed tool descriptions|uncompressed/i, 'instructions must not describe tools/list as compressed');
    });

    it('server-card.json version matches SERVER_VERSION and tools[] matches the registry count', () => {
      const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
      assert.equal(card.serverInfo.version, SERVER_VERSION);
      // orank (ora.ai) agent-readiness scanner reads the card's `tools` as an
      // ARRAY (tools[]) for pre-connection preview — not the old {count,categories}
      // object. Keep it an array; the count now derives from the length.
      assert.ok(Array.isArray(card.tools), 'server-card tools must be an array (tools[])');
      assert.equal(card.tools.length, TOOL_REGISTRY.length);
      assert.equal(card.features?.toolDescriptionCompression, undefined, 'the v1.5.0 compression flag must be gone from the card');
      assert.equal(card.features?.toolDescriptionMaxBytes, TOOL_DESCRIPTION_MAX_BYTES,
        'the card advertises the per-tool description budget tools/list enforces');
      assert.equal(card.features?.responseProjection, 'jmespath',
        'v1.4.0 feature flag must still be present');
    });

    // orank / MCP pre-connection discovery contract. The server-card is a
    // static file; this guard fails loudly if the registry adds/removes/renames
    // a tool or edits a description without regenerating the card, so scanners
    // never preview a stale tool inventory. Regenerate with:
    //   npm run product:facts
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
      assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/, 'top-level name must be reverse-DNS (Server Card schema)');

      // tools[] must be a name+description projection of the live registry,
      // plus the same access marker and MCP Apps link tools/list emits and the
      // card-only category from api/mcp/domains.ts, in the same order.
      const expected = TOOL_REGISTRY.map((t) => ({
        name: t.name,
        description: t.description,
        _meta: {
          ...(t._uiResourceUri ? { ui: { resourceUri: t._uiResourceUri } } : {}),
          'worldmonitor/access': toolAccess(t),
          'worldmonitor/category': TOOL_CATEGORY_BY_NAME[t.name],
        },
      }));
      assert.deepEqual(
        card.tools,
        expected,
        'server-card tools[] drifted from api/mcp/registry — regenerate the tools array in ' +
          'public/.well-known/mcp/server-card.json from TOOL_REGISTRY (see comment above this test)',
      );
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
