import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HMAC_SECRET,
  callBody,
  makeProDeps,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function validationBody(violations) {
  return new Response(JSON.stringify({ violations }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MCP downstream validation detail', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    const mod = await import(`../api/mcp.ts?validation-detail=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('preserves field violations for a GET RPC 400 through an existing tool', async () => {
    globalThis.fetch = async () => validationBody([
      { field: 'country_code', description: 'country_code is required' },
    ]);

    const response = await mcpHandler(
      proReq('POST', callBody('get_defense_industrial_base', { country_code: '' })),
      makeProDeps().deps,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.error.code, -32602);
    assert.equal(body.error.message, 'Invalid params: downstream validation failed');
    assert.deepEqual(body.error.data.validation_violations, [
      { field: 'country_code', description: 'country_code is required' },
    ]);
  });

  it('preserves field violations for a POST RPC 400 through an existing tool', async () => {
    globalThis.fetch = async () => validationBody([
      { field: 'query', description: 'query must be at least 2 characters' },
    ]);

    const response = await mcpHandler(
      proReq('POST', callBody('search_intel_history', { query: 'x' })),
      makeProDeps().deps,
    );
    const body = await response.json();

    assert.equal(body.error.code, -32602);
    assert.deepEqual(body.error.data.validation_violations, [
      { field: 'query', description: 'query must be at least 2 characters' },
    ]);
  });

  it('bounds the projection: at most 10 violations, capped strings, no extra fields', async () => {
    const upstream = Array.from({ length: 14 }, (_, i) => ({
      field: `field_${i}_${'f'.repeat(100)}`,
      description: `d_${'d'.repeat(300)}`,
      internalDetail: 'SECRET_INTERNAL_SENTINEL',
    }));
    globalThis.fetch = async () => validationBody(upstream);

    const response = await mcpHandler(
      proReq('POST', callBody('search_intel_history', { query: 'x' })),
      makeProDeps().deps,
    );
    const body = await response.json();

    assert.equal(body.error.code, -32602);
    const violations = body.error.data.validation_violations;
    assert.equal(violations.length, 10);
    for (const violation of violations) {
      assert.ok(violation.field.length <= 64);
      assert.ok(violation.description.length <= 200);
      assert.deepEqual(Object.keys(violation).sort(), ['description', 'field']);
    }
    assert.ok(!JSON.stringify(body).includes('SECRET_INTERNAL_SENTINEL'));
  });

  it('keeps the generic contract for malformed, non-JSON, and non-validation 400 bodies', async () => {
    const cases = [
      ['malformed json', () => new Response('not json', { status: 400, headers: { 'Content-Type': 'application/json' } })],
      ['html body', () => new Response('<html>bad</html>', { status: 400, headers: { 'Content-Type': 'text/html' } })],
      ['other json error', () => new Response(JSON.stringify({ error: 'other' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })],
      ['violations not an array', () => new Response(JSON.stringify({ violations: 'not-an-array' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })],
      ['non-string field', () => new Response(JSON.stringify({ violations: [{ field: 1, description: 'x' }] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })],
    ];

    for (const [label, makeResponse] of cases) {
      globalThis.fetch = async () => makeResponse();
      const res = await mcpHandler(
        proReq('POST', callBody('search_intel_history', { query: 'x' })),
        makeProDeps().deps,
      );
      const body = await res.json();
      assert.equal(body.error.code, -32603, `expected generic -32603 for ${label}`);
      assert.equal(body.error.data, undefined);
    }
  });

  it('exposes the shared helper contract directly for MCP-internal callers', async () => {
    const mod = await import(`../api/mcp/downstream.ts?validation-detail=${Date.now()}-${Math.random()}`);
    const observation = {
      operation: 'unit-probe',
      tool: 'unit_probe',
      auth: { kind: 'env_key' },
    };
    const error = await mod.assertMcpToolFetchOk(validationBody([
      { field: 'limit', description: 'limit must be <= 16' },
    ]), observation).then(() => null, (err) => err);

    assert.ok(error instanceof mod.McpValidationDetailError);
    assert.equal(error.safeCode, 'validation_failed');
    assert.deepEqual(error.violations, [{ field: 'limit', description: 'limit must be <= 16' }]);
  });
});
