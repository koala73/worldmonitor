import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getCountryDefenseIndustrialBase } from '../src/services/defense-industrial.ts';

describe('defense-industrial client service', () => {
  it('uses only the bounded per-country RPC and normalizes the country code', async () => {
    const calls: unknown[] = [];
    const expected = { countryCode: 'UA', available: false };
    const client = {
      getDefenseIndustrialBase: async (request: unknown) => {
        calls.push(request);
        return expected;
      },
    };

    assert.equal(await getCountryDefenseIndustrialBase(' ua ', client as never), expected);
    assert.deepEqual(calls, [{ countryCode: 'UA' }]);
  });
});
