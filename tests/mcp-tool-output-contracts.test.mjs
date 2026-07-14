// Per-tool output-shape contract regression. For every tool in
// `__testing__.TOOL_REGISTRY`, dispatch a `tools/call` through the public
// handler with default-ish arguments and assert the returned `content[0].text`
// JSON validates against that tool's declared `outputSchema`.
//
// Coverage scope (documented intent — see PR body):
//   • Cache tools (no `_execute`): real dispatch pipeline. fetch is stubbed
//     so every cache-key read returns a non-null `{}` payload, executeTool
//     assembles the envelope, and the test validates the response. This
//     catches envelope-shape regression (missing `cached_at` / `stale`,
//     wrong `data` shape, executeTool stripping the envelope, etc.).
//   • RPC tools (has `_execute`): `_execute` is monkey-patched to return a
//     minimal-shape object derived from the declared `outputSchema`. This
//     proves the schema declaration is internally consistent (a `required`
//     field whose type allows no concrete value would fail) and that the
//     dispatch pipeline preserves the response unchanged through
//     `applyJmespath` and `rpcOk`. It does NOT exercise the real `_execute`
//     body — field-level shape drift for RPC tools is OUT OF SCOPE and is
//     covered indirectly by the per-fixture parity test in
//     `mcp-output-schema-coverage.test.mjs` (3 cache tools today).
//
// One `it()` per tool so a failure names the offending tool.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validate } from './helpers/json-schema-mini.mjs';
import {
  HMAC_SECRET,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// Required-args table. Tools whose `inputSchema.required` is non-empty must
// receive concrete values — anything else trips the runtime arg validation
// before reaching dispatch. Values are deliberately benign and aligned with
// each tool's documented format (e.g. ISO 3166-1 alpha-2 for country_code).
const REQUIRED_ARGS = {
  get_country_brief: { country_code: 'US' },
  get_country_risk: { country_code: 'US' },
  get_consumer_prices: { country_code: 'US' },
  get_airspace: { country_code: 'US' },
  get_maritime_activity: { country_code: 'US' },
  analyze_situation: { query: 'test query' },
  search_flights: { origin: 'JFK', destination: 'LHR', departure_date: '2026-06-01' },
  search_flight_prices_by_date: {
    origin: 'JFK', destination: 'LHR', start_date: '2026-06-01', end_date: '2026-06-10',
  },
  describe_tool: { tool_name: 'get_market_data' },
};

// Generate the smallest concrete value satisfying a JSON-Schema-subset
// description. Used to fabricate minimal-shape responses for RPC `_execute`
// overrides. The implementation is intentionally narrow — it mirrors the
// vocabulary the registry actually emits (`type`, `properties`, `required`,
// `items`).
function minimalShape(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const types = Array.isArray(schema.type)
    ? schema.type
    : (schema.type ? [schema.type] : []);
  if (types.includes('object') || schema.properties) {
    const obj = {};
    for (const key of (schema.required ?? [])) {
      obj[key] = minimalShape(schema.properties?.[key] ?? {});
    }
    return obj;
  }
  if (types.includes('array')) return [];
  if (types.includes('string')) return '';
  if (types.includes('number') || types.includes('integer')) return 0;
  if (types.includes('boolean')) return false;
  if (types.includes('null')) return null;
  return null;
}

describe('api/mcp.ts — per-tool output contract (envelope-shape, all 41 tools)', () => {
  let mod;
  let mcpHandler;
  let originalExecutes;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_tool_contracts';
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';

    // Upstash GET shape with a non-null `{}` payload. unwrapEnvelope sees no
    // `_seed.fetchedAt`, returns `{}` as the bare value, so executeTool's
    // F6 cache_all_null guard passes (every read is a real-but-empty object,
    // not null) and the envelope is assembled. Meta reads also resolve to
    // `{}` → evaluateFreshness returns `{cached_at: null, stale: true}`,
    // both of which validate against `cacheEnvelope`'s nullable cached_at
    // and boolean stale.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({}) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
    originalExecutes = new Map();
  });

  afterEach(() => {
    // Restore any monkey-patched `_execute` so a later test (or a re-import
    // that reuses a cached module) sees the production body.
    for (const [tool, original] of originalExecutes.entries()) {
      tool._execute = original;
    }
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // node-test registers test cases during synchronous `describe()`
  // evaluation, so per-tool `it()` generation needs the tool list before
  // any `await`. Reading the source file is the cheapest synchronous way
  // to enumerate the registry without forking the source-of-truth (the
  // `_execute` presence is determined at runtime inside each `it()` via
  // the freshly-imported module).
  const REGISTRY_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'api', 'mcp', 'registry',
  );
  const TOOL_NAMES = (() => {
    const cacheSrc = readFileSync(path.join(REGISTRY_DIR, 'cache-tools.ts'), 'utf8');
    const rpcSrc = readFileSync(path.join(REGISTRY_DIR, 'rpc-tools.ts'), 'utf8');
    const src = cacheSrc + '\n' + rpcSrc;
    assert.ok(src.includes('CACHE_TOOLS'), 'CACHE_TOOLS declaration not found in api/mcp/registry/cache-tools.ts');
    assert.ok(src.includes('RPC_TOOLS'), 'RPC_TOOLS declaration not found in api/mcp/registry/rpc-tools.ts');
    const matches = [...src.matchAll(/^\s{4}name:\s+'([a-z0-9_]+)'/gm)];
    return matches.map((m) => m[1]);
  })();
  assert.ok(TOOL_NAMES.length >= 41, `expected >= 41 tools, got ${TOOL_NAMES.length}`);

  for (const name of TOOL_NAMES) {
    it(`${name} — tools/call response validates against declared outputSchema`, async () => {
      const tool = mod.__testing__.TOOL_REGISTRY.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} not found in fresh module registry`);
      const isCacheTool = typeof tool._execute !== 'function';

      // RPC tools: override `_execute` with a minimal-shape stub so the test
      // does not depend on internal HTTP endpoints. The minimal shape is
      // derived from the tool's `outputSchema` and proves the declared
      // schema is internally consistent (no `required` field of an
      // impossible type) and that the dispatch pipeline preserves the
      // response through `applyJmespath` + `rpcOk`. Original `_execute`
      // is restored in `afterEach`.
      if (!isCacheTool) {
        originalExecutes.set(tool, tool._execute);
        const stubReturn = minimalShape(tool.outputSchema);
        tool._execute = async () => stubReturn;
      }

      const args = REQUIRED_ARGS[name] ?? {};
      const { deps } = makeProDeps();
      const res = await mcpHandler(proReq('POST', callBody(name, args)), deps);

      assert.equal(res.status, 200, `tools/call must return 200 for ${name}`);
      const body = await res.json();
      assert.ok(
        body?.result?.content?.[0]?.text,
        `tools/call response for ${name} missing content[0].text`,
      );
      const parsed = JSON.parse(body.result.content[0].text);

      // Cache tools must always carry the envelope keys, regardless of the
      // schema's per-tool `data.properties`. Asserting these explicitly here
      // means a regression that strips the envelope is caught by name, not
      // by a deeper validate() error message.
      if (isCacheTool) {
        assert.ok('cached_at' in parsed, `${name}: envelope missing cached_at`);
        assert.ok('stale' in parsed, `${name}: envelope missing stale`);
        assert.equal(typeof parsed.stale, 'boolean', `${name}: envelope.stale not boolean`);
      }

      const errors = validate(tool.outputSchema, parsed);
      assert.deepEqual(
        errors, [],
        `${name}: response fails outputSchema:\n  ${errors.join('\n  ')}`,
      );
    });
  }
});
