import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const BASE_URL = 'https://worldmonitor.app';
const AUTH = { kind: 'pro', userId: 'user_flight_passengers', mcpTokenId: 'mcp_flight_passengers' } as const;
const originalFetch = globalThis.fetch;
const originalHmacSecret = process.env.MCP_INTERNAL_HMAC_SECRET;

const TOOL_CASES = [
  {
    name: 'search_flights',
    params: { origin: 'JFK', destination: 'LHR', departure_date: '2026-09-01' },
  },
  {
    name: 'search_flight_prices_by_date',
    params: { origin: 'JFK', destination: 'LHR', start_date: '2026-09-01', end_date: '2026-09-08' },
  },
] as const;

beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = 'test-secret-mcp-flight-passengers';
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

describe('MCP Google Flights passenger validation', () => {
  for (const { name, params } of TOOL_CASES) {
    it(`${name} keeps the existing numeric passenger schema`, () => {
      assert.deepEqual(rpcTool(name).inputSchema.properties.passengers, {
        type: 'number',
        description: 'Number of passengers (1-9, default 1)',
      });
    });

    for (const { passengers, expected } of [
      { passengers: 'abc', expected: '1' },
      { passengers: Number.NaN, expected: '1' },
      { passengers: 0, expected: '1' },
      { passengers: 10, expected: '9' },
      { passengers: 1.5, expected: '1.5' },
    ]) {
      it(`${name} normalizes passengers=${String(passengers)} to ${expected}`, async () => {
        let capturedUrl = '';
        globalThis.fetch = (async (input: string | URL | Request) => {
          capturedUrl = String(input);
          return new Response(JSON.stringify({}), { status: 200 });
        }) as typeof fetch;

        await rpcTool(name)._execute!({ ...params, passengers }, BASE_URL, AUTH);
        assert.equal(new URL(capturedUrl).searchParams.get('passengers'), expected);
      });
    }

    it(`${name} defaults an omitted passenger count to 1`, async () => {
      let capturedUrl = '';
      globalThis.fetch = (async (input: string | URL | Request) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      await rpcTool(name)._execute!(params, BASE_URL, AUTH);
      assert.equal(new URL(capturedUrl).searchParams.get('passengers'), '1');
    });
  }
});
