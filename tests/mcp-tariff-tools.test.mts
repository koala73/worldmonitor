// Behavior tests for the live tariff MCP tools. Drives the REAL _execute
// through a mocked gateway fetch, so the query each tool sends, its argument
// resolution and its fault mapping are pinned here rather than by source grep.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import Ajv2020 from 'ajv/dist/2020.js';

import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';
import { applyJmespath } from '../api/mcp/jmespath.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { tradeCountryCode } from '../api/mcp/registry/tariff-tools.ts';
import { M49_TO_WTO_CODE, PRODUCT_GROUPS, witsCountry } from '../server/worldmonitor/trade/v1/_tradestats-tariff.ts';
import { tariffTrendSeedKey } from '../scripts/seed-supply-chain-trade.mjs';

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

const SCHEDULE_COVERAGE = {
  rateBasis: 'SCHEDULE',
  includesUnilateralDuties: false,
  excludedDutyTypes: ['SECTION_301', 'SECTION_232', 'IEEPA', 'ANTI_DUMPING', 'COUNTERVAILING'],
};
const US_DUTY_COVERAGE = {
  dataset: 'USITC_HTS',
  rateBasis: 'CURRENT_DUTY',
  includesUnilateralDuties: true,
  excludedDutyTypes: ['IEEPA', 'ANTI_DUMPING', 'COUNTERVAILING'],
};
const BASE_ONLY_EXCLUDED = ['SECTION_301', 'SECTION_232', 'IEEPA', 'ANTI_DUMPING', 'COUNTERVAILING'];
const US_SEE_ALSO = {
  tool: 'get_us_import_duty',
  reason: 'Schedule rates leave out Section 301 and 232 duties; get_us_import_duty returns the US duty in force, including them.',
};

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
    assert.deepEqual(result, {
      ...wire,
      coverage: { ...SCHEDULE_COVERAGE, dataset: 'WITS_TRAINS', latestYear: 2023, seeAlso: US_SEE_ALSO },
    }, 'the route answer is returned unchanged, plus coverage');
  });

  it('defaults to the US MFN series: no partner, no group, no years', async () => {
    await averages._execute({}, BASE, CTX, {});
    const url = requested[0]!;
    assert.equal(url.searchParams.get('reporting_country'), '840');
    for (const name of ['partner_country', 'product_sector', 'years']) {
      assert.equal(url.searchParams.has(name), false, `${name} must be omitted`);
    }
  });

  it('sends the WTO code the MFN seed is keyed by for France, Norway, India and Switzerland', async () => {
    for (const [name, wto] of [['India', '699'], ['France', '251'], ['NO', '579'], ['CHE', '757']]) {
      requested = [];
      await averages._execute({ reporter: name }, BASE, CTX, {});
      const reporter = requested[0]!.searchParams.get('reporting_country')!;
      assert.equal(reporter, wto, name);
      assert.equal(tariffTrendSeedKey(reporter), `trade:tariffs:v2:${wto}`);
    }
    requested = [];
    await averages._execute({ reporter: 'US', partner: 'India' }, BASE, CTX, {});
    assert.equal(requested[0]!.searchParams.get('partner_country'), '699');
  });

  it('maps each M49 code to a WTO code that WITS reads as the same economy', () => {
    for (const [m49, wto] of Object.entries(M49_TO_WTO_CODE)) {
      assert.ok(witsCountry(m49, 'reporter'), m49);
      assert.equal(witsCountry(wto, 'reporter'), witsCountry(m49, 'reporter'), `${m49} -> ${wto}`);
      assert.equal(witsCountry(wto, 'partner'), witsCountry(m49, 'partner'), `${m49} -> ${wto}`);
    }
  });

  it('matches product groups case-insensitively and sends WITS spelling; "all" sends none', async () => {
    await averages._execute({ product_group: '84-85_machelec' }, BASE, CTX, {});
    assert.equal(requested[0]!.searchParams.get('product_sector'), '84-85_MachElec');
    requested = [];
    await averages._execute({ product_group: 'ALL' }, BASE, CTX, {});
    assert.equal(requested[0]!.searchParams.has('product_sector'), false);
  });

  it('rejects an unknown or non-string product group without a fetch', async () => {
    await rejectsWith(averages._execute({ product_group: 'MadeUpGroup' }, BASE, CTX, {}), 'product_group');
    await rejectsWith(averages._execute({ product_group: 123 }, BASE, CTX, {}), 'product_group');
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

  it('relays a coverage answer unchanged, plus coverage with no vintage', async () => {
    const wire = { datapoints: [], fetchedAt: '', upstreamUnavailable: false, unavailableReason: 'TARIFF_TREND_UNAVAILABLE_REASON_NOT_COVERED' };
    reply = () => json(wire);
    assert.deepEqual(await averages._execute({ partner: '158' }, BASE, CTX, {}), {
      ...wire,
      coverage: { ...SCHEDULE_COVERAGE, dataset: 'WITS_TRAINS', seeAlso: US_SEE_ALSO },
    });
  });

  it('turns a gateway 400 with violations into Invalid params', async () => {
    reply = () => json({ violations: [{ field: 'reporting_country', description: 'value does not match regex pattern' }] }, 400);
    await assert.rejects(averages._execute({}, BASE, CTX, {}), RpcValidationError);
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
    assert.equal(url.searchParams.get('reporting_country'), '356', 'only the MFN seed needs WTO codes');
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
    assert.deepEqual(result, { ...wire, coverage: { ...US_DUTY_COVERAGE, asOf: '2026 Revision 21' } });
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

// Every successful answer says which dataset answered, whether it is a schedule
// rate or the duty in force, which duties it leaves out and when it stops, so
// an agent cannot present a 2023 schedule rate as today's US duty.
describe('coverage on tariff answers', () => {
  const MFN_WIRE = {
    datapoints: [
      { reportingCountry: '840', partnerCountry: 'World', productSector: 'All products', year: 2022, tariffRate: 3.3, boundRate: 0, indicatorCode: 'TP_A_0010', weightedRate: 0 },
      { reportingCountry: '840', partnerCountry: 'World', productSector: 'All products', year: 2023, tariffRate: 3.3, boundRate: 0, indicatorCode: 'TP_A_0010', weightedRate: 0 },
    ],
    fetchedAt: '2026-10-10T00:00:00.000Z',
    upstreamUnavailable: false,
    unavailableReason: '',
    coverageStartYear: 1996,
    coverageEndYear: 2023,
  };

  it('averages, reporter omitted, no partner: WTO MFN schedule with the coverage end year and a pointer to the US duty', async () => {
    reply = () => json(MFN_WIRE);
    const result = await averages._execute({}, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(result.coverage, { ...SCHEDULE_COVERAGE, dataset: 'WTO_MFN', latestYear: 2023, seeAlso: US_SEE_ALSO });
  });

  it('averages with World as partner is still the MFN series', async () => {
    reply = () => json(MFN_WIRE);
    const result = await averages._execute({ reporter: 'US', partner: 'World' }, BASE, CTX, {}) as { coverage: { dataset: string } };
    assert.equal(result.coverage.dataset, 'WTO_MFN');
  });

  it('averages for Germany with a partner: WITS TRAINS and no pointer to the US-only tool', async () => {
    reply = () => json(MFN_WIRE);
    const result = await averages._execute({ reporter: '276', partner: 'China' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(result.coverage, { ...SCHEDULE_COVERAGE, dataset: 'WITS_TRAINS', latestYear: 2023 });
  });

  it('averages with a product group only is WITS TRAINS', async () => {
    reply = () => json(MFN_WIRE);
    const result = await averages._execute({ product_group: 'Food' }, BASE, CTX, {}) as { coverage: { dataset: string } };
    assert.equal(result.coverage.dataset, 'WITS_TRAINS');
  });

  it('averages without coverageEndYear takes the newest datapoint year', async () => {
    const { coverageEndYear: _end, coverageStartYear: _start, ...wire } = MFN_WIRE;
    reply = () => json({ ...wire, datapoints: [...wire.datapoints].reverse() });
    const result = await averages._execute({ reporter: '276' }, BASE, CTX, {}) as { coverage: { latestYear?: number } };
    assert.equal(result.coverage.latestYear, 2023);
  });

  it('WTO MFN coverage follows newer provider years without imposing the WITS ending year', async () => {
    for (const year of [2025, 2027]) {
      const wire = { ...MFN_WIRE, datapoints: [{ ...MFN_WIRE.datapoints[0], year }], coverageEndYear: year };
      reply = () => json(wire);
      const result = await averages._execute({}, BASE, CTX, {});
      assert.deepEqual(result, { ...wire, coverage: { ...SCHEDULE_COVERAGE, dataset: 'WTO_MFN', latestYear: year, seeAlso: US_SEE_ALSO } });
    }
  });

  it('bilateral with the US as reporter: the answering year and a pointer to the US duty', async () => {
    const wire = { reportingCountry: '840', partnerCountry: '156', hsCode: '870380', year: 2021, basis: 'APPLIED_TARIFF_BASIS_MFN', unavailableReason: '' };
    reply = () => json(wire);
    const result = await bilateral._execute({ reporter: '840', partner: '156', hs_code: '870380' }, BASE, CTX, {});
    assert.deepEqual(result, { ...wire, coverage: { ...SCHEDULE_COVERAGE, dataset: 'WITS_TRAINS', latestYear: 2021, seeAlso: US_SEE_ALSO } });
  });

  it('bilateral with the EU as reporter carries no pointer to the US-only tool', async () => {
    reply = () => json({ reportingCountry: '918', partnerCountry: '156', hsCode: '870380', year: 2023 });
    const result = await bilateral._execute({ reporter: 'EU', partner: '156', hs_code: '870380' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(result.coverage, { ...SCHEDULE_COVERAGE, dataset: 'WITS_TRAINS', latestYear: 2023 });
  });

  it('bilateral NOT_COVERED is relayed with its reason, plus coverage with no vintage', async () => {
    const wire = { reportingCountry: '840', partnerCountry: '158', hsCode: '870380', year: 0, upstreamUnavailable: false, unavailableReason: 'BILATERAL_TARIFF_UNAVAILABLE_REASON_NOT_COVERED' };
    reply = () => json(wire);
    const result = await bilateral._execute({ reporter: '840', partner: '158', hs_code: '870380' }, BASE, CTX, {});
    assert.deepEqual(result, { ...wire, coverage: { ...SCHEDULE_COVERAGE, dataset: 'WITS_TRAINS', seeAlso: US_SEE_ALSO } });
  });

  it('US duty: current duty with Section 301/232, the HTS release as vintage, and no pointer', async () => {
    reply = () => json({ hsCode: '870380', partnerCountry: '156', htsRelease: '2026 Revision 21', lines: [], additionalDutiesLoaded: true });
    const result = await usDuty._execute({ hs_code: '870380', partner: '156' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(result.coverage, { ...US_DUTY_COVERAGE, asOf: '2026 Revision 21' });
  });

  it('US duty answered from base rates only does not claim the unilateral duties', async () => {
    reply = () => json({ hsCode: '870380', partnerCountry: '156', htsRelease: '', lines: [], additionalDutiesLoaded: false });
    const result = await usDuty._execute({ hs_code: '870380', partner: '156' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(result.coverage, { ...US_DUTY_COVERAGE, includesUnilateralDuties: false, excludedDutyTypes: BASE_ONLY_EXCLUDED });
  });

  it('US duty without an additionalDutiesLoaded flag fails closed to base rates only', async () => {
    reply = () => json({ hsCode: '870380', partnerCountry: '156', htsRelease: '', lines: [] });
    const result = await usDuty._execute({ hs_code: '870380', partner: '156' }, BASE, CTX, {}) as Record<string, unknown>;
    assert.deepEqual(result.coverage, { ...US_DUTY_COVERAGE, includesUnilateralDuties: false, excludedDutyTypes: BASE_ONLY_EXCLUDED });
  });

  // An outage is relayed as a 200 with upstreamUnavailable: true. The body
  // answers nothing, so coverage must not describe it as if it did.
  const OUTAGES: Array<[typeof averages, Record<string, unknown>, string]> = [
    [averages, {}, 'TARIFF_TREND_UNAVAILABLE_REASON_UPSTREAM_UNAVAILABLE'],
    [bilateral, { reporter: '840', partner: '156', hs_code: '870380' }, 'BILATERAL_TARIFF_UNAVAILABLE_REASON_UPSTREAM_UNAVAILABLE'],
    [usDuty, { hs_code: '870380', partner: '156' }, 'US_IMPORT_DUTY_UNAVAILABLE_REASON_UPSTREAM_UNAVAILABLE'],
  ];
  for (const [t, args, reason] of OUTAGES) {
    it(`${t.name}: a 200 upstream outage is relayed without coverage`, async () => {
      const wire = { upstreamUnavailable: true, unavailableReason: reason };
      reply = () => json(wire);
      const result = await t._execute(args, BASE, CTX, {});
      assert.deepEqual(result, wire);
    });
  }

  it('a gateway 5xx still rejects on every tool, so no partial answer carries coverage', async () => {
    reply = () => json({ error: 'boom' }, 502);
    await assert.rejects(bilateral._execute({ reporter: '840', partner: '156', hs_code: '870380' }, BASE, CTX, {}));
    await assert.rejects(usDuty._execute({ hs_code: '870380', partner: '156' }, BASE, CTX, {}));
  });

  it('each schema declares coverage as optional and every emitted answer validates against it', async () => {
    const ajv = new Ajv2020({ strict: false });
    const cases: Array<[typeof averages, Record<string, unknown>, unknown]> = [
      [averages, {}, MFN_WIRE],
      [bilateral, { reporter: '840', partner: '156', hs_code: '870380' }, { reportingCountry: '840', year: 2021 }],
      [usDuty, { hs_code: '870380', partner: '156' }, { htsRelease: '2026 Revision 21', lines: [], additionalDutiesLoaded: true }],
    ];
    for (const [t, args, wire] of cases) {
      const schema = t.outputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
      assert.equal(schema.properties.coverage?.type, 'object', t.name);
      assert.ok(!(schema.required ?? []).includes('coverage'), `${t.name}: coverage must stay optional`);
      reply = () => json(wire);
      const result = await t._execute(args, BASE, CTX, {});
      const validate = ajv.compile(buildPublicTool(t, { compressDescriptions: false }).outputSchema);
      assert.ok(validate(result), `${t.name}: ${JSON.stringify(validate.errors)}`);
      // A coverage key the schema does not name is rejected.
      const bad = { ...(result as Record<string, unknown>), coverage: { ...(result as { coverage: object }).coverage, extra: 1 } };
      assert.equal(ajv.compile(t.outputSchema)(bad), false, `${t.name}: coverage must be closed`);
    }
  });

  it('a jmespath projection drops coverage and still validates against the advertised schema', async () => {
    reply = () => json(MFN_WIRE);
    const result = await averages._execute({}, BASE, CTX, {});
    const { value, failed } = applyJmespath(result, 'datapoints[0]');
    assert.equal(failed, undefined);
    assert.equal((value as Record<string, unknown>).coverage, undefined);
    const structured = buildStructuredContent(value, { reshaped: true, rider: null });
    const validate = new Ajv2020({ strict: false }).compile(buildPublicTool(averages, { compressDescriptions: false }).outputSchema);
    assert.ok(validate(structured), JSON.stringify(validate.errors));
  });
});
