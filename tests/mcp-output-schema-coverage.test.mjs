// Parity test for the per-tool spec `outputSchema` field (v1.6.0).
//
// Covers:
//   1. Every tool in TOOL_REGISTRY declares a non-empty outputSchema with at
//      least one key on outputSchema.properties. Failures name the tool so a
//      future PR adding a tool without an outputSchema fails loudly.
//   2. Every fixture in tests/fixtures/jmespath-samples/ validates against the
//      schema declared by the tool that produced it. Drift between declared
//      schema and the real response shape fails the test by tool name.
//   3. tools/list emits outputSchema on every advertised tool — surfacing the
//      field at the wire boundary in addition to the in-process registry.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validate } from './helpers/json-schema-mini.mjs';

const VALID_KEY = 'wm_test_key_output_schema';
const originalEnv = { ...process.env };

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

describe('api/mcp.ts — per-tool outputSchema coverage (v1.7.0)', () => {
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

  // --------------------------------------------------------------------
  // Test 1 — every tool declares a non-empty outputSchema
  // --------------------------------------------------------------------
  // For cache tools (those with no `_execute`), the envelope helper
  // `cacheEnvelope(dataProperties)` always produces a top-level
  // `properties: { cached_at, stale, data }` — so a "≥1 top-level key"
  // check would pass even for `cacheEnvelope({})` with an empty data map.
  // Drill into `properties.data.properties` for envelope-style tools to
  // catch that foot-gun and ensure the load-bearing per-tool data shape is
  // actually described.
  it('every tool in TOOL_REGISTRY declares a non-empty outputSchema with at least one properties key (and, for cache tools, at least one data.properties key)', () => {
    const registry = mod.__testing__.TOOL_REGISTRY ?? [];
    assert.ok(registry.length >= 40, `expected ≥40 tools, got ${registry.length}`);
    const failures = [];
    for (const tool of registry) {
      const schema = tool.outputSchema;
      if (!schema || typeof schema !== 'object') {
        failures.push(`${tool.name}: outputSchema missing or non-object`);
        continue;
      }
      const props = schema.properties;
      if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
        failures.push(`${tool.name}: outputSchema.properties is empty`);
        continue;
      }
      // Cache tool ⇔ no `_execute`. For these, the top-level shape is the
      // uniform envelope; the per-tool description lives in data.properties.
      const isCacheTool = tool._execute === undefined;
      if (isCacheTool) {
        const dataProps = props.data?.properties;
        if (!dataProps || typeof dataProps !== 'object' || Object.keys(dataProps).length === 0) {
          failures.push(`${tool.name}: cache tool outputSchema.properties.data.properties is empty (cacheEnvelope was called with an empty data map)`);
        }
      }
    }
    assert.deepEqual(failures, [], `tools missing outputSchema:\n  ${failures.join('\n  ')}`);
  });

  // --------------------------------------------------------------------
  // Test 2 — every captured fixture validates against its tool's schema
  // --------------------------------------------------------------------
  // tests/fixtures/jmespath-samples/README.md maps each fixture file to a tool.
  // Drift between declared schema and the real response shape fails by tool.
  const FIXTURES = [
    { file: 'fat-get-market-data.response.json', tool: 'get_market_data' },
    { file: 'medium-get-conflict-events.response.json', tool: 'get_conflict_events' },
    { file: 'thin-get-chokepoint-status.response.json', tool: 'get_chokepoint_status' },
  ];
  for (const { file, tool: toolName } of FIXTURES) {
    it(`${toolName} declared outputSchema validates the captured fixture (${file})`, () => {
      const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
      const fixturePath = path.join(fixtureDir, 'fixtures', 'jmespath-samples', file);
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);
      const errors = validate(tool.outputSchema, fixture);
      assert.deepEqual(errors, [], `fixture ${file} fails schema:\n  ${errors.join('\n  ')}`);
    });
  }

  // --------------------------------------------------------------------
  // Test 3 — outputSchema is emitted on the wire for every tool in tools/list
  // --------------------------------------------------------------------
  // Unconditional emit per decision-point-1 — we want LLM clients to see the
  // schema on 2025-03-26 sessions too (clients ignore unknown fields per spec).
  it('tools/list emits outputSchema on every tool, regardless of MCP_PROTOCOL_FLOOR_2025_06_18', async () => {
    const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const tools = body.result?.tools ?? [];
    assert.ok(tools.length >= 40, `expected ≥40 tools, got ${tools.length}`);
    const missing = tools.filter(t => !t.outputSchema || typeof t.outputSchema !== 'object'
      || !t.outputSchema.properties || Object.keys(t.outputSchema.properties).length === 0)
      .map(t => t.name);
    assert.deepEqual(missing, [], `tools on the wire missing outputSchema:\n  ${missing.join('\n  ')}`);
  });

  // --------------------------------------------------------------------
  // Test 4 — buildPublicTool returns a deep-clone, NOT a reference into the
  // module-level outputSchema literal. Mutating the returned object must not
  // corrupt the registry's source-of-truth schema for the next caller.
  // --------------------------------------------------------------------
  it('buildPublicTool deep-clones outputSchema', () => {
    const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === 'get_market_data');
    const pub = mod.buildPublicTool(tool, { compressDescriptions: true });
    assert.notEqual(pub.outputSchema, tool.outputSchema, 'should not be the same object');
    // Mutate the public copy and confirm the registry value is unchanged.
    pub.outputSchema.poisoned = true;
    assert.equal('poisoned' in tool.outputSchema, false, 'mutation leaked back into TOOL_REGISTRY');
  });
});
