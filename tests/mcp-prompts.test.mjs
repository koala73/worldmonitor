// MCP prompts wire-contract + JMESPath-vs-schema parity.
//
// Three concerns:
//   1. prompts/list returns the documented six entries with the spec-shaped
//      {name, description, arguments} fields. Detects accidental registry
//      truncation or schema-shape drift.
//   2. prompts/get interpolates ${arg} tokens, surfaces -32602 for unknown
//      names and missing required args. Detects the substitution-grammar
//      regressions that the load-time validator can't see (it only checks
//      authoring; this exercises runtime).
//   3. JMESPath-vs-schema parity (the load-bearing assertion). For every
//      prompt, for every step:
//        a. the step's `tool` exists in TOOL_REGISTRY,
//        b. the step's `jmespath` compiles via the same parser the handler
//           uses at runtime,
//        c. every field identifier the expression references exists as a
//           property NAME somewhere in the referenced tool's outputSchema.
//      A typo'd field path in a prompt OR a renamed field in a tool's schema
//      fails this test by name, citing the prompt and the offending path.
//
// Phase-1 scope: presence-level parity, not full path-level (a Field name
// must appear in the schema somewhere, not necessarily at the exact
// dot-path). This is strong enough to catch both sabotage cases documented
// in the executing-agent notes: a typo'd field name disappears from the
// schema; a renamed schema field disappears from prompts' Field set. Phase 2
// (full path-level eval against fixtures) is a follow-up issue.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import jmespath from 'jmespath';

import {
  BASE_URL,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_prompts';

function makeReq(method = 'POST', body = null, headers = {}) {
  return new Request(BASE_URL, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let handler;
let PROMPT_REGISTRY;
let TOOL_REGISTRY;

describe('api/mcp.ts — prompts capability + JMESPath-vs-schema parity', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_TELEMETRY = 'false';

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-prompts`);
    handler = mod.default;
    PROMPT_REGISTRY = mod.__testing__.PROMPT_REGISTRY;
    TOOL_REGISTRY = mod.__testing__.TOOL_REGISTRY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // -------------------------------------------------------------------------
  // initialize advertises the new capability
  // -------------------------------------------------------------------------
  it('initialize advertises capabilities.prompts.listChanged = false', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.capabilities?.prompts, 'capabilities.prompts must be present');
    assert.equal(
      body.result.capabilities.prompts.listChanged, false,
      'capabilities.prompts.listChanged must be false (stateless transport can\'t push notifications/prompts/list_changed)',
    );
    // Sibling capabilities must NOT be regressed by the additive change.
    assert.ok(body.result.capabilities.tools, 'capabilities.tools must still be present');
    assert.ok(body.result.capabilities.logging, 'capabilities.logging must still be present');
  });

  // -------------------------------------------------------------------------
  // prompts/list shape
  // -------------------------------------------------------------------------
  it('prompts/list returns the six documented entries with name/description/arguments', async () => {
    const res = await handler(makeReq('POST', { jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.prompts), 'result.prompts must be an array');
    assert.equal(body.result.prompts.length, 6, `Expected 6 prompts, got ${body.result.prompts.length}`);

    const expectedNames = [
      'country-briefing', 'energy-shock-watch', 'market-open-prep',
      'conflict-pulse', 'route-risk-check', 'freshness-audit',
    ];
    const actualNames = body.result.prompts.map((p) => p.name);
    assert.deepEqual(actualNames, expectedNames, 'prompt names and order must match the documented set');

    for (const prompt of body.result.prompts) {
      assert.equal(typeof prompt.name, 'string', `prompt ${prompt.name}: name must be a string`);
      assert.ok(prompt.name.length > 0, `prompt ${prompt.name}: name must be non-empty`);
      assert.equal(typeof prompt.description, 'string', `prompt ${prompt.name}: description must be a string`);
      assert.ok(prompt.description.length > 0, `prompt ${prompt.name}: description must be non-empty`);
      assert.ok(Array.isArray(prompt.arguments), `prompt ${prompt.name}: arguments must be an array`);
      for (const arg of prompt.arguments) {
        assert.equal(typeof arg.name, 'string', `prompt ${prompt.name}: argument name must be a string`);
        assert.equal(typeof arg.description, 'string', `prompt ${prompt.name}: argument description must be a string`);
        assert.equal(typeof arg.required, 'boolean', `prompt ${prompt.name}: argument required must be a boolean`);
      }
      // Internal authoring fields must NOT leak via prompts/list.
      assert.equal(prompt.steps, undefined, `prompt ${prompt.name}: internal "steps" must not leak via prompts/list`);
      assert.equal(prompt.intro, undefined, `prompt ${prompt.name}: internal "intro" must not leak via prompts/list`);
    }
  });

  // -------------------------------------------------------------------------
  // prompts/get success
  // -------------------------------------------------------------------------
  it('prompts/get(country-briefing, {iso2: "DE"}) renders the iso2 into the message text', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 3, method: 'prompts/get',
      params: { name: 'country-briefing', arguments: { iso2: 'DE' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.description, 'result.description must be present');
    assert.ok(Array.isArray(body.result?.messages), 'result.messages must be an array');
    assert.ok(body.result.messages.length >= 1, 'result.messages must contain at least one message');

    const msg = body.result.messages[0];
    assert.equal(msg.role, 'user', 'rendered message role must be "user"');
    assert.equal(msg.content?.type, 'text', 'rendered message content.type must be "text"');
    assert.ok(typeof msg.content?.text === 'string', 'rendered message content.text must be a string');
    assert.ok(msg.content.text.includes('DE'), `rendered message must contain the interpolated iso2 "DE" — got: ${msg.content.text.slice(0, 200)}…`);
    // Every step's tool name should appear in the rendered text (so the LLM
    // sees the call plan, not an opaque "do something" instruction).
    for (const expectedTool of ['get_country_risk', 'get_country_brief', 'get_country_macro']) {
      assert.ok(
        msg.content.text.includes(expectedTool),
        `rendered message must reference step tool "${expectedTool}" — got: ${msg.content.text.slice(0, 200)}…`,
      );
    }
  });

  it('prompts/get(energy-shock-watch, {}) renders the "global view" branch when the optional arg is omitted', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 4, method: 'prompts/get',
      params: { name: 'energy-shock-watch', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.result?.messages?.[0]?.content?.text ?? '';
    assert.ok(text.includes('global view'), `optional-arg-absent branch must include "global view" — got: ${text.slice(0, 200)}…`);
  });

  it('prompts/get(energy-shock-watch, {country: "DE"}) renders the country-filter branch', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 5, method: 'prompts/get',
      params: { name: 'energy-shock-watch', arguments: { country: 'DE' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.result?.messages?.[0]?.content?.text ?? '';
    assert.ok(text.includes('for DE'), `optional-arg-present branch must include "for DE" — got: ${text.slice(0, 200)}…`);
  });

  it('prompts/get strips empty-string optional args from the rendered tool-arguments block', async () => {
    // Regression guard: when an optional arg is omitted, the renderer must
    // emit `arguments: {}` (no-filter) — NOT `{"country":""}`. Passing "" to
    // a future tool that guards with `!== undefined` would filter by empty
    // string instead of returning the global view.
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 9, method: 'prompts/get',
      params: { name: 'energy-shock-watch', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.result?.messages?.[0]?.content?.text ?? '';
    assert.ok(
      text.includes('arguments: {}'),
      `omitted optional arg must render as {} — got: ${text.slice(0, 400)}…`,
    );
    assert.ok(
      !text.includes('"country":""'),
      `omitted optional arg must NOT render as {"country":""} — got: ${text.slice(0, 400)}…`,
    );
  });

  // -------------------------------------------------------------------------
  // prompts/get error paths
  // -------------------------------------------------------------------------
  it('prompts/get with an unknown name returns -32602', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 6, method: 'prompts/get',
      params: { name: 'no-such-prompt', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602, `unknown prompt name must be -32602, got ${body.error?.code}`);
    assert.ok(/Unknown prompt/i.test(body.error?.message ?? ''), 'error message should explain the unknown-prompt condition');
  });

  it('prompts/get with a missing required argument returns -32602', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 7, method: 'prompts/get',
      params: { name: 'country-briefing', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602, `missing required arg must be -32602, got ${body.error?.code}`);
    assert.ok(/iso2/.test(body.error?.message ?? ''), 'error message should name the missing required argument');
  });

  it('prompts/get with missing params returns -32602', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 8, method: 'prompts/get',
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602, 'missing params must be -32602');
  });

  // prompts/get is anonymously servable (#4937) and one arg is substituted
  // into several step templates, so an unbounded value is a PUBLIC
  // response-amplification vector. The cap must reject ANONYMOUSLY with a
  // correlatable -32602 (HTTP 200 + echoed id), never by inflating the
  // response.
  it('ANONYMOUS prompts/get with an oversize argument returns -32602 (response-amplification guard)', async () => {
    const res = await handler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 10, method: 'prompts/get',
        params: { name: 'country-briefing', arguments: { iso2: 'X'.repeat(201) } },
      }),
    }));
    assert.equal(res.status, 200, 'oversize arg must reject as a correlatable JSON-RPC error, not an HTTP error');
    const body = await res.json();
    assert.equal(body.id, 10, 'rejection must echo the request id');
    assert.equal(body.error?.code, -32602, `oversize arg must be -32602, got ${body.error?.code}`);
    assert.ok(/200-character limit/.test(body.error?.message ?? ''), 'error message should state the limit');
  });

  it('prompts/get accepts an argument at exactly the 200-character boundary', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 11, method: 'prompts/get',
      params: { name: 'country-briefing', arguments: { iso2: 'X'.repeat(200) } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, `boundary-length arg must be accepted: ${JSON.stringify(body.error)}`);
    assert.ok(Array.isArray(body.result?.messages) && body.result.messages.length > 0);
  });

  // -------------------------------------------------------------------------
  // Tool-name parity (every step.tool exists in TOOL_REGISTRY)
  // -------------------------------------------------------------------------
  it('every prompt step references a tool that exists in TOOL_REGISTRY', () => {
    const toolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const prompt of PROMPT_REGISTRY) {
      for (const [i, step] of prompt.steps.entries()) {
        assert.ok(
          toolNames.has(step.tool),
          `prompt "${prompt.name}" step ${i + 1} references unknown tool "${step.tool}". Known tools: [${[...toolNames].sort().join(', ')}]`,
        );
      }
    }
  });

  // -------------------------------------------------------------------------
  // JMESPath-vs-schema parity (load-bearing)
  // -------------------------------------------------------------------------
  it('every prompt step JMESPath compiles and references only fields declared in the tool\'s outputSchema', () => {
    const toolByName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));

    for (const prompt of PROMPT_REGISTRY) {
      for (const [i, step] of prompt.steps.entries()) {
        const tool = toolByName.get(step.tool);
        assert.ok(tool, `prompt "${prompt.name}" step ${i + 1}: unknown tool "${step.tool}" (covered by sibling test, but guard here too)`);

        // (a) Compiles.
        let ast;
        try {
          ast = jmespath.compile(step.jmespath);
        } catch (err) {
          assert.fail(`prompt "${prompt.name}" step ${i + 1} (${step.tool}): JMESPath failed to compile: ${step.jmespath} — ${(err && err.message) || err}`);
        }
        assert.ok(ast, `prompt "${prompt.name}" step ${i + 1} (${step.tool}): jmespath.compile returned no AST for ${step.jmespath}`);

        // (b) Every Field identifier appears in the tool's outputSchema.
        const referencedFields = collectFieldNames(ast);
        const declaredProps = collectSchemaPropertyNames(tool.outputSchema);
        for (const field of referencedFields) {
          assert.ok(
            declaredProps.has(field),
            `prompt "${prompt.name}" step ${i + 1} (${step.tool}): JMESPath "${step.jmespath}" references field "${field}" which is NOT declared in the tool's outputSchema. Declared (sample): [${[...declaredProps].slice(0, 30).sort().join(', ')}${declaredProps.size > 30 ? ', …' : ''}]`,
          );
        }
      }
    }
  });
});

// -----------------------------------------------------------------------------
// JMESPath AST walker — collect Field identifier names.
//
// Field nodes carry `name` (the source-data identifier). KeyValuePair nodes
// (inside MultiSelectHash) carry `name` too but it's the OUTPUT key, not a
// source field — recurse into `value` only. Same posture for MultiSelectList
// (recurse into each child).
// -----------------------------------------------------------------------------
function collectFieldNames(node) {
  const out = new Set();
  walk(node, out);
  return out;
}
function walk(node, sink) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Field' && typeof node.name === 'string') {
    sink.add(node.name);
    return;
  }
  if (node.type === 'KeyValuePair') {
    // skip node.name (output key), recurse into value
    walk(node.value, sink);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, sink);
  }
  // KeyValuePair handled above; some node types use `.value` for the inner
  // expression (e.g. FilterProjection condition uses `children[2]`; safe
  // because we walk every child of `children`).
  if (node.value && typeof node.value === 'object' && node.value.type) {
    walk(node.value, sink);
  }
}

// -----------------------------------------------------------------------------
// JSON-Schema walker — collect every property NAME at any nesting level.
//
// Presence-level check (Phase 1). Walks:
//   - properties: { foo: <schema> } → adds "foo", recurses into <schema>
//   - additionalProperties: <schema> → recurses (does NOT add a key)
//   - items: <schema> | <schema[]>   → recurses
//   - allOf/oneOf/anyOf: <schema[]>  → recurses each
// Bounded by the schema's own structural depth, which our outputSchemas are
// shallow (≤6 levels). Phase 2 (path-level parity vs. captured fixtures) is
// a follow-up issue.
// -----------------------------------------------------------------------------
function collectSchemaPropertyNames(schema) {
  const out = new Set();
  walkSchema(schema, out);
  return out;
}
function walkSchema(s, sink) {
  if (!s || typeof s !== 'object') return;
  if (s.properties && typeof s.properties === 'object') {
    for (const [name, sub] of Object.entries(s.properties)) {
      sink.add(name);
      walkSchema(sub, sink);
    }
  }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    walkSchema(s.additionalProperties, sink);
  }
  if (s.items) {
    if (Array.isArray(s.items)) for (const sub of s.items) walkSchema(sub, sink);
    else walkSchema(s.items, sink);
  }
  for (const combinator of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(s[combinator])) {
      for (const sub of s[combinator]) walkSchema(sub, sink);
    }
  }
}
