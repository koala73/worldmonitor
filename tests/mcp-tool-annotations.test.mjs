// Parity test for the per-tool spec `Tool.annotations` object (v1.7.0).
//
// Covers:
//   1. Every tool in TOOL_REGISTRY declares an `annotations` object with all
//      four spec hints (readOnlyHint, destructiveHint, idempotentHint,
//      openWorldHint), each typed strictly as boolean. Failures name the
//      tool + missing field so a future PR adding a tool without an
//      explicit per-hint choice fails loudly.
//   2. tools/list emits the full four-field annotations object on every
//      advertised tool — surfacing the field at the wire boundary in
//      addition to the in-process registry.
//   3. buildPublicTool deep-clones annotations. Mutating the returned
//      object must not corrupt the registry's source-of-truth literal —
//      same isolation guarantee as inputSchema.properties + outputSchema.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

const VALID_KEY = 'wm_test_key_tool_annotations';
const originalEnv = { ...process.env };

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

const REQUIRED_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

describe('api/mcp.ts — per-tool annotations coverage (v1.7.0)', () => {
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
  // Test 1 — every tool declares all four annotation hints as booleans
  // --------------------------------------------------------------------
  it('every tool in TOOL_REGISTRY declares all four annotation hints as strict booleans (no undefined, no defaulting)', () => {
    const registry = mod.__testing__.TOOL_REGISTRY ?? [];
    assert.ok(registry.length >= 40, `expected ≥40 tools, got ${registry.length}`);
    const failures = [];
    for (const tool of registry) {
      const ann = tool.annotations;
      if (!ann || typeof ann !== 'object') {
        failures.push(`${tool.name}: annotations missing or non-object`);
        continue;
      }
      for (const hint of REQUIRED_HINTS) {
        if (typeof ann[hint] !== 'boolean') {
          failures.push(`${tool.name}.annotations.${hint}: expected boolean, got ${ann[hint] === undefined ? 'undefined' : typeof ann[hint]}`);
        }
      }
    }
    assert.deepEqual(failures, [], `tools missing strict-boolean annotations:\n  ${failures.join('\n  ')}`);
  });

  // --------------------------------------------------------------------
  // Test 2 — annotations emitted on the wire for every tool in tools/list
  // --------------------------------------------------------------------
  // Mirrors the source-of-truth scan in Test 1 against the wire payload so
  // a future buildPublicTool change that drops a hint fails here, not later
  // in a client-side parser.
  it('tools/list emits all four annotation hints on every tool', async () => {
    const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const tools = body.result?.tools ?? [];
    assert.ok(tools.length >= 40, `expected ≥40 tools, got ${tools.length}`);
    const failures = [];
    for (const t of tools) {
      if (!t.annotations || typeof t.annotations !== 'object') {
        failures.push(`${t.name}: annotations missing on the wire`);
        continue;
      }
      for (const hint of REQUIRED_HINTS) {
        if (typeof t.annotations[hint] !== 'boolean') {
          failures.push(`${t.name}.annotations.${hint}: expected boolean on the wire, got ${typeof t.annotations[hint]}`);
        }
      }
    }
    assert.deepEqual(failures, [], `tools on the wire missing annotations:\n  ${failures.join('\n  ')}`);
  });

  // --------------------------------------------------------------------
  // Test 3 — buildPublicTool deep-clones annotations
  // --------------------------------------------------------------------
  // Same isolation contract as outputSchema (mcp-output-schema-coverage
  // Test 4). Scope: this test exercises the buildPublicTool direct call
  // path only — it confirms that mutating the object buildPublicTool
  // returns does NOT leak back into TOOL_REGISTRY. The production
  // tools/list handler returns the precomputed module-private
  // TOOL_LIST_RESPONSE array (built once at module load via the same
  // buildPublicTool helper), then JSON.stringify's it before sending —
  // so the wire copy is always a fresh allocation regardless. The
  // in-process static cache is not exported and has no test-reachable
  // mutation surface; what we're guarding here is the registry-literal-
  // sharing foot-gun, not the static cache.
  it('buildPublicTool deep-clones annotations (mutation does not leak into TOOL_REGISTRY)', () => {
    const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === 'get_market_data');
    const pub = mod.buildPublicTool(tool, { compressDescriptions: true });
    assert.notEqual(pub.annotations, tool.annotations, 'should not be the same object');
    pub.annotations.readOnlyHint = !pub.annotations.readOnlyHint;
    pub.annotations.poisoned = true;
    // Re-read source-of-truth and confirm nothing leaked.
    const tool2 = mod.__testing__.TOOL_REGISTRY.find(t => t.name === 'get_market_data');
    assert.equal(tool2.annotations.readOnlyHint, true, 'readOnlyHint mutation leaked back into TOOL_REGISTRY');
    assert.equal('poisoned' in tool2.annotations, false, 'novel key leaked back into TOOL_REGISTRY');
  });
});
