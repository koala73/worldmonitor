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
import { TOOL_ALIASES } from '../api/mcp/registry/index.ts';
import { DEPRECATION_NOTICE_SCHEMA } from '../api/mcp/structured-content.ts';

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
  const projections = [
    ['a scalar', 'summary.providerCount', 3],
    ['zero', '`0`', 0],
    ['false', '`false`', false],
    ['a string', "'provider'", 'provider'],
    ['an array', 'providers[].id', ['a', 'b']],
    ['an object', 'summary', { providerCount: 3 }],
    ['null (no match)', 'nope.nothing', null],
  ];

  it('every advertised outputSchema is an object whose first anyOf branch is the documented shape', () => {
    assert.ok(publicTools.size > 0);
    for (const tool of registry) {
      const schema = publicTools.get(tool.name).outputSchema;
      assert.equal(schema.type, 'object', `${tool.name}: root type`);
      assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length >= 2, `${tool.name}: anyOf`);
      const expected = JSON.parse(JSON.stringify(tool.outputSchema));
      if (TOOL_ALIASES.targetNames().has(tool.name)) {
        expected.properties = {
          ...expected.properties,
          deprecation: JSON.parse(JSON.stringify(DEPRECATION_NOTICE_SCHEMA)),
        };
      }
      assert.deepEqual(schema.anyOf[0], expected, `${tool.name}: documented shape must stay intact as anyOf[0]`);
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

  it('the real get_sources summary projection retains the raw count and the structured wrapper', async () => {
    const plain = await call('get_sources', { view: 'summary' });
    const count = plain.structuredContent.summary.providerCount;
    assert.equal(typeof count, 'number');
    const projected = await call('get_sources', { view: 'summary', jmespath: 'summary.providerCount' });
    assert.equal(projected.content[0].text, JSON.stringify(count));
    assert.deepEqual(projected.structuredContent, { projection: count });
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), projected), null);
  });

  for (const [label, expr, expected] of projections) {
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

  for (const [label, expr, expected] of [...projections, ['an invalid expression', '[[[', undefined]]) {
    it(`a projection to ${label} carries attribution in both channels when source attribution is present`, async () => {
      stub(
        'get_sources',
        async () => ({ ...SOURCES, licence: { attribution: 'CC BY 4.0', source: 'Example Bureau' } }),
        { _attribution: 'licence.{attribution: attribution, source: source}' },
      );
      const result = await call('get_sources', { jmespath: expr });
      const parsed = JSON.parse(result.content[0].text);
      if (expected === undefined) assert.match(parsed.data._jmespath_error, /^invalid_expression/);
      else assert.deepEqual(parsed.data, expected);
      assert.equal(parsed._attribution.sources[0].source, 'Example Bureau');
      assert.deepEqual(result.structuredContent, parsed);
      assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
    });
  }

  it('an attribution declaration with no source values keeps the raw projection text', async () => {
    stub('get_sources', async () => SOURCES, { _attribution: 'licence.{attribution: attribution}' });
    const result = await call('get_sources', { jmespath: 'summary.providerCount' });
    assert.equal(result.content[0].text, '3');
    assert.deepEqual(result.structuredContent, { projection: 3 });
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  it('an attribution rider that exceeds the budget replaces both channels with the budget envelope', async () => {
    stub('get_sources', async () => ({ ...SOURCES, licence: { attribution: 'CC BY 4.0' } }), {
      _attribution: 'licence.{attribution: attribution}',
      _outputBudgetBytes: 8,
    });
    const result = await call('get_sources', { jmespath: 'summary.providerCount' });
    assert.equal(result.structuredContent._budget_exceeded, true);
    assert.ok(result.structuredContent.actual_bytes > result.structuredContent.budget_bytes);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  it('a projection of fitted output keeps coverage outside the projection in both channels', async () => {
    const transportCoverage = { omitted_count: 1, omission_reason: 'output_budget' };
    stub('get_sources', async () => ({ pad: 'x'.repeat(4096) }), {
      _outputBudgetBytes: 256,
      _fitToBudget: () => ({ pad: 'fitted', transportCoverage }),
    });
    const result = await call('get_sources', { jmespath: 'pad' });
    assert.deepEqual(result.structuredContent, { projection: 'fitted', transportCoverage });
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(strictClientVerdict(publicTools.get('get_sources'), result), null);
  });

  it('a cache tool called with summary:true is a reshaped payload, so it is wrapped like a projection', async () => {
    // `summary` turns every list into {count, sample}, which the documented
    // shape (lists typed as arrays) rejects. Found by validating live payloads.
    const name = 'get_conflict_events';
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: JSON.stringify({ events: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }),
    }), { headers: { 'Content-Type': 'application/json' } });
    const plain = await call(name, {});
    assert.deepEqual(plain.structuredContent, JSON.parse(plain.content[0].text), 'unsummarized: sent as is');
    const summarized = await call(name, { summary: true });
    assert.deepEqual(summarized.structuredContent, { projection: JSON.parse(summarized.content[0].text) });
    const events = summarized.structuredContent.projection.data['ucdp-events'].events;
    assert.deepEqual(events, { count: 4, sample: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    assert.equal(strictClientVerdict(publicTools.get(name), summarized), null);
    const projected = await call(name, { summary: true, jmespath: 'data."ucdp-events".events.count' });
    assert.equal(projected.content[0].text, '4');
    assert.deepEqual(projected.structuredContent, { projection: 4 });
    assert.equal(strictClientVerdict(publicTools.get(name), projected), null);
  });

  it('a non-object payload is still wrapped, so structuredContent is always a JSON object', async () => {
    stub('get_sources', async () => ['not', 'an', 'object']);
    const result = await call('get_sources', {});
    assert.equal(result.content[0].text, '["not","an","object"]');
    assert.deepEqual(result.structuredContent, { projection: ['not', 'an', 'object'] });
  });
});
