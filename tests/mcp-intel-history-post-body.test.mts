import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { verifyInternalMcpRequest } from '../server/_shared/mcp-internal-hmac.ts';

const BASE_URL = 'https://worldmonitor.app';
const HMAC_SECRET = 'test-secret-mcp-intel-history-post-body';
const USER_ID = 'user_mcp_intel_history_post_body';
const originalFetch = globalThis.fetch;
const originalHmacSecret = process.env.MCP_INTERNAL_HMAC_SECRET;

const cases = [
  {
    toolName: 'search_intel_history',
    path: '/api/intelligence/v1/search-intel-history',
    textField: 'query',
    sensitiveText: "our supplier's plant in Côte d'Ivoire",
    params: {
      query: "our supplier's plant in Côte d'Ivoire",
      domain: 'energy',
      country: 'CI',
      from: 1_767_225_600_000,
      to: 1_767_312_000_000,
      limit: 7,
    },
  },
  {
    toolName: 'get_similar_events',
    path: '/api/intelligence/v1/get-similar-events',
    textField: 'situation',
    sensitiveText: 'a privately operated terminal has stopped loading strategic cargo',
    params: {
      situation: 'a privately operated terminal has stopped loading strategic cargo',
      domain: 'energy',
      country: 'CI',
      limit: 5,
    },
  },
] as const;

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

function rpcTool(name: string) {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be registered`);
  assert.equal(typeof tool._execute, 'function', `${name} must be an RPC tool`);
  return tool;
}

describe('MCP intel-history request privacy contract (#5741)', () => {
  it('POSTs analyst text in the signed JSON body and never in the request URL', async () => {
    for (const testCase of cases) {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({
          records: [],
          [testCase.textField]: testCase.sensitiveText,
          partial: false,
          upstreamUnavailable: false,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      await rpcTool(testCase.toolName)._execute!(
        testCase.params,
        BASE_URL,
        { kind: 'pro', userId: USER_ID, mcpTokenId: 'mcp_token_5741' },
        {},
      );

      assert.equal(
        requests.length,
        1,
        `${testCase.toolName} must make exactly one outbound request`,
      );
      const [captured] = requests;
      assert.ok(captured, `${testCase.toolName} must make an outbound request`);
      const url = new URL(captured.url);
      assert.equal(url.pathname, testCase.path);
      assert.equal(
        url.searchParams.has(testCase.textField),
        false,
        `${testCase.textField} must not be present in the URL`,
      );
      assert.equal(
        decodeURIComponent(url.href).includes(testCase.sensitiveText),
        false,
        'analyst text must not appear anywhere in the URL',
      );
      assert.equal(captured.init.method, 'POST');
      assert.match(
        new Headers(captured.init.headers).get('Content-Type') ?? '',
        /^application\/json\b/i,
      );

      const body = String(captured.init.body);
      assert.equal(JSON.parse(body)[testCase.textField], testCase.sensitiveText);

      const signedRequest = new Request(captured.url, {
        method: captured.init.method,
        headers: captured.init.headers,
        body,
      });
      const verified = await verifyInternalMcpRequest(signedRequest, HMAC_SECRET);
      assert.equal(
        verified?.userId,
        USER_ID,
        'HMAC must bind the same POST URL and body bytes sent on the wire',
      );

      const tamperedBody = JSON.stringify({
        ...JSON.parse(body),
        [testCase.textField]: `${testCase.sensitiveText} tampered`,
      });
      const tamperedRequest = new Request(captured.url, {
        method: captured.init.method,
        headers: captured.init.headers,
        body: tamperedBody,
      });
      assert.equal(
        await verifyInternalMcpRequest(tamperedRequest, HMAC_SECRET),
        null,
        'changing the analyst text must invalidate the outbound signature',
      );
    }
  });
});
