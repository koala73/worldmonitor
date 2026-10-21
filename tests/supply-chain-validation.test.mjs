/**
 * Regression tests for input-shape validation on supply-chain handlers.
 * Locks in the "400 on bad input / empty-200 on deny / empty-200 on no data"
 * three-way contract after koala73 review HIGH(new) #2 on #3242.
 *
 * Prior state (bug): malformed iso2 / missing chokepointId / unknown
 * chokepointId all collapsed to empty-200, indistinguishable from the
 * legitimate non-pro deny path and from genuine "no data for this country".
 *
 * Fix: input-shape errors throw ValidationError (sebuf → HTTP 400).
 * PRO-gate deny stays as empty-200 (intentional contract shift, called out
 * in the original migration commits).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers = {}, path = '/api/supply-chain/v1/get-country-products') {
  const req = new Request(`https://worldmonitor.app${path}`, { method: 'GET', headers });
  return { request: req, pathParams: {}, headers };
}
function proCtx(path) {
  return makeCtx({ 'X-WorldMonitor-Key': 'pro-test-key' }, path);
}

let getCountryProducts;
let getMultiSectorCostShock;
let ValidationError;

describe('supply-chain handlers: input-shape validation returns 400, not empty-200', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

    const gcpMod = await import('../server/worldmonitor/supply-chain/v1/get-country-products.ts');
    const gmscMod = await import('../server/worldmonitor/supply-chain/v1/get-multi-sector-cost-shock.ts');
    getCountryProducts = gcpMod.getCountryProducts;
    getMultiSectorCostShock = gmscMod.getMultiSectorCostShock;
    const gen = await import('../src/generated/server/worldmonitor/supply_chain/v1/service_server.ts');
    ValidationError = gen.ValidationError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => { if (!(k in originalEnv)) delete process.env[k]; });
    Object.assign(process.env, originalEnv);
  });

  describe('getCountryProducts', () => {
    it('throws ValidationError on blank iso2', async () => {
      await assert.rejects(
        () => getCountryProducts(proCtx('/api/supply-chain/v1/get-country-products'), { iso2: '' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'iso2',
      );
    });

    it('throws ValidationError on 3-letter iso codes (legacy contract required ISO-2)', async () => {
      await assert.rejects(
        () => getCountryProducts(proCtx('/api/supply-chain/v1/get-country-products'), { iso2: 'USA' }),
        (err) => err instanceof ValidationError,
      );
    });

    it('PRO-gate deny on a well-formed iso2 still returns empty-200 (not 400) — intentional contract shift preserved', async () => {
      // No X-WorldMonitor-Key header → isCallerPremium returns false.
      const res = await getCountryProducts(makeCtx({}, '/api/supply-chain/v1/get-country-products'), { iso2: 'SG' });
      assert.deepEqual(res, { iso2: 'SG', products: [], fetchedAt: '' });
    });
  });

  describe('getMultiSectorCostShock', () => {
    const validReq = { iso2: 'SG', chokepointId: 'hormuz_strait', closureDays: 30 };

    it('throws ValidationError on 3-letter iso code (legacy contract required ISO-2)', async () => {
      await assert.rejects(
        () => getMultiSectorCostShock(proCtx('/api/supply-chain/v1/get-multi-sector-cost-shock'), { ...validReq, iso2: 'USA' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'iso2',
      );
    });

    it('throws ValidationError on blank iso2', async () => {
      await assert.rejects(
        () => getMultiSectorCostShock(proCtx('/api/supply-chain/v1/get-multi-sector-cost-shock'), { ...validReq, iso2: '' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'iso2',
      );
    });

    it('throws ValidationError on missing chokepointId', async () => {
      await assert.rejects(
        () => getMultiSectorCostShock(proCtx('/api/supply-chain/v1/get-multi-sector-cost-shock'), { ...validReq, chokepointId: '' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'chokepointId' && /required/i.test(err.violations[0].description),
      );
    });

    it('throws ValidationError on unknown chokepointId', async () => {
      await assert.rejects(
        () => getMultiSectorCostShock(proCtx('/api/supply-chain/v1/get-multi-sector-cost-shock'), { ...validReq, chokepointId: 'not_a_real_chokepoint' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'chokepointId' && /Unknown/.test(err.violations[0].description),
      );
    });

    it('PRO-gate deny on valid inputs still returns empty-200 (not 400) — contract shift preserved', async () => {
      const res = await getMultiSectorCostShock(makeCtx({}, '/api/supply-chain/v1/get-multi-sector-cost-shock'), validReq);
      assert.equal(res.iso2, 'SG');
      assert.equal(res.chokepointId, 'hormuz_strait');
      assert.equal(res.closureDays, 30);
      assert.equal(res.totalAddedCost, 0);
      assert.ok(Array.isArray(res.sectors), 'sectors is an array');
    });
  });
});
