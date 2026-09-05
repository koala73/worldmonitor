// Contract tests for the GetOilInventories RPC.
//
// These called a local copy of the handler's mapping logic until the copy
// drifted: it emitted `changeWoW` and `changeWoW4` and used `null` for absent
// sections, while the handler emits `changeWow`, drops `changeWoW4`, and uses
// `undefined`. The copy asserted the seeder's payload shape, not the response
// the panel reads. They now drive the real handler over a fake Upstash.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { getOilInventories } from '../server/worldmonitor/economic/v1/get-oil-inventories.ts';
import { escapeHtml } from '../src/utils/sanitize.ts';

const CRUDE_KEY = 'economic:crude-inventories:v1';
const SPR_KEY = 'economic:spr:v1';
const NAT_GAS_KEY = 'economic:nat-gas-storage:v1';

const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

after(() => {
  globalThis.fetch = originalFetch;
  process.env.UPSTASH_REDIS_REST_URL = originalEnv.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.token;
});

/** Seeds the fake Upstash with the given keys and runs the real handler. */
async function callHandler(fixtures) {
  const { fetchImpl } = createRedisFetch(fixtures);
  globalThis.fetch = fetchImpl;
  return getOilInventories({}, {});
}

describe('GetOilInventories — SPR unit contract', () => {
  it('passes SPR barrels through as Mb without dividing by 1,000,000', async () => {
    const response = await callHandler({
      [SPR_KEY]: {
        latestPeriod: '2026-04-04',
        barrels: 395.2,
        changeWoW: -0.3,
        changeWoW4: -1.2,
        weeks: [
          { period: '2026-04-04', barrels: 395.2 },
          { period: '2026-03-28', barrels: 395.5 },
        ],
      },
    });

    assert.equal(response.spr.latestStocksMb, 395.2, 'latestStocksMb must equal raw barrels (already Mb)');
    assert.ok(
      response.spr.latestStocksMb > 100,
      `SPR sanity guard failed: ${response.spr.latestStocksMb} <= 100 (real SPR is ~350-400 Mb)`,
    );
    assert.equal(response.spr.weeks[0].stocksMb, 395.2);
    assert.equal(response.spr.weeks[1].stocksMb, 395.5);
  });

  it('emits changeWow and does not surface the seeder-only changeWoW4', async () => {
    const response = await callHandler({
      [SPR_KEY]: { latestPeriod: '2026-04-04', barrels: 395.2, changeWoW: -0.3, changeWoW4: -1.2, weeks: [] },
    });

    assert.equal(response.spr.changeWow, -0.3, 'the proto field is changeWow, sourced from the seeder changeWoW');
    assert.ok(!('changeWoW' in response.spr), 'the seeder spelling must not leak into the response');
    assert.ok(!('changeWoW4' in response.spr), 'changeWoW4 is seeder-only and the handler drops it');
  });

  it('defaults changeWow to 0 when the seeder omits it', async () => {
    const response = await callHandler({ [SPR_KEY]: { barrels: 395.2, weeks: [] } });
    assert.equal(response.spr.changeWow, 0);
  });
});

describe('GetOilInventories — partial Redis availability', () => {
  it('degrades section by section, leaving absent sections undefined', async () => {
    const response = await callHandler({
      [CRUDE_KEY]: { weeks: [{ period: '2026-04-04', stocksMb: 440, weeklyChangeMb: -2 }] },
      [NAT_GAS_KEY]: { weeks: [{ period: '2026-04-04', storBcf: 1800, weeklyChangeBcf: 12 }] },
    });

    assert.ok(Array.isArray(response.crudeWeeks));
    assert.equal(response.crudeWeeks.length, 1);
    assert.ok(Array.isArray(response.natGasWeeks));
    assert.equal(response.natGasWeeks.length, 1);
    assert.equal(response.spr, undefined, 'absent sections are undefined, not null');
    assert.equal(response.euGas, undefined);
    assert.equal(response.ieaStocks, undefined);
    assert.equal(response.refinery, undefined);
  });

  it('returns empty week arrays when every key is missing', async () => {
    const response = await callHandler({});

    assert.deepEqual(response.crudeWeeks, []);
    assert.deepEqual(response.natGasWeeks, []);
    assert.equal(response.spr, undefined);
  });
});

describe('SVG label escaping', () => {
  it('escapes HTML-unsafe characters in upstream strings', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('US'), 'US', 'safe strings must not be mutated');
    assert.equal(escapeHtml('R&D'), 'R&amp;D');
  });
});
