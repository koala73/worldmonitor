import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import handler from '../api/mcp.ts';
import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';
import { buildUsCpiMonths } from '../server/worldmonitor/economic/v1/us-cpi-monthly.ts';
import { buildUsInterestRates } from '../server/worldmonitor/economic/v1/us-interest-rates.ts';
import { getUsCpiMonthly } from '../server/worldmonitor/economic/v1/get-us-cpi-monthly.ts';
import { getUsInterestRates } from '../server/worldmonitor/economic/v1/get-us-interest-rates.ts';
import { getUsTreasuryParYieldCurve } from '../server/worldmonitor/economic/v1/get-us-treasury-par-yield-curve.ts';
import { getWorldCpiMonthly } from '../server/worldmonitor/economic/v1/get-world-cpi-monthly.ts';
import { getGovernmentYieldCurve } from '../server/worldmonitor/economic/v1/get-government-yield-curve.ts';

const originalFetch = globalThis.fetch;
const originalSecret = process.env.MCP_INTERNAL_HMAC_SECRET;
const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.MCP_INTERNAL_HMAC_SECRET;
  else process.env.MCP_INTERNAL_HMAC_SECRET = originalSecret;
  if (originalKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
});

const tool = () => {
  const found = TOOL_REGISTRY.find(candidate => candidate.name === 'get_macro_history');
  assert.ok(found, 'get_macro_history must be callable');
  return found;
};
const call = args => tool()._execute(args, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'wm_macro_fixture' });
const curves = Array.from({ length: 40 }, (_, i) => ({ date: Date.UTC(2026, 0, i + 1), tenYear: i === 39 ? 0 : 4 }));

describe('macro history MCP workflow', () => {
  it('rejects invalid downstream windows before any cache request for every macro route', async () => {
    globalThis.fetch = async () => { throw new Error('Invalid limit must not reach Redis'); };
    for (const handler of [getUsCpiMonthly, getUsInterestRates, getUsTreasuryParYieldCurve, getWorldCpiMonthly, getGovernmentYieldCurve]) {
      for (const limit of [-1, 0.5, 367, NaN, null, '1']) {
        await assert.rejects(handler({}, { country: 'DE', history: true, limit }), error => error.violations?.[0]?.field === 'limit');
      }
    }
  });
  it('reaches each fixed EconomicService route and preserves source-shaped responses', async () => {
    const fixtures = [
      ['us-cpi', 'get-us-cpi-monthly', { months: buildUsCpiMonths({ components: { headline: [
        { date: '2026-07-01', value: 310 }, { date: '2026-08-01', value: 311 },
      ] } }, true), unavailable: false }],
      ['us-interest-rates', 'get-us-interest-rates', buildUsInterestRates(undefined, {
        fedFundsEffective: [{ date: '2026-09-28', value: 0 }, { date: '2026-09-29', value: 3 }],
      }, true)],
      ['us-treasury-yields', 'get-us-treasury-par-yield-curve', { curves, unavailable: false }],
      ['world-cpi', 'get-world-cpi-monthly', { countries: [{ country: 'DE', source: 'eurostat-hicp',
        frequency: 'monthly', indexBase: '2015=100', periods: [{ period: Date.UTC(2026, 7, 1), reading: { index: 120 } }],
      }], unavailable: false }],
      ['government-yields', 'get-government-yield-curve', { country: 'DE', source: 'de-bundesbank-spot',
        measure: 'spot', curves: [{ date: Date.UTC(2026, 8, 29), tenors: { '10y': 0 } }], unavailable: false }],
    ];
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(tool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    for (const [dataset, route, data] of fixtures) {
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://worldmonitor.app');
        assert.equal(url.pathname, `/api/economic/v1/${route}`);
        assert.equal(url.searchParams.get('history'), 'true');
        assert.equal(url.searchParams.get('limit'), '366');
        assert.equal(url.searchParams.get('country'), ['world-cpi', 'government-yields'].includes(dataset) ? 'DE' : null);
        assert.equal(init.headers['X-WorldMonitor-Key'], 'wm_macro_fixture');
        assert.equal(init.headers['User-Agent'], 'worldmonitor-mcp-edge/1.0');
        return Response.json(data);
      };
      const result = await call({ dataset, ...(['world-cpi', 'government-yields'].includes(dataset) ? { country: 'Germany' } : {}), limit: 365 });
      assert.equal(result.dataset, dataset);
      assert.deepEqual(result.data, data);
      assert.equal(result.truncated, false);
      assert.ok(validate(result), JSON.stringify(validate.errors));
    }
  });

  it('keeps the newest observations in chronological order and reports truncation', async () => {
    globalThis.fetch = async input => {
      const limit = Number(new URL(String(input)).searchParams.get('limit'));
      assert.ok(limit >= 2 && limit <= 366);
      return Response.json({ curves: curves.slice(-limit), unavailable: false });
    };
    const result = await call({ dataset: 'us-treasury-yields', limit: 2 });
    assert.deepEqual(result.data.curves.map(row => row.date), curves.slice(-2).map(row => row.date));
    assert.equal(result.data.curves[1].tenYear, 0);
    assert.equal(result.truncated, true);
    assert.equal((await call({ dataset: 'us-treasury-yields' })).data.curves.length, 30);
  });

  it('caps each rate series and country CPI history without dropping source labels', async () => {
    const points = curves.map(row => ({ date: row.date, percent: 3 }));
    globalThis.fetch = async () => Response.json({ series: [{ id: 'sofr', points }, { id: 'treasury_ten_year', points }], unavailable: false });
    const rates = await call({ dataset: 'us-interest-rates', limit: 2 });
    assert.deepEqual(rates.data.series.map(series => series.points.length), [2, 2]);
    assert.equal(rates.truncated, true);
    globalThis.fetch = async () => Response.json({ countries: [{ country: 'JP', source: 'estat-cpi', frequency: 'monthly', indexBase: '2020=100',
      periods: points.map(row => ({ period: row.date, reading: { index: 100 } })),
    }], unavailable: false });
    const cpi = await call({ dataset: 'world-cpi', country: 'JP', limit: 2 });
    assert.equal(cpi.data.countries[0].periods.length, 2);
    assert.equal(cpi.data.countries[0].source, 'estat-cpi');
    assert.equal(cpi.truncated, true);
  });

  it('requests the latest-only path and preserves unavailable state', async () => {
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).searchParams.get('history'), 'false');
      return Response.json({ months: [], unavailable: true });
    };
    const result = await call({ dataset: 'us-cpi', history: false });
    assert.equal(result.data.unavailable, true);
    assert.deepEqual(result.data.months, []);
    assert.equal(result.truncated, false);
  });

  it('rejects invalid requests before contacting a downstream', async () => {
    globalThis.fetch = async () => assert.fail('invalid requests must not fetch');
    for (const args of [{}, { dataset: 'other' }, { dataset: 'world-cpi' },
      { dataset: 'government-yields', country: 'bogus' }, { dataset: 'us-cpi', country: 'DE' },
      { dataset: 'us-cpi', history: 'true' }, { dataset: 'us-cpi', limit: 0 }, { dataset: 'us-cpi', limit: 366 },
      { dataset: 'us-cpi', limit: 1.5 }]) {
      await assert.rejects(call(args), error => error.name === 'RpcValidationError');
    }
  });

  it('preserves gateway billing denials and retry backoff', async () => {
    globalThis.fetch = async () => Response.json({ code: 'renewal_verification_pending' }, { status: 503, headers: {
      'X-Billing-Verification': 'renewal_verification_pending', 'Retry-After': '10',
    } });
    await assert.rejects(call({ dataset: 'us-cpi' }), error => error.name === 'BillingDenialError' && error.billingCode === 'renewal_verification_pending');
    globalThis.fetch = async () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } });
    await assert.rejects(call({ dataset: 'us-cpi' }), error => error.name === 'ToolBackoffError' && error.retryAfter === '12');
  });

  it('uses account signatures without forwarding dashboard-key plaintext', async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = 'macro-fixture-signing-secret';
    globalThis.fetch = async (_input, init) => {
      assert.equal(init.headers['X-WM-MCP-User-Id'], 'macro-test-user');
      assert.ok(init.headers['X-WM-MCP-Internal']);
      assert.equal(init.headers['X-WorldMonitor-Key'], undefined);
      return Response.json({ months: [], unavailable: true });
    };
    await tool()._execute({ dataset: 'us-cpi' }, 'https://worldmonitor.app', {
      kind: 'user_key', userId: 'macro-test-user', apiKey: 'must-not-be-forwarded',
    });
    assert.equal(toolAccess(tool()), 'subscription');
    assert.equal(toolWeight(tool()), 2);
  });

  it('returns bounded structured content through an authenticated MCP call', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_macro_fixture';
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.worldmonitor.app');
      assert.equal(url.pathname, '/api/economic/v1/get-us-treasury-par-yield-curve');
      return Response.json({ curves, unavailable: false });
    };
    const response = await handler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_macro_fixture' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'get_macro_history', arguments: { dataset: 'us-treasury-yields', limit: 2 },
      } }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(body.result?.isError, undefined, JSON.stringify(body));
    assert.equal(body.result.structuredContent.truncated, true);
    assert.equal(body.result.structuredContent.data.curves.length, 2);
  });

  it('fits twelve rate series at the maximum supported observation limit', async () => {
    const points = Array.from({ length: 365 }, (_, i) => ({ date: Date.UTC(2026, 0, i + 1), percent: 3.125 }));
    globalThis.fetch = async () => Response.json({ series: Array.from({ length: 12 }, (_, i) => ({ id: `rate-${i}`, points })), unavailable: false });
    const result = await call({ dataset: 'us-interest-rates', limit: 365 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= tool()._outputBudgetBytes);
    assert.equal(result.truncated, false);
  });
});
