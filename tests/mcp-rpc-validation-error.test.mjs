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


const VALIDATION_BODY_BUDGET_BYTES = 16384;

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

function json400Response(body) {
  return new Response(body, {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('validation body budget (#6559 follow-up)', () => {
  it('keeps a violation list larger than 4 KB inside the structured -32602 contract', async () => {
    // A dozen localized field descriptions overflow the previous 4 KB
    // classification budget; truncation mid-JSON collapsed the whole list
    // into the generic -32603 fallback even though every violation was valid.
    const violations = Array.from({ length: 14 }, (_, i) => ({
      field: `field_${i}`,
      description: 'x'.repeat(400),
    }));
    const body = JSON.stringify({ violations });
    assert.ok(utf8Bytes(body) > 4096 && utf8Bytes(body) <= VALIDATION_BODY_BUDGET_BYTES);

    const res = await callTool('get_food_stocks', {}, async () => json400Response(body));
    assert.equal(res.status, 200);
    const parsed = await res.json();
    assert.equal(parsed.error.code, -32602);
    assert.equal(parsed.error.message, 'Invalid params');
    assert.ok(Array.isArray(parsed.error.data.violations));
    assert.equal(parsed.error.data.violations.length, 8,
      'the existing MAX_VALIDATION_VIOLATIONS cap still applies to the larger body');
    assert.equal(parsed.error.data.violations[0].field, 'field_0');
    assert.equal(parsed.error.data.violations[0].description, 'x'.repeat(200));
    assert.equal(parsed.result, undefined);
  });

  it('keeps a UTF-8 localized list that is under 4 KB of characters but over 4 KB of bytes', async () => {
    const violations = Array.from({ length: 10 }, (_, i) => ({
      field: `field_${i}`,
      description: '字'.repeat(200),
    }));
    const body = JSON.stringify({ violations });
    assert.ok(body.length <= 4096, 'character length still fits the old 4 KB gate');
    assert.ok(utf8Bytes(body) > 4096 && utf8Bytes(body) <= VALIDATION_BODY_BUDGET_BYTES);

    const res = await callTool('get_food_stocks', {}, async () => json400Response(body));
    const parsed = await res.json();
    assert.equal(parsed.error.code, -32602);
    assert.equal(parsed.error.data.violations.length, 8);
    assert.equal(parsed.error.data.violations[0].field, 'field_0');
    assert.equal(parsed.error.data.violations[0].description, '字'.repeat(200));
  });

  it('drops unsafe descriptions from a well-formed body larger than 4 KB', async () => {
    const violations = [
      { field: 'countryCode', description: 'Authorization: Bearer leaked-token' },
      { field: 'ok_field', description: 'countryCode is required' },
    ];
    const body = JSON.stringify({ extra: 'y'.repeat(5000), violations });
    assert.ok(utf8Bytes(body) > 4096 && utf8Bytes(body) <= VALIDATION_BODY_BUDGET_BYTES);

    const res = await callTool('get_food_stocks', {}, async () => json400Response(body));
    const parsed = await res.json();
    assert.equal(parsed.error.code, -32602);
    assert.deepEqual(parsed.error.data.violations, [
      { field: 'ok_field', description: 'countryCode is required' },
    ]);
    assert.ok(!JSON.stringify(parsed).includes('leaked-token'));
  });

  it('falls back to -32603 and does not leak a tail past the 16 KB budget', async () => {
    const secret = 'wm_live_over_budget_secret';
    const prefix = '{"violations":[';
    const tail = `{"field":"tail_field","description":"${secret}"}]}`;
    const pad = VALIDATION_BODY_BUDGET_BYTES - prefix.length + 1;
    const body = `${prefix}${' '.repeat(pad)}${tail}`;
    assert.ok(utf8Bytes(body) > VALIDATION_BODY_BUDGET_BYTES);

    const res = await callTool('get_food_stocks', {}, async () => json400Response(body));
    assert.equal(res.status, 200);
    const parsed = await res.json();
    const serialized = JSON.stringify(parsed);
    assert.equal(parsed.error.code, -32603);
    assert.equal(parsed.error.message, 'Internal error: data fetch failed');
    assert.equal(parsed.error.data, undefined);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('tail_field'));
  });
});

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

// WORLDMONITOR-10R / 10Q — the observed-downstream sibling of
// assertToolFetchOk must preserve proto violations too. Both helpers front
// the same sebuf routes, but only assertToolFetchOk extracted
// `{violations}`; assertMcpToolFetchOk classified the same body through
// `parsed.code ?? parsed.error`, found neither key, and collapsed every
// proto 400 to `upstream_http_error` -> -32603. The violation list is in the
// body (response_marker is literally `json_error`) and was thrown away, so a
// caller's own bad argument was reported as an internal server error.
//
// The 400 here is stubbed, so this suite asserts the ENVELOPE for any proto
// rejection and stays independent of which argument caused it — the arguments
// below are deliberately valid.
describe('MCP RPC ValidationError preservation on the observed-downstream path', () => {
  const OBSERVED_TOOLS = [
    {
      tool: 'search_intel_history',
      args: { query: 'artillery strikes near Kharkiv', country: 'UA' },
      route: /\/api\/intelligence\/v1\/search-intel-history/,
      violations: [{ field: 'country', description: 'value does not match regex pattern `^([A-Z]{2})?$`' }],
    },
    {
      tool: 'get_intel_timeline',
      args: { domain: 'conflict', country: 'UA' },
      route: /\/api\/intelligence\/v1\/get-intel-timeline/,
      violations: [{ field: 'country', description: 'value does not match regex pattern `^([A-Z]{2})?$`' }],
    },
    {
      tool: 'get_similar_events',
      args: { situation: 'a naval blockade closes a grain corridor', country: 'UA' },
      route: /\/api\/intelligence\/v1\/get-similar-events/,
      violations: [{ field: 'country', description: 'value does not match regex pattern `^([A-Z]{2})?$`' }],
    },
  ];

  it('registry still exposes every tool this contract covers', () => {
    for (const { tool } of OBSERVED_TOOLS) {
      assert.ok(
        TOOL_REGISTRY.some((entry) => entry.name === tool),
        `${tool} missing from the registry`,
      );
    }
  });

  for (const { tool, args, route, violations } of OBSERVED_TOOLS) {
    it(`${tool} 400 returns JSON-RPC -32602 with data.violations`, async () => {
      const res = await callTool(tool, args, async (input) => {
        const url = String(typeof input === 'string' ? input : input.url);
        assert.match(url, route);
        return json400(violations);
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.error?.code, -32602, `${tool} must report invalid params, not an internal error`);
      assert.equal(body.error?.message, 'Invalid params');
      assert.deepEqual(body.error?.data?.violations, violations);
      assert.equal(body.result, undefined);
    });
  }

  it('untrusted 400 bodies on the observed path stay on the generic -32603 fallback', async () => {
    const res = await callTool(
      'search_intel_history',
      { query: 'artillery strikes near Kharkiv' },
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

  // A gateway 400 that carries a recognised `code` is NOT a proto validation
  // rejection; it must keep the ToolFetchError classification rather than be
  // re-read as an empty violation list and downgraded to a generic failure.
  it('a coded gateway 400 keeps its safe code and stays off the -32602 path', async () => {
    const res = await callTool(
      'search_intel_history',
      { query: 'artillery strikes near Kharkiv' },
      async () => new Response(JSON.stringify({ code: 'rate_limited' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.equal(body.error?.data, undefined);
  });

  // An explicit-null `code`/`error` alongside violations must not read as a
  // coded gateway rejection: null classifies as the default code anyway, so
  // treating it as coded would silently discard the field detail.
  it('a null gateway code still yields -32602 with data.violations', async () => {
    const violations = [{ field: 'country', description: 'country is invalid' }];
    const res = await callTool(
      'search_intel_history',
      { query: 'artillery strikes near Kharkiv' },
      async () => new Response(JSON.stringify({ code: null, error: null, violations }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
    assert.deepEqual(body.error?.data?.violations, violations);
  });

  it('non-validation HTTP errors on the observed path stay on -32603', async () => {
    const res = await callTool(
      'get_intel_timeline',
      { domain: 'conflict' },
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

  it('telemetry still classifies the observed validation path as client_4xx', async () => {
    process.env.MCP_TELEMETRY = 'true';
    const captured = [];
    const originalLog = console.log;
    console.log = (line) => captured.push(line);
    try {
      await callTool(
        'search_intel_history',
        { query: 'artillery strikes near Kharkiv', country: 'UA' },
        async () => json400([{ field: 'country', description: 'country is invalid' }]),
      );
    } finally {
      console.log = originalLog;
    }
    const toolEvent = captured.find((line) => line && line.tag === 'mcp.toolcall');
    assert.equal(toolEvent?.ok, false);
    assert.equal(toolEvent?.error_kind, 'client_4xx');
    assert.equal(toolEvent?.tool, 'search_intel_history');

    // The downstream observation is the whole point of this helper: it must
    // survive the new branch, and it must name the validation rejection
    // instead of the opaque upstream_http_error it used to report.
    const downstreamEvent = captured.find((line) => line && line.tag === 'mcp.downstream');
    assert.equal(downstreamEvent?.ok, false);
    assert.equal(downstreamEvent?.status, 400);
    assert.equal(downstreamEvent?.error_code, 'rpc_validation');
    assert.equal(downstreamEvent?.response_marker, 'json_error');
    assert.equal(downstreamEvent?.downstream_operation, 'search-intel-history');
    assert.ok(!JSON.stringify(downstreamEvent).includes('country is invalid'));
  });
});
