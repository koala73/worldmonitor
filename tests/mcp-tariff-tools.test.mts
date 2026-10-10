// Behavior tests for the live tariff MCP tools. Drives the REAL _execute
// through a mocked gateway fetch, so the query each tool sends, its argument
// resolution and its fault mapping are pinned here rather than by source grep.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { tradeCountryCode } from '../api/mcp/registry/tariff-tools.ts';
import { PRODUCT_GROUPS } from '../server/worldmonitor/trade/v1/_tradestats-tariff.ts';

const originalFetch = globalThis.fetch;
const BASE = 'https://api.worldmonitor.app';

function tool(name: string) {
  const t = TOOL_REGISTRY.find((entry) => entry.name === name);
  assert.ok(t, `${name} must be registered`);
  if (t._execute === undefined) throw new Error(`${name} must be an _execute tool`);
  return t as typeof t & { _execute: NonNullable<typeof t._execute> };
}

const averages = tool('get_tariff_averages');
const bilateral = tool('get_bilateral_tariff');
const usDuty = tool('get_us_import_duty');
const CTX = { kind: 'env_key', apiKey: 'test' } as Parameters<typeof averages._execute>[2];

let requested: URL[] = [];
let reply: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  requested = [];
  reply = () => json({});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(new URL(String(input)));
    return reply();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function rejectsWith(promise: Promise<unknown>, field: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RpcValidationError, `expected RpcValidationError, got ${String(error)}`);
    assert.equal(error.violations[0]?.field, field);
    return true;
  });
  assert.equal(requested.length, 0, 'invalid input must not reach the gateway');
}

describe('live tariff MCP tools: contract', () => {
  it('each tool declares exactly its route and is a Pro, weight-2 live fetch', () => {
    assert.deepEqual(averages._apiPaths, ['GET /api/trade/v1/get-tariff-trends']);
    assert.deepEqual(bilateral._apiPaths, ['GET /api/trade/v1/get-bilateral-tariff']);
    assert.deepEqual(usDuty._apiPaths, ['GET /api/trade/v1/get-us-import-duty']);
    for (const t of [averages, bilateral, usDuty]) {
      assert.equal(toolAccess(t), 'subscription', t.name);
      assert.equal(toolWeight(t), 2, t.name);
    }
    assert.ok(usDuty._coverageKeys?.includes('trade:us-hts:catalog:v1'));
  });

  it('advertises every WITS product group the handler accepts', () => {
    const schema = averages.inputSchema.properties.product_group as { enum: string[] };
    assert.deepEqual(schema.enum, ['all', ...PRODUCT_GROUPS]);
  });
});

describe('tradeCountryCode', () => {
  it('passes 3-digit codes through, so WTO codes and the EU reach the handler unchanged', () => {
    assert.equal(tradeCountryCode('699', 'op', 'reporter'), '699');
    assert.equal(tradeCountryCode(' 918 ', 'op', 'reporter'), '918');
  });

  it('maps ISO alpha-2, alpha-3 and names to UN M49', () => {
    assert.equal(tradeCountryCode('US', 'op', 'partner'), '840');
    assert.equal(tradeCountryCode('CHN', 'op', 'partner'), '156');
    assert.equal(tradeCountryCode('India', 'op', 'partner'), '356');
    assert.equal(tradeCountryCode('Germany', 'op', 'partner'), '276');
  });

  it('accepts World and the EU only where the route does', () => {
    assert.equal(tradeCountryCode('World', 'op', 'partner', { allowWorld: true }), '000');
    assert.equal(tradeCountryCode('EU', 'op', 'reporter', { allowEu: true }), '918');
    assert.throws(() => tradeCountryCode('World', 'op', 'partner'), RpcValidationError);
  });

  it('names the field and the value when a country cannot be resolved', () => {
    assert.throws(() => tradeCountryCode('Atlantis', 'op', 'partner'), (error: unknown) => {
      assert.ok(error instanceof RpcValidationError);
      assert.equal(error.violations[0]?.field, 'partner');
      assert.match(error.violations[0]?.description ?? '', /Atlantis/);
      return true;
    });
    assert.throws(() => tradeCountryCode({ toString: 'x' }, 'op', 'partner'), RpcValidationError);
  });
});

describe('get_tariff_averages', () => {
  it('sends partner, product group and years to get-tariff-trends', async () => {
    const wire = {
      datapoints: [{ reportingCountry: '840', partnerCountry: '156', productSector: 'Textiles', year: 2023, tariffRate: 8.76, boundRate: 0, indicatorCode: 'AHS-SMPL-AVRG', weightedRate: 9.87 }],
      fetchedAt: '2026-10-10T00:00:00.000Z',
      upstreamUnavailable: false,
      unavailableReason: 'TARIFF_TREND_UNAVAILABLE_REASON_UNSPECIFIED',
      coverageStartYear: 2023,
      coverageEndYear: 2023,
    };
    reply = () => json(wire);
    const result = await averages._execute({ reporter: 'US', partner: 'China', product_group: 'Textiles', years: 5 }, BASE, CTX, {});
    assert.equal(requested.length, 1);
    const url = requested[0]!;
    assert.equal(url.pathname, '/api/trade/v1/get-tariff-trends');
    assert.equal(url.searchParams.get('reporting_country'), '840');
    assert.equal(url.searchParams.get('partner_country'), '156');
    assert.equal(url.searchParams.get('product_sector'), 'Textiles');
    assert.equal(url.searchParams.get('years'), '5');
    assert.deepEqual(result, wire, 'the route answer is returned unchanged');
  });

  it('defaults to the US MFN series: no partner, no group, no years', async () => {
    await averages._execute({}, BASE, CTX, {});
    const url = requested[0]!;
    assert.equal(url.searchParams.get('reporting_country'), '840');
    for (const name of ['partner_country', 'product_sector', 'years']) {
      assert.equal(url.searchParams.has(name), false, `${name} must be omitted`);
    }
  });

  it('accepts the EU as reporter and World as partner', async () => {
    await averages._execute({ reporter: 'European Union', partner: 'World' }, BASE, CTX, {});
    assert.equal(requested[0]!.searchParams.get('reporting_country'), '918');
    assert.equal(requested[0]!.searchParams.get('partner_country'), '000');
  });

  it('rejects an unresolvable partner and an out-of-range years without a fetch', async () => {
    await rejectsWith(averages._execute({ partner: 'Atlantis' }, BASE, CTX, {}), 'partner');
    await rejectsWith(averages._execute({ years: 31 }, BASE, CTX, {}), 'years');
    await rejectsWith(averages._execute({ years: 2.5 }, BASE, CTX, {}), 'years');
  });

  it('relays a coverage answer unchanged', async () => {
    const wire = { datapoints: [], fetchedAt: '', upstreamUnavailable: false, unavailableReason: 'TARIFF_TREND_UNAVAILABLE_REASON_NOT_COVERED' };
    reply = () => json(wire);
    assert.deepEqual(await averages._execute({ partner: '158' }, BASE, CTX, {}), wire);
  });

  it('turns a gateway 400 with violations into Invalid params', async () => {
    reply = () => json({ violations: [{ field: 'product_sector', description: 'value does not match regex pattern' }] }, 400);
    await assert.rejects(averages._execute({ product_group: 'all' }, BASE, CTX, {}), RpcValidationError);
  });

  it('turns a gateway 5xx into a tool error, not a served answer', async () => {
    reply = () => json({ error: 'boom' }, 502);
    await assert.rejects(averages._execute({}, BASE, CTX, {}), (error: unknown) => !(error instanceof RpcValidationError));
  });
});

describe('get_bilateral_tariff', () => {
  it('sends reporter, partner, the 6 HS digits and the year', async () => {
    await bilateral._execute({ reporter: 'India', partner: 'US', hs_code: '8703.80', year: 2022 }, BASE, CTX, {});
    const url = requested[0]!;
    assert.equal(url.pathname, '/api/trade/v1/get-bilateral-tariff');
    assert.equal(url.searchParams.get('reporting_country'), '356');
    assert.equal(url.searchParams.get('partner_country'), '840');
    assert.equal(url.searchParams.get('hs_code'), '870380');
    assert.equal(url.searchParams.get('year'), '2022');
  });

  it('omits year 0, which means the latest year with data', async () => {
    await bilateral._execute({ reporter: '840', partner: '156', hs_code: '870380', year: 0 }, BASE, CTX, {});
    assert.equal(requested[0]!.searchParams.has('year'), false);
  });

  it('rejects an HS code that is not 6 digits, and missing countries, without a fetch', async () => {
    await rejectsWith(bilateral._execute({ reporter: '840', partner: '156', hs_code: '87038000' }, BASE, CTX, {}), 'hs_code');
    await rejectsWith(bilateral._execute({ reporter: '840', partner: '156', hs_code: 'cars' }, BASE, CTX, {}), 'hs_code');
    await rejectsWith(bilateral._execute({ partner: '156', hs_code: '870380' }, BASE, CTX, {}), 'reporter');
    await rejectsWith(bilateral._execute({ reporter: '840', partner: 'World', hs_code: '870380' }, BASE, CTX, {}), 'partner');
  });
});

describe('get_us_import_duty', () => {
  it('sends the HTS digits and the partner code', async () => {
    const wire = { hsCode: '87038000', partnerCountry: '156', htsRelease: '2026 Revision 21', lines: [], additionalDutiesLoaded: true };
    reply = () => json(wire);
    const result = await usDuty._execute({ hs_code: '8703.80.00', partner: 'CN' }, BASE, CTX, {});
    const url = requested[0]!;
    assert.equal(url.pathname, '/api/trade/v1/get-us-import-duty');
    assert.equal(url.searchParams.get('hs_code'), '87038000');
    assert.equal(url.searchParams.get('partner_country'), '156');
    assert.deepEqual(result, wire);
  });

  it('accepts 6, 8 and 10 digits and rejects the rest without a fetch', async () => {
    for (const code of ['870380', '87038000', '8703800010']) {
      await usDuty._execute({ hs_code: code, partner: '156' }, BASE, CTX, {});
    }
    assert.equal(requested.length, 3);
    requested = [];
    await rejectsWith(usDuty._execute({ hs_code: '8703800', partner: '156' }, BASE, CTX, {}), 'hs_code');
    await rejectsWith(usDuty._execute({ hs_code: '870380', partner: '' }, BASE, CTX, {}), 'partner');
  });
});
