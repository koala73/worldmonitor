/**
 * Country codes sent by the MCP intel-history tools must survive the
 * generated validation layer regardless of input case.
 *
 * History: the 2026-08-01 security fix (GHSA-cmj5-cfhr-w964) enabled
 * generated request validation, whose intel-history rules demand
 * `^([A-Z]{2})?$`. #7105 fixed this defect for the dashboard deep-dive panel
 * (`src/app/country-intel.ts`) and its commit message notes the siblings are
 * tracked separately — the MCP surface is one of them. Eight `country_code`
 * tools in `api/mcp/registry/rpc-tools.ts` already normalize at their call
 * sites; the three intel-history tools take `country` instead and forwarded
 * it verbatim, so an LLM sending the documented-but-unenforced lowercase code
 * got a 400 round-trip (WORLDMONITOR-10R, -10Q, 2026-08-26).
 *
 * `get_procurement_opportunities` also forwards a raw `country`, but
 * `listGlobalTenders` carries no case rule — verified against the real
 * validator below so this suite states the boundary rather than assuming it.
 *
 * Two halves, both load-bearing:
 *  1. Runtime: the REAL generated validator rejects lowercase and accepts
 *     uppercase for every intel-history RPC — so this test cannot outlive the
 *     constraint it guards.
 *  2. Behavioural: each tool's outbound request is captured and asserted to
 *     carry the uppercased code. An omitted country must stay omitted: the
 *     pattern makes the field optional, and forcing an empty string would
 *     widen "search every country" into an explicit filter.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';

const BASE_URL = 'https://worldmonitor.app';
const HMAC_SECRET = 'test-secret-mcp-intel-history-country-case';
const AUTH = { kind: 'pro', userId: 'user_intel_history_country_case', mcpTokenId: 'mcp_token_10r' } as const;
const originalFetch = globalThis.fetch;
const originalHmacSecret = process.env.MCP_INTERNAL_HMAC_SECRET;

// buildAuthHeaders signs every outbound intel-history request, so without a
// secret each tool throws before the fetch and the country assertions would go
// red for a reason that has nothing to do with case normalization.
beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHmacSecret === undefined) {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
  } else {
    process.env.MCP_INTERNAL_HMAC_SECRET = originalHmacSecret;
  }
});

/** The generated RPC methods the three intel-history tools call. */
const INTEL_HISTORY_RPCS = ['searchIntelHistory', 'getIntelTimeline', 'getSimilarEvents'];

/** A request body that is otherwise valid for every method above. */
function baseRequest(country: string) {
  return { query: 'artillery strikes near Kharkiv', situation: 'a'.repeat(20), domain: 'conflict', country };
}

describe('generated validation vs. MCP intel-history country codes', () => {
  for (const method of INTEL_HISTORY_RPCS) {
    it(`${method}: rejects lowercase, accepts uppercase`, () => {
      const lower = validateGeneratedRequest(method, baseRequest('ua'));
      assert.ok(
        lower && lower.some((v) => v.field === 'country'),
        `${method} accepted a lowercase code — if the validator relaxed, `
        + 'this suite is guarding a constraint that no longer exists',
      );
      assert.equal(
        validateGeneratedRequest(method, baseRequest('UA')),
        undefined,
        `${method} must accept an uppercase code`,
      );
    });
  }

  // Boundary control: the sibling raw `country` forward in
  // get_procurement_opportunities is deliberately left alone. If this route
  // ever gains the case rule, this goes red and that call site needs the fix.
  it('listGlobalTenders carries no case rule, so its raw forward is safe', () => {
    assert.equal(validateGeneratedRequest('listGlobalTenders', { country: 'ua' }), undefined);
  });
});

function rpcTool(name: string) {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be registered`);
  assert.equal(typeof tool._execute, 'function', `${name} must be an RPC tool`);
  return tool;
}

/** Run one tool against a stub and return the country it actually sent. */
async function sentCountry(toolName: string, params: Record<string, unknown>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    return new Response(
      JSON.stringify({ records: [], partial: false, upstreamUnavailable: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  await rpcTool(toolName)._execute!(params, BASE_URL, AUTH, {});
  assert.equal(requests.length, 1, `${toolName} must make exactly one outbound request`);
  const [captured] = requests;
  // Two transports: search/similar POST a JSON body, timeline uses the query
  // string. Read whichever this tool used so the assertion is transport-blind.
  if (captured!.init.method === 'POST') {
    return (JSON.parse(String(captured!.init.body)) as { country?: unknown }).country;
  }
  const found = new URL(captured!.url).searchParams.get('country');
  return found === null ? undefined : found;
}

const TOOL_CASES = [
  { toolName: 'search_intel_history', params: { query: 'artillery strikes near Kharkiv' } },
  { toolName: 'get_intel_timeline', params: { domain: 'conflict' } },
  { toolName: 'get_similar_events', params: { situation: 'a naval blockade closes a grain corridor' } },
] as const;

describe('MCP intel-history tools normalize country before the RPC', () => {
  for (const { toolName, params } of TOOL_CASES) {
    it(`${toolName} uppercases a lowercase country`, async () => {
      assert.equal(await sentCountry(toolName, { ...params, country: 'ua' }), 'UA');
    });

    it(`${toolName} passes an already-uppercase country through unchanged`, async () => {
      assert.equal(await sentCountry(toolName, { ...params, country: 'UA' }), 'UA');
    });

    it(`${toolName} trims surrounding whitespace`, async () => {
      assert.equal(await sentCountry(toolName, { ...params, country: '  ua  ' }), 'UA');
    });

    it(`${toolName} leaves an omitted country omitted`, async () => {
      assert.equal(await sentCountry(toolName, { ...params }), undefined);
    });

    it(`${toolName} treats a blank country as omitted, not as an empty filter`, async () => {
      assert.equal(await sentCountry(toolName, { ...params, country: '   ' }), undefined);
    });
  }

  // get_intel_timeline's scope guard rejects an unscoped read before the
  // fetch. A country that is blank after trimming is not a scope, so the
  // guard must still fire rather than sending an empty filter downstream.
  // WORLDMONITOR-10Y: this must be RpcValidationError (-32602), not a plain
  // Error that dispatch flattens to -32603 + Sentry error.
  it('get_intel_timeline still rejects a blank country as unscoped', async () => {
    await assert.rejects(
      () => sentCountry('get_intel_timeline', { country: '   ' }),
      (err: unknown) => {
        assert.equal(err instanceof Error && err.name, 'RpcValidationError');
        assert.match(err instanceof Error ? err.message : '', /get-intel-timeline HTTP 400/);
        return true;
      },
    );
  });
});
