import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function call(arguments_) {
  return dispatchToolsCall(
    new Request('https://worldmonitor.app/mcp'),
    { kind: 'env_key', apiKey: 'test-key' },
    {},
    { id: 42, params: { name: 'get_food_stocks', arguments: arguments_ } },
    {},
  );
}

describe('MCP food stocks country boundary', () => {
  for (const value of [undefined, null, '', '  ', 42, false, [], {}, 'Egypt', 'E', 'EG,WORLD', 'E1']) {
    it(`rejects ${JSON.stringify(value)} before fetching`, async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({ records: [] });
      };
      const response = await call(value === undefined ? {} : { country_code: value });
      const body = await response.json();
      assert.equal(body.error?.code, -32602);
      assert.equal(body.error?.data?.violations[0]?.field, 'country_code');
      assert.equal(calls, 0);
    });
  }
  for (const [input, expected] of [[' eg ', 'EG'], ['world', 'WORLD'], ['CX', 'CX'], ['wld', 'WLD'], ['_world', '_WORLD']]) {
    it(`scopes ${input} to ${expected} and preserves commodity`, async () => {
      const requests = [];
      const payload = { records: [{ countryCode: expected }], unavailable: false };
      globalThis.fetch = async (input, init) => {
        requests.push({ url: new URL(input), init });
        return Response.json(payload);
      };
      const response = await call({ country_code: input, commodity: 'palmOil' });
      const body = await response.json();
      assert.equal(body.error, undefined);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url.searchParams.get('countryCode'), expected);
      assert.equal(requests[0].url.searchParams.get('commodity'), 'palmOil');
      assert.equal(requests[0].init.headers['X-WorldMonitor-Key'], 'test-key');
      assert.deepEqual(JSON.parse(body.result.content[0].text), payload);
    });
  }
});
