import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import handler from '../api/mcp.ts';
import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';
import { computeMultiSectorShocks } from '../server/worldmonitor/supply-chain/v1/_multi-sector-shock.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const tool = () => {
  const found = TOOL_REGISTRY.find(candidate => candidate.name === 'get_supply_chain_cost_shock');
  assert.ok(found, 'get_supply_chain_cost_shock must be callable'); return found;
};
const call = args => tool()._execute(args, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'wm_shock_fixture' });

describe('supply-chain cost shock MCP workflow', () => {
  it('calls the energy route with normalized country and canonical chokepoint', async () => {
    const data = { iso2: 'JP', chokepointId: 'hormuz_strait', hs2: '27', supplyDeficitPct: 0,
      coverageDays: 32, warRiskPremiumBps: 100, warRiskTier: 'WAR_RISK_TIER_HIGH', hasEnergyModel: true,
      unavailableReason: '', fetchedAt: '2026-09-30T12:00:00Z' };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/supply-chain/v1/get-country-cost-shock');
      assert.deepEqual(Object.fromEntries(url.searchParams), { iso2: 'JP', chokepoint_id: 'hormuz_strait', hs2: '27' });
      assert.equal(init.headers['X-WorldMonitor-Key'], 'wm_shock_fixture'); return Response.json(data);
    };
    assert.deepEqual(await call({ mode: 'energy', country: 'Japan', chokepoint_id: 'hormuz_strait' }), { mode: 'energy', data });
  });

  it('preserves the actual multi-sector computation and requested window', async () => {
    const sectors = computeMultiSectorShocks({ '27': 1000000, '85': 2000000 }, 'suez', 'WAR_RISK_TIER_NORMAL', 90);
    const data = { iso2: 'DE', chokepointId: 'suez', closureDays: 90, sectors,
      totalAddedCost: sectors.reduce((sum, sector) => sum + sector.totalCostShock, 0),
      warRiskTier: 'WAR_RISK_TIER_NORMAL', fetchedAt: '2026-09-30T12:00:00Z', unavailableReason: '' };
    globalThis.fetch = async input => {
      const url = new URL(String(input)); assert.equal(url.pathname, '/api/supply-chain/v1/get-multi-sector-cost-shock');
      assert.deepEqual(Object.fromEntries(url.searchParams), { iso2: 'DE', chokepoint_id: 'suez', closure_days: '90' });
      return Response.json(data);
    };
    const result = await call({ mode: 'multi-sector', country: 'DEU', chokepoint_id: 'suez', closure_days: 90 });
    assert.deepEqual(result, { mode: 'multi-sector', data });
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(tool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    assert.ok(validate(result), JSON.stringify(validate.errors));
  });

  it('keeps unavailable model/import information and defaults without inventing measurements', async () => {
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).searchParams.get('closure_days'), '30');
      return Response.json({ sectors: [], totalAddedCost: 0, unavailableReason: 'No seeded import data available for this country' });
    };
    assert.match((await call({ mode: 'multi-sector', country: 'JP', chokepoint_id: 'suez' })).data.unavailableReason, /No seeded import/);
    globalThis.fetch = async () => Response.json({ hasEnergyModel: false, supplyDeficitPct: 0, unavailableReason: 'Only HS 27 has an energy model' });
    const result = await call({ mode: 'energy', country: 'JP', chokepoint_id: 'suez', hs2: '85' });
    assert.equal(result.data.hasEnergyModel, false); assert.ok(result.data.unavailableReason);
  });

  it('rejects invalid countries, chokepoints and mode-specific options before fetching', async () => {
    globalThis.fetch = async () => assert.fail('invalid inputs must not fetch');
    const valid = { mode: 'energy', country: 'JP', chokepoint_id: 'suez' };
    for (const args of [{ ...valid, mode: 'other' }, { ...valid, country: 'bogus' }, { ...valid, chokepoint_id: 'bogus' },
      { ...valid, hs2: 'abc' }, { ...valid, closure_days: 30 }, { ...valid, mode: 'multi-sector', hs2: '27' },
      { ...valid, mode: 'multi-sector', closure_days: 0 }, { ...valid, mode: 'multi-sector', closure_days: 366 },
      { ...valid, mode: 'multi-sector', closure_days: 3.5 }]) {
      await assert.rejects(call(args), error => error.name === 'RpcValidationError');
    }
  });

  it('retains subscription access and billing/backoff contracts', async () => {
    assert.equal(toolAccess(tool()), 'subscription'); assert.equal(toolWeight(tool()), 2);
    const args = { mode: 'energy', country: 'JP', chokepoint_id: 'suez' };
    globalThis.fetch = async () => new Response(null, { status: 403, headers: { 'X-Billing-Verification': 'subscription_lapsed' } });
    await assert.rejects(call(args), error => error.name === 'BillingDenialError');
    globalThis.fetch = async () => new Response(null, { status: 429, headers: { 'Retry-After': '15' } });
    await assert.rejects(call(args), error => error.name === 'ToolBackoffError' && error.retryAfter === '15');
  });
  it('dispatches through the MCP handler and denies uncredentialed calls', async () => {
    const previousKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_shock_fixture';
    try {
      const data = { iso2: 'JP', chokepointId: 'suez', hasEnergyModel: true, unavailableReason: '', supplyDeficitPct: 0 };
      globalThis.fetch = async input => {
        assert.equal(new URL(String(input)).pathname, '/api/supply-chain/v1/get-country-cost-shock');
        return Response.json(data);
      };
      const request = key => new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(key ? { 'X-WorldMonitor-Key': key } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_supply_chain_cost_shock', arguments: { mode: 'energy', country: 'JP', chokepoint_id: 'suez' } } }) });
      const response = await handler(request('wm_shock_fixture'));
      const result = (await response.json()).result;
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, { mode: 'energy', data });
      assert.equal((await handler(request())).status, 401);
    } finally {
      if (previousKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = previousKeys;
    }
  });

});


describe('energy supply sensitivity MCP workflow', () => {
  const shockTool = () => {
    const found = TOOL_REGISTRY.find(candidate => candidate.name === 'compute_energy_shock');
    assert.ok(found); return found;
  };
  const shock = args => shockTool()._execute(args, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'wm_shock_fixture' });
  it('sends explicit oil defaults and retains incomplete coverage', async () => {
    const data = { countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100,
      dataAvailable: false, coverageLevel: 'none', degraded: true, chokepointConfidence: 'none',
      limitations: ['No seeded trade inputs'], products: [], effectiveCoverDays: 0 };
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/intelligence/v1/compute-energy-shock');
      assert.deepEqual(Object.fromEntries(url.searchParams), { country_code: 'JP', chokepoint_id: 'hormuz_strait', disruption_pct: '100', fuel_mode: 'oil' });
      return Response.json(data);
    };
    assert.deepEqual(await shock({ country: 'Japan', chokepoint_id: 'hormuz_strait' }), data);
    assert.equal(toolAccess(shockTool()), 'subscription');
  });
  it('preserves gas model basis and observed storage rather than inventing a storage buffer', async () => {
    const data = { dataAvailable: true, products: [], gasSensitivity: {
      dataAvailable: true, modelBasis: 'assumed_route_sensitivity', dataMonth: '2026-07',
      lngImportsTj: 100, lngDisruptionTj: 50, totalDemandTj: 1000, deficitPct: 5,
      storage: { fillPct: 80, gasTwh: 900, date: '2026-09-29', scope: 'EU', trend: 'increasing' },
    } };
    globalThis.fetch = async input => {
      const query = new URL(String(input)).searchParams;
      assert.equal(query.get('fuel_mode'), 'both'); assert.equal(query.get('disruption_pct'), '50');
      return Response.json(data);
    };
    const result = await shock({ country: 'DE', chokepoint_id: 'suez', fuel_mode: 'both', disruption_pct: 50 });
    assert.deepEqual(result, data);
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(shockTool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    assert.ok(validate(result), JSON.stringify(validate.errors));
    assert.equal(result.gasSensitivity.storage.bufferDays, undefined);
  });
  it('rejects unsupported model selections before fetching', async () => {
    globalThis.fetch = async () => assert.fail('invalid inputs must not fetch');
    const valid = { country: 'JP', chokepoint_id: 'suez' };
    for (const args of [{ ...valid, country: 'bogus' }, { ...valid, chokepoint_id: 'panama' },
      { ...valid, fuel_mode: 'coal' }, { ...valid, disruption_pct: 9 }, { ...valid, disruption_pct: 101 },
      { ...valid, disruption_pct: 20.5 }]) await assert.rejects(shock(args), error => error.name === 'RpcValidationError');
  });
});
