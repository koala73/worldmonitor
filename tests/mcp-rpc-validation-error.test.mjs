// #6559 — proto/sebuf ValidationError 400s must reach MCP callers as
// structured JSON-RPC error data (`error.code === -32602`,
// `error.data.violations`), not a tools/call result envelope and not the
// generic -32603 "Internal error: data fetch failed".
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { downstreamErrorTags } from '../api/mcp/downstream.ts';

const ORIGINAL_FETCH = globalThis.fetch;
process.env.MCP_TELEMETRY = 'false';

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.MCP_TELEMETRY = 'false';
});

function json400(violations) {
  return new Response(JSON.stringify({ violations }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function callTool(name, args, fetchImpl) {
  globalThis.fetch = fetchImpl;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await dispatchToolsCall(
      new Request('http://localhost/mcp'),
      { kind: 'env_key', apiKey: 'test' },
      {},
      { id: 42, params: { name, arguments: args } },
      {},
    );
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

describe('MCP RPC ValidationError preservation', () => {
  it('registry still exposes the GET and POST tools this contract covers', () => {
    assert.ok(TOOL_REGISTRY.some((tool) => tool.name === 'get_food_stocks'));
    assert.ok(TOOL_REGISTRY.some((tool) => tool.name === 'analyze_situation'));
  });

  it('GET get_food_stocks 400 returns JSON-RPC -32602 with data.violations', async () => {
    const res = await callTool(
      'get_food_stocks',
      {},
      async (input) => {
        const url = String(typeof input === 'string' ? input : input.url);
        assert.match(url, /\/api\/resilience\/v1\/get-food-stocks/);
        return json400([{ field: 'countryCode', description: 'countryCode is required' }]);
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error?.message, 'Invalid params');
    assert.deepEqual(body.error?.data, {
      violations: [{ field: 'countryCode', description: 'countryCode is required' }],
    });
    assert.equal(body.result, undefined);
  });

  it('POST analyze_situation 400 returns JSON-RPC -32602 with data.violations', async () => {
    const res = await callTool(
      'analyze_situation',
      { query: '' },
      async (input) => {
        const url = String(typeof input === 'string' ? input : input.url);
        assert.match(url, /\/api\/intelligence\/v1\/deduct-situation/);
        return json400([{ field: 'query', description: 'query is required' }]);
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
    assert.deepEqual(body.error?.data?.violations, [
      { field: 'query', description: 'query is required' },
    ]);
    assert.equal(body.result, undefined);
  });

  it('untrusted 400 bodies stay on the generic -32603 fallback', async () => {
    const res = await callTool(
      'get_food_stocks',
      { country_code: 'EG' },
      async () => new Response('<html>wm_live_secret</html>', {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.equal(body.error?.message, 'Internal error: data fetch failed');
    assert.equal(body.error?.data, undefined);
    assert.ok(!JSON.stringify(body).includes('wm_live_secret'));
    assert.ok(!JSON.stringify(body).includes('<html>'));
  });

  it('non-validation HTTP errors stay on the generic -32603 fallback', async () => {
    const res = await callTool(
      'get_food_stocks',
      { country_code: 'EG' },
      async () => new Response(JSON.stringify({ message: 'upstream exploded' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.equal(body.error?.data, undefined);
    assert.ok(!JSON.stringify(body).includes('upstream exploded'));
  });

  it('telemetry classifies the validation path as client_4xx', async () => {
    process.env.MCP_TELEMETRY = 'true';
    const captured = [];
    const originalLog = console.log;
    console.log = (line) => captured.push(line);
    try {
      await callTool(
        'get_food_stocks',
        {},
        async () => json400([{ field: 'countryCode', description: 'countryCode is required' }]),
      );
    } finally {
      console.log = originalLog;
    }
    const event = captured.find((line) => line && line.tag === 'mcp.toolcall');
    assert.equal(event?.ok, false);
    assert.equal(event?.error_kind, 'client_4xx');
    assert.equal(event?.tool, 'get_food_stocks');
  });
});

describe('downstreamErrorTags for RpcValidationError', () => {
  it('emits bounded validation tags without the violation text', () => {
    const err = new RpcValidationError('get-food-stocks', [
      { field: 'countryCode', description: 'countryCode is required' },
    ]);
    const tags = downstreamErrorTags(err);
    assert.deepEqual(tags, {
      downstream_operation: 'get-food-stocks',
      downstream_status: '400',
      downstream_error_code: 'rpc_validation',
      downstream_response_marker: 'json_error',
    });
    assert.ok(!JSON.stringify(tags).includes('countryCode is required'));
  });
});
