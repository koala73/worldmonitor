// A strict MCP client (the official SDK, and hosts built on it such as Grok
// Bot's) enforces two rules on every `tools/call` whose tool advertised an
// `outputSchema` (#8328):
//
//   1. the result MUST carry `structuredContent` unless `isError` is set, else
//      it throws -32600 "has an output schema but did not return structured
//      content";
//   2. that `structuredContent` MUST validate against the advertised schema,
//      else it throws -32602.
//
// Rule 2 is why the payload cannot simply be copied in: a JMESPath projection
// and the two soft envelopes are not the tool's documented shape. So the
// ADVERTISED schema is `anyOf [documented shape, the non-documented shapes]`,
// and this file checks every response kind against the schema as advertised.
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// Full JSON Schema validation, as the SDK does it (same options as
// tests/mcp-output-schema-coverage.test.mjs).
const ajv = new Ajv2020({
  allErrors: true, allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false,
});

/** What the SDK client does on a tools/call result. Returns an error string, or null when accepted. */
function strictClientVerdict(publicTool, result) {
  if (!publicTool.outputSchema) return null;
  if (result.structuredContent === undefined || result.structuredContent === null) {
    return result.isError ? null : 'has an output schema but did not return structured content (-32600)';
  }
  const sc = result.structuredContent;
  if (typeof sc !== 'object' || Array.isArray(sc)) return 'structuredContent is not a JSON object';
  const validate = ajv.compile(publicTool.outputSchema);
  if (validate(sc)) return null;
  const detail = (validate.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
  return `structuredContent does not match the advertised outputSchema (-32602): ${detail}`;
}

describe('tools/call returns structuredContent a strict client accepts (#8328)', () => {
  let mcpHandler;
  let registry;
  let publicTools;
  const restore = [];

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_structured';
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({}) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
    registry = mod.__testing__.TOOL_REGISTRY;
    const { deps } = makeProDeps();
    const listed = await mcpHandler(proReq('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), deps);
    publicTools = new Map((await listed.json()).result.tools.map((t) => [t.name, t]));
  });

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  /** Replace a tool's `_execute` for one test. */
  function stub(name, fn, patch = {}) {
    const tool = registry.find((t) => t.name === name);
    const before = { _execute: tool._execute, ...Object.fromEntries(Object.keys(patch).map((k) => [k, tool[k]])) };
    tool._execute = fn;
    Object.assign(tool, patch);
    restore.push(() => Object.assign(tool, before));
    return tool;
  }

  async function call(name, args) {
    const { deps } = makeProDeps();
    const res = await mcpHandler(proReq('POST', callBody(name, args)), deps);
    assert.equal(res.status, 200);
    return (await res.json()).result;
  }

  const SOURCES = { view: 'summary', summary: { providerCount: 3 }, providers: [{ id: 'a' }, { id: 'b' }] };

  it('every advertised outputSchema is an object whose first anyOf branch is the documented shape', () => {
    assert.ok(publicTools.size > 0);
    for (const tool of registry) {
      const schema = publicTools.get(tool.name).outputSchema;
      assert.equal(schema.type, 'object', `${tool.name}: root type`);
      assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length >= 2, `${tool.name}: anyOf`);
      assert.deepEqual(schema.anyOf[0], JSON.parse(JSON.stringify(tool.outputSchema)), `${tool.name}: documented shape must stay intact as anyOf[0]`);
    }
  });

  it('a plain call returns the payload as structuredContent, identical to the text', async () => {
    // The real tool, unstubbed: its payload has to satisfy its own documented
    // shape, which a hand-written fixture would not.
    const result = await call('get_sources', {});
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(result.structuredContent.view, 'summary');
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  for (const [label, expr, expected] of [
    ['a scalar', 'summary.providerCount', 3],
    ['an array', 'providers[].id', ['a', 'b']],
    ['an object', 'summary', { providerCount: 3 }],
    ['null (no match)', 'nope.nothing', null],
  ]) {
    it(`a projection to ${label} keeps its text bytes and is wrapped as {projection} in structuredContent`, async () => {
      stub('get_sources', async () => SOURCES);
      const result = await call('get_sources', { jmespath: expr });
      assert.equal(result.content[0].text, JSON.stringify(expected), 'content[0].text must not change');
      assert.deepEqual(result.structuredContent, { projection: expected });
      assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
    });
  }

  it('a bad expression returns the _jmespath_error envelope in both places', async () => {
    stub('get_sources', async () => SOURCES);
    const result = await call('get_sources', { jmespath: '[[[' });
    assert.match(result.structuredContent._jmespath_error, /^invalid_expression/);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  it('an over-budget response returns the _budget_exceeded envelope in both places', async () => {
    stub('get_sources', async () => ({ ...SOURCES, pad: 'x'.repeat(4096) }), { _outputBudgetBytes: 256 });
    const result = await call('get_sources', {});
    assert.equal(result.structuredContent._budget_exceeded, true);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  it('a projection on a licence-bearing tool carries the attribution rider in both places', async () => {
    stub(
      'get_sources',
      async () => ({ ...SOURCES, licence: { attribution: 'CC BY 4.0', source: 'Example Bureau' } }),
      { _attribution: 'licence.{attribution: attribution, source: source}' },
    );
    const result = await call('get_sources', { jmespath: 'summary.providerCount' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.data, 3, 'the rider wraps the projection as {data, _attribution} in the text');
    assert.equal(parsed._attribution.sources[0].source, 'Example Bureau');
    assert.deepEqual(result.structuredContent, parsed, 'an already-wrapped response is not wrapped a second time');
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  it('a cache tool called with summary:true is a reshaped payload, so it is wrapped like a projection', async () => {
    // `summary` turns every list into {count, sample}, which the documented
    // shape (lists typed as arrays) rejects. Found by validating live payloads.
    const name = 'get_conflict_events';
    const plain = await call(name, {});
    assert.deepEqual(plain.structuredContent, JSON.parse(plain.content[0].text), 'unsummarized: sent as is');
    const summarized = await call(name, { summary: true });
    assert.deepEqual(summarized.structuredContent, { projection: JSON.parse(summarized.content[0].text) });
    assert.equal(strictClientVerdict(publicTools.get(name), summarized), null);
  });

  it('a non-object payload is still wrapped, so structuredContent is always a JSON object', async () => {
    stub('get_sources', async () => ['not', 'an', 'object']);
    const result = await call('get_sources', {});
    assert.equal(result.content[0].text, '["not","an","object"]');
    assert.deepEqual(result.structuredContent, { projection: ['not', 'an', 'object'] });
  });
});
