import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { coverageGap, sealAliases } from '../api/mcp/alias.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { mcpHandler } from '../api/mcp.ts';
import { RETIRED_TOOLS, TOOL_ALIASES, TOOL_LIST_RESPONSE, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { MCP_TOOLCALL_TELEMETRY_KEYS } from '../api/mcp/telemetry.ts';
import { createMcpUsage, setUsageRpc } from '../api/mcp/usage.ts';
import { BASE_URL, HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'tests/fixtures/mcp-registry-names.json';
const TARIFF_ROUTE = 'GET /api/trade/v1/get-tariff-trends';
const TARIFF_MESSAGE = 'get_tariff_trends with the tariffs dataset now calls get_tariff_averages. This result is the US MFN series for reporter 840.';
const PRICE_MESSAGE = 'get_tariff_trends now calls get_price_and_debt_indicators. Tariff rates are no longer in this bundle. Call get_tariff_averages for the US MFN series.';
const HINT = 'get_tariff_trends is not listed. A dataset of tariffs calls get_tariff_averages. Any other dataset calls get_price_and_debt_indicators.';
const FREE_ENTITLEMENT = { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 };
const API_ENTITLEMENT = {
  planKey: 'api_starter',
  features: { tier: 2, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } },
  validUntil: Date.now() + 86_400_000,
};
const TARIFF_BODY = {
  datapoints: [{ reportingCountry: '840', partnerCountry: 'World', year: 2023, tariffRate: 3.4 }],
  coverage: {
    dataset: 'WTO_MFN',
    rateBasis: 'SCHEDULE',
    includesUnilateralDuties: false,
    excludedDutyTypes: ['SECTION_301', 'SECTION_232', 'IEEPA', 'ANTI_DUMPING', 'COUNTERVAILING'],
  },
};

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false });
const cache = new Map();
const calls = [];
let tariffTool;
let originalExecute;
let originalFetch;
let originalEnv;

function seedPriceBundle() {
  const now = Date.now();
  cache.set('economic:bigmac:v1', { countries: [{ code: 'US', priceUsd: 5.5 }, { code: 'DE', priceUsd: 4.5 }] });
  cache.set('economic:fao-ffpi:v1', { index: 120 });
  cache.set('economic:national-debt:v1', { entries: [{ iso3: 'USA', value: 2, year: 2024 }, { iso3: 'DEU', value: 1, year: 2024 }] });
  for (const key of ['seed-meta:economic:bigmac', 'seed-meta:economic:fao-ffpi', 'seed-meta:economic:national-debt']) {
    cache.set(key, { fetchedAt: now - 60_000, recordCount: 2 });
  }
}

async function call(name, args, { entitlement, headers } = {}) {
  const { deps, pipe } = makeProDeps(entitlement ? { getEntitlements: async () => entitlement } : {});
  const req = headers === undefined
    ? proReq('POST', callBody(name, args))
    : new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(callBody(name, args)),
    });
  const response = await mcpHandler(req, deps);
  return { status: response.status, body: await response.json(), pipe };
}

function assertValid(schema, value, label) {
  const validate = ajv.compile(schema);
  assert.equal(validate(value), true, `${label}: ${JSON.stringify(validate.errors)}`);
}

function advertised(name) {
  const tool = TOOL_LIST_RESPONSE.find((entry) => entry.name === name);
  assert.ok(tool, name);
  return tool.outputSchema;
}

function splitFamily(overrides = {}) {
  return {
    kind: 'dataset-split',
    name: 'get_tariff_trends',
    param: 'dataset',
    proValue: 'tariffs',
    proTarget: 'get_tariff_averages',
    restTarget: 'get_price_and_debt_indicators',
    proTranslate: 'us-mfn-from-limit',
    ...overrides,
  };
}

function miniTool(name, extra = {}) {
  return {
    name,
    outputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    _apiPaths: name === 'get_tariff_averages' ? [TARIFF_ROUTE] : [],
    _cacheKeys: [],
    ...extra,
  };
}

function miniRegistry() {
  return [miniTool('get_tariff_averages'), miniTool('get_price_and_debt_indicators')];
}

function accessOf(tool) {
  return tool.name === 'get_tariff_averages' ? 'subscription' : 'free-account';
}

function stderrOf(err) {
  const raw = err?.stderr ?? err?.message ?? err;
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
}

function servedNames() {
  return [...TOOL_ALIASES.callableNames()];
}

function readBaseNames() {
  const spec = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
  let listed;
  try {
    listed = execFileSync('git', ['ls-tree', spec, FIXTURE], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`git ls-tree ${spec} ${FIXTURE} failed: ${stderrOf(err)}`);
  }
  if (!listed) return [];
  const oid = listed.split(/\s+/)[2];
  try {
    return JSON.parse(execFileSync('git', ['show', `${spec}:${FIXTURE}`], { cwd: repoRoot, encoding: 'utf8' }));
  } catch (showErr) {
    const showReason = stderrOf(showErr);
    let fetchReason = '';
    try {
      execFileSync('git', ['fetch', 'origin', oid], { cwd: repoRoot, encoding: 'utf8' });
    } catch (fetchOidErr) {
      try {
        execFileSync('git', ['fetch', 'origin', spec.replace(/^origin\//, '')], { cwd: repoRoot, encoding: 'utf8' });
      } catch (fetchBranchErr) {
        throw new Error(`base fixture ${FIXTURE} is listed but unreadable (${showReason}); fetch failed: ${stderrOf(fetchOidErr)}; ${stderrOf(fetchBranchErr)}`);
      }
      fetchReason = stderrOf(fetchOidErr);
    }
    try {
      return JSON.parse(execFileSync('git', ['cat-file', '-p', oid], { cwd: repoRoot, encoding: 'utf8' }));
    } catch (catErr) {
      throw new Error(`base fixture ${FIXTURE} blob ${oid} still unreadable after fetch (${fetchReason}): ${stderrOf(catErr)}; show: ${showReason}`);
    }
  }
}

describe('MCP tool aliases', { concurrency: false }, () => {
  before(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.MCP_TELEMETRY = 'false';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://alias-cache.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    delete process.env.VERCEL_ENV;
    tariffTool = TOOL_REGISTRY.find((tool) => tool.name === 'get_tariff_averages');
    originalExecute = tariffTool._execute;
    tariffTool._execute = async (params) => {
      calls.push(structuredClone(params));
      return structuredClone(TARIFF_BODY);
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/get/')) {
        const key = decodeURIComponent(u.split('/get/')[1].split('?')[0]);
        if (!cache.has(key)) return Response.json({ result: null });
        return Response.json({ result: JSON.stringify(cache.get(key)) });
      }
      return Response.json({ result: null });
    };
  });

  after(() => {
    tariffTool._execute = originalExecute;
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  beforeEach(() => {
    calls.length = 0;
    cache.clear();
  });

  it('sends only reporter 840 and the translated years to get_tariff_averages', async () => {
    const cases = [
      [{ dataset: 'tariffs' }, 30, null, 'omitted-was-newest-30'],
      [{ dataset: 'TARIFFS' }, 30, null, 'omitted-was-newest-30'],
      [{ dataset: ['tariffs'] }, 30, null, 'omitted-was-newest-30'],
      [{ dataset: ['Tariffs'] }, 30, null, 'omitted-was-newest-30'],
      [{ dataset: [' tariffs '] }, 30, null, 'omitted-was-newest-30'],
      [{ dataset: ['tariffs', 'TARIFFS'] }, 30, null, 'omitted-was-newest-30'],
      [{ dataset: 'tariffs', limit: 0 }, 30, 0, 'non-positive-was-full-history'],
      [{ dataset: 'tariffs', limit: -4 }, 30, -4, 'non-positive-was-full-history'],
      [{ dataset: 'tariffs', limit: 0.4 }, 1, 0.4, 'row-cap-as-years'],
      [{ dataset: 'tariffs', limit: 1 }, 1, 1, 'row-cap-as-years'],
      [{ dataset: 'tariffs', limit: 15.9 }, 15, 15.9, 'row-cap-as-years'],
      [{ dataset: 'tariffs', limit: 30 }, 30, 30, 'row-cap-as-years'],
      [{ dataset: 'tariffs', limit: '12' }, 12, 12, 'row-cap-as-years'],
      [{ dataset: 'tariffs', limit: 31 }, 30, 31, 'capped-at-30'],
    ];
    for (const [args, years, requested, mismatch] of cases) {
      calls.length = 0;
      const reply = await call('get_tariff_trends', args);
      assert.equal(reply.body.error, undefined, JSON.stringify(reply.body.error));
      assert.deepEqual(calls, [{ reporter: '840', years }]);
      const notice = reply.body.result.structuredContent.deprecation;
      assert.equal(notice.alias, 'get_tariff_trends');
      assert.equal(notice.replacement, 'get_tariff_averages');
      assert.equal(notice.message, TARIFF_MESSAGE);
      assert.equal(notice.moved, undefined);
      assert.deepEqual(notice.limit, { requested, servedAsYears: years, mismatch });
      assert.deepEqual(JSON.parse(reply.body.result.content[0].text).deprecation, notice);
      assertValid(advertised('get_tariff_averages'), reply.body.result.structuredContent, 'tariff alias');
    }
  });

  it('keeps a US country on reporter 840 and rejects any other resolved country before quota', async () => {
    for (const country of [undefined, '', 'US', 'USA', 'United States', 'us', ['US', 'USA']]) {
      calls.length = 0;
      const args = country === undefined ? { dataset: 'tariffs' } : { dataset: 'tariffs', country };
      const reply = await call('get_tariff_trends', args);
      assert.equal(reply.body.error, undefined, JSON.stringify({ country, error: reply.body.error }));
      assert.deepEqual(calls[0], { reporter: '840', years: 30 });
    }
    for (const country of ['DE', 'Germany', ['US', 'DE']]) {
      calls.length = 0;
      const reply = await call('get_tariff_trends', { dataset: 'tariffs', country });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.error.code, -32602);
      assert.equal(reply.body.error.message, 'Invalid params');
      assert.equal(reply.body.error.data.violations[0].field, 'country');
      assert.match(reply.body.error.data.violations[0].description, /US-only/);
      assert.match(reply.body.error.data.violations[0].description, /get_tariff_averages/);
      assert.match(reply.body.error.data.violations[0].description, /reporter/);
      assert.equal(reply.pipe.count, 0);
      assert.equal(calls.length, 0);
      assert.equal(JSON.stringify(reply.body).includes('datapoints'), false);
    }
    const unresolved = await call('get_tariff_trends', { dataset: 'tariffs', country: 'NotARealCountry' });
    assert.equal(unresolved.body.error.data.violations[0].field, 'country');
    assert.match(unresolved.body.error.data.violations[0].description, /Could not resolve/);
    assert.doesNotMatch(unresolved.body.error.data.violations[0].description, /US-only/);
    assert.equal(calls.length, 0);
  });

  it('rejects a mixed dataset before entitlement and quota', async () => {
    const pro = await call('get_tariff_trends', { dataset: ['tariffs', 'bigmac'], country: 'DE' });
    assert.equal(pro.status, 200);
    assert.equal(pro.body.error.code, -32602);
    assert.equal(pro.body.error.data.violations[0].field, 'dataset');
    assert.match(pro.body.error.data.violations[0].description, /get_tariff_averages/);
    assert.match(pro.body.error.data.violations[0].description, /get_price_and_debt_indicators/);
    assert.equal(pro.pipe.count, 0);
    assert.equal(calls.length, 0);

    const free = await call('get_tariff_trends', { dataset: ['tariffs', 'bigmac'] }, { entitlement: FREE_ENTITLEMENT });
    assert.equal(free.status, 200);
    assert.equal(free.body.error.code, -32602);
    assert.equal(free.body.error.data.violations[0].field, 'dataset');
    assert.notEqual(free.body.error.data?.reason, 'upgrade-required');
    assert.equal(free.pipe.count, 0);
  });

  it('rejects a non-primitive dataset or limit as Invalid params before quota', async () => {
    const cases = [
      [{ dataset: [{ toString: 'x' }] }, 'dataset'],
      [{ dataset: { toString: 'x' } }, 'dataset'],
      [{ dataset: 'tariffs', limit: { toString: 'x' } }, 'limit'],
      [{ dataset: 'tariffs', limit: [1] }, 'limit'],
    ];
    for (const [args, field] of cases) {
      const reply = await call('get_tariff_trends', args);
      assert.equal(reply.status, 200, JSON.stringify(args));
      assert.equal(reply.body.error.code, -32602, JSON.stringify(args));
      assert.equal(reply.body.error.data.violations[0].field, field);
      assert.equal(reply.pipe.count, 0);
      assert.equal(calls.length, 0);
    }
  });

  it('serves a budget-exceeded envelope with the notice that a strict client accepts', async () => {
    const originalBudget = tariffTool._outputBudgetBytes;
    tariffTool._outputBudgetBytes = 64;
    try {
      const reply = await call('get_tariff_trends', { dataset: 'tariffs' });
      const structured = reply.body.result.structuredContent;
      assert.equal(structured._budget_exceeded, true);
      assert.equal(structured.deprecation.replacement, 'get_tariff_averages');
      assert.deepEqual(JSON.parse(reply.body.result.content[0].text), structured);
      assertValid(advertised('get_tariff_averages'), structured, 'budget-exceeded alias');
    } finally {
      tariffTool._outputBudgetBytes = originalBudget;
    }
  });

  it('denies a free-allowance tariffs alias the same way as get_tariff_averages', async () => {
    const alias = await call('get_tariff_trends', { dataset: 'tariffs' }, { entitlement: FREE_ENTITLEMENT });
    const direct = await call('get_tariff_averages', {}, { entitlement: FREE_ENTITLEMENT });
    assert.equal(alias.status, 403);
    assert.equal(alias.body.error.code, -32002);
    assert.equal(alias.body.error.data.reason, 'upgrade-required');
    assert.equal(alias.body.error.message, 'This tool requires a WorldMonitor Pro subscription.');
    assert.equal(alias.body.result, undefined);
    assert.equal(JSON.stringify(alias.body).includes('datapoints'), false);
    assert.equal(alias.pipe.count, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(alias.body.error, direct.body.error);
  });

  it('gives a keyless caller and a free context the same denial as get_tariff_averages', async () => {
    const alias = await call('get_tariff_trends', { dataset: 'tariffs' }, { headers: {} });
    const direct = await call('get_tariff_averages', {}, { headers: {} });
    assert.equal(alias.status, 401);
    assert.deepEqual(alias.body.error, direct.body.error);
    assert.equal(calls.length, 0);

    const { deps } = makeProDeps();
    const freeAlias = await dispatchToolsCall(
      new Request(BASE_URL),
      { kind: 'free' },
      deps,
      { id: 1, params: { name: 'get_tariff_trends', arguments: { dataset: 'tariffs' } } },
      {},
    );
    const freeDirect = await dispatchToolsCall(
      new Request(BASE_URL),
      { kind: 'free' },
      deps,
      { id: 1, params: { name: 'get_tariff_averages', arguments: {} } },
      {},
    );
    assert.equal(freeAlias.status, 401);
    const aliasBody = await freeAlias.json();
    const directBody = await freeDirect.json();
    assert.equal(aliasBody.error.data.reason, 'no-account');
    assert.deepEqual(aliasBody.error, directBody.error);
    assert.equal(calls.length, 0);
  });

  it('keeps every other dataset on the price bundle and names that tool in the notice', async () => {
    const datasets = [undefined, [], 'bigmac', ['bigmac'], ['fao-ffpi'], ['national-debt'], 'nope'];
    for (const dataset of datasets) {
      calls.length = 0;
      seedPriceBundle();
      const args = dataset === undefined ? {} : { dataset };
      const reply = await call('get_tariff_trends', args);
      assert.equal(reply.body.error, undefined, JSON.stringify({ dataset, error: reply.body.error }));
      const notice = reply.body.result.structuredContent.deprecation;
      assert.equal(notice.replacement, 'get_price_and_debt_indicators');
      assert.equal(notice.message, PRICE_MESSAGE);
      assert.deepEqual(notice.moved, { dataset: 'tariffs', tool: 'get_tariff_averages' });
      assert.equal(notice.limit, undefined);
      assert.deepEqual(JSON.parse(reply.body.result.content[0].text).deprecation, notice);
      assert.equal(calls.length, 0);
      assertValid(advertised('get_price_and_debt_indicators'), reply.body.result.structuredContent, `price ${JSON.stringify(dataset)}`);
    }
    seedPriceBundle();
    const narrowed = await call('get_tariff_trends', { dataset: ['national-debt'], country: 'US' });
    assert.deepEqual(narrowed.body.result.structuredContent.data['national-debt'].entries.map((entry) => entry.iso3), ['USA']);
    assert.equal(narrowed.body.result.structuredContent.deprecation.replacement, 'get_price_and_debt_indicators');

    const free = await call('get_tariff_trends', { dataset: ['national-debt'] }, { entitlement: FREE_ENTITLEMENT });
    assert.equal(free.status, 200, JSON.stringify(free.body.error));
    assert.equal(free.body.result.structuredContent.deprecation.replacement, 'get_price_and_debt_indicators');
    assert.equal(free.pipe.count, 1);
  });

  it('bills the target weight and drops tariff route arguments', async () => {
    const tariff = await call('get_tariff_trends', { dataset: 'tariffs', summary: true, jmespath: '', extra: true }, { entitlement: API_ENTITLEMENT });
    assert.equal(tariff.body.error, undefined, JSON.stringify(tariff.body.error));
    assert.deepEqual(calls, [{ reporter: '840', years: 30 }]);
    assert.equal(tariff.pipe.count, 2);
    assert.ok(tariff.body.result.structuredContent.datapoints);

    calls.length = 0;
    seedPriceBundle();
    const price = await call('get_tariff_trends', { dataset: ['bigmac'] }, { entitlement: API_ENTITLEMENT });
    assert.equal(price.body.error, undefined, JSON.stringify(price.body.error));
    assert.equal(calls.length, 0);
    assert.equal(price.pipe.count, 1);
    assert.deepEqual(Object.keys(price.body.result.structuredContent.data), ['bigmac']);
  });

  it('keeps raw text for a non-object projection and mirrors the notice into an object one', async () => {
    const scalar = await call('get_tariff_trends', { dataset: 'tariffs', jmespath: 'datapoints[0].year' });
    assert.equal(JSON.parse(scalar.body.result.content[0].text), 2023);
    assert.equal(scalar.body.result.structuredContent.projection, 2023);
    assert.equal(scalar.body.result.structuredContent.deprecation.replacement, 'get_tariff_averages');
    assertValid(advertised('get_tariff_averages'), scalar.body.result.structuredContent, 'scalar projection');

    const missing = await call('get_tariff_trends', { dataset: 'tariffs', jmespath: 'nonexistent' });
    assert.equal(missing.body.result.content[0].text, 'null');
    assert.equal(missing.body.result.structuredContent.projection, null);
    assert.equal(missing.body.result.structuredContent.deprecation.replacement, 'get_tariff_averages');
    assertValid(advertised('get_tariff_averages'), missing.body.result.structuredContent, 'null projection');

    seedPriceBundle();
    const list = await call('get_tariff_trends', { dataset: 'bigmac', jmespath: 'data.bigmac.countries[].code' });
    const direct = await call('get_price_and_debt_indicators', { dataset: ['bigmac'], jmespath: 'data.bigmac.countries[].code' });
    assert.equal(list.body.result.content[0].text, direct.body.result.content[0].text);
    assert.deepEqual(JSON.parse(list.body.result.content[0].text), ['US', 'DE']);
    assert.equal(list.body.result.structuredContent.deprecation.replacement, 'get_price_and_debt_indicators');
    assertValid(advertised('get_price_and_debt_indicators'), list.body.result.structuredContent, 'array projection');

    const object = await call('get_tariff_trends', { dataset: 'tariffs', jmespath: 'datapoints[0]' });
    const objectText = JSON.parse(object.body.result.content[0].text);
    assert.equal(objectText.year, 2023);
    assert.equal(objectText.deprecation.replacement, 'get_tariff_averages');
    assert.equal(object.body.result.structuredContent.projection.year, 2023);
    assert.equal(object.body.result.structuredContent.deprecation.replacement, 'get_tariff_averages');
    assertValid(advertised('get_tariff_averages'), object.body.result.structuredContent, 'object projection');
    assertValid(advertised('get_tariff_averages'), objectText, 'object projection text');
  });

  it('keeps the deprecation notice on an invalid-expression envelope in both channels', async () => {
    const reply = await call('get_tariff_trends', { dataset: 'tariffs', jmespath: '[[[' });
    const structured = reply.body.result.structuredContent;
    assert.match(structured._jmespath_error, /^invalid_expression/);
    assert.equal(structured.deprecation.replacement, 'get_tariff_averages');
    assert.deepEqual(JSON.parse(reply.body.result.content[0].text), structured);
    assertValid(advertised('get_tariff_averages'), structured, 'invalid-expression alias');
  });

  it('keeps unknown names unknown and the direct tariffs dataset on the price tool', async () => {
    const unknown = await call('no_such_tool', {});
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.error.code, -32602);
    assert.match(unknown.body.error.message, /^Unknown tool: no_such_tool/);
    assert.equal(unknown.pipe.count, 0);

    seedPriceBundle();
    const direct = await call('get_price_and_debt_indicators', { dataset: ['tariffs'] });
    assert.equal(direct.body.error.code, -32602);
    assert.equal(direct.body.error.data.violations[0].field, 'dataset.0');
    assert.match(direct.body.error.data.violations[0].description, /bigmac, fao-ffpi, national-debt/);
    assert.equal(direct.pipe.count, 0);
    assert.equal(calls.length, 0);
  });

  it('still validates a direct get_tariff_averages call', async () => {
    tariffTool._execute = originalExecute;
    try {
      const group = await call('get_tariff_averages', { product_group: 'not-a-group' });
      assert.equal(group.body.error.code, -32602);
      assert.equal(group.body.error.message, 'Invalid params');
      assert.equal(group.body.error.data.violations[0].field, 'product_group');
      const years = await call('get_tariff_averages', { years: 99 });
      assert.equal(years.body.error.code, -32602);
      assert.equal(years.body.error.data.violations[0].field, 'years');
    } finally {
      tariffTool._execute = async (params) => {
        calls.push(structuredClone(params));
        return structuredClone(TARIFF_BODY);
      };
    }
  });

  it('lists no alias, describes it as retired_alias, and still calls generate_forecasts', async () => {
    const { deps } = makeProDeps();
    const listed = await mcpHandler(proReq('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), deps);
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert.equal(names.includes('get_tariff_trends'), false);
    assert.equal(names.includes('generate_forecasts'), false);

    const described = await call('describe_tool', { tool_name: 'get_tariff_trends' });
    const body = described.body.result.structuredContent;
    assert.equal(body.error, 'retired_alias');
    assert.deepEqual(body.replacements, ['get_tariff_averages', 'get_price_and_debt_indicators']);
    assert.equal(body.hint, HINT);
    assertValid(advertised('describe_tool'), body, 'retired_alias');

    const missing = await call('describe_tool', { tool_name: 'generate_forecasts' });
    assert.equal(missing.body.result.structuredContent.error, 'unknown_tool');
    assert.equal(missing.body.result.structuredContent.available.includes('get_tariff_trends'), false);
    assert.equal(missing.body.result.structuredContent.available.includes('generate_forecasts'), false);
    assertValid(advertised('describe_tool'), missing.body.result.structuredContent, 'unknown_tool');

    const retired = RETIRED_TOOLS.find((tool) => tool.name === 'generate_forecasts');
    const previous = retired._execute;
    retired._execute = async () => ({ forecasts: [] });
    try {
      const forecast = await call('generate_forecasts', {});
      assert.equal(forecast.body.error, undefined, JSON.stringify(forecast.body.error));
      assert.deepEqual(forecast.body.result.structuredContent.forecasts, []);
    } finally {
      retired._execute = previous;
    }
  });

  it('adds the notice schema only on alias targets, and not inside coverage', () => {
    const tariff = advertised('get_tariff_averages');
    const price = advertised('get_price_and_debt_indicators');
    assert.equal(tariff.anyOf.every((branch) => branch.properties?.deprecation), true);
    assert.equal(price.anyOf.every((branch) => branch.properties?.deprecation), true);
    assert.equal(advertised('get_market_data').anyOf.some((branch) => branch.properties?.deprecation), false);
    assert.equal(advertised('get_bilateral_tariff').anyOf.some((branch) => branch.properties?.deprecation), false);
    assert.equal(tariff.anyOf[0].properties.coverage.additionalProperties, false);
    const validate = ajv.compile(tariff);
    const stuffed = structuredClone(TARIFF_BODY);
    stuffed.coverage.deprecation = { alias: 'get_tariff_trends', replacement: 'get_tariff_averages', message: TARIFF_MESSAGE };
    assert.equal(validate(stuffed), false);
    assert.equal(validate({
      ...TARIFF_BODY,
      deprecation: {
        alias: 'get_tariff_trends',
        replacement: 'get_tariff_averages',
        message: TARIFF_MESSAGE,
        limit: { requested: null, servedAsYears: 30, mismatch: 'omitted-was-newest-30' },
      },
    }), true);
  });

  it('records the alias on wm_api_usage and mcp.toolcall without a resolved_tool key', async () => {
    const usage = createMcpUsage();
    setUsageRpc(usage, 'tools/call', 'get_tariff_trends');
    assert.equal(usage.toolName, 'get_tariff_trends');
    setUsageRpc(usage, 'tools/call', 'no_such_tool');
    assert.equal(usage.toolName, null);

    process.env.MCP_TELEMETRY = 'true';
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => { lines.push(line); };
    try {
      const reply = await call('get_tariff_trends', { dataset: 'tariffs' });
      assert.equal(reply.body.error, undefined, JSON.stringify(reply.body.error));
    } finally {
      console.log = originalLog;
      process.env.MCP_TELEMETRY = 'false';
    }
    const line = lines.find((entry) => entry && entry.tag === 'mcp.toolcall');
    assert.ok(line, 'mcp.toolcall was not emitted');
    assert.equal(line.tool, 'get_tariff_trends');
    assert.equal('resolved_tool' in line, false);
    const allowed = new Set(MCP_TOOLCALL_TELEMETRY_KEYS);
    for (const key of Object.keys(line)) assert.equal(allowed.has(key), true, key);
  });
});

describe('sealAliases', () => {
  it('seals a dataset split and resolves it twice to the same call', () => {
    const registry = miniRegistry();
    const sealed = sealAliases(registry, [], [splitFamily()], [], accessOf);
    const args = { dataset: 'tariffs', limit: 12 };
    assert.deepEqual(sealed.resolve('get_tariff_trends', args), sealed.resolve('get_tariff_trends', args));
    const resolved = sealed.resolve('get_tariff_trends', args);
    assert.equal(resolved.kind, 'alias');
    assert.equal(resolved.tool, registry[0]);
    assert.deepEqual(resolved.arguments, { reporter: '840', years: 12 });
    assert.equal(resolved.argumentsShape, 'legacy');
  });

  it('throws when a target is unregistered, not the tariff subscription, or still serves the old cache', () => {
    const registry = miniRegistry();
    const cases = [
      [splitFamily({ proTarget: 'missing' }), /unregistered target/],
      [splitFamily({ restTarget: 'missing' }), /unregistered target/],
      [splitFamily(), /is not subscription/, () => 'free-account'],
      [splitFamily(), /does not list GET \/api\/trade\/v1\/get-tariff-trends/, accessOf, [
        miniTool('get_tariff_averages', { _apiPaths: [] }),
        miniTool('get_price_and_debt_indicators'),
      ]],
      [splitFamily(), /still lists GET \/api\/trade\/v1\/get-tariff-trends/, accessOf, [
        miniTool('get_tariff_averages'),
        miniTool('get_price_and_debt_indicators', { _apiPaths: [TARIFF_ROUTE] }),
      ]],
      [splitFamily(), /trade:tariffs:/, accessOf, [
        miniTool('get_tariff_averages'),
        miniTool('get_price_and_debt_indicators', { _cacheKeys: ['trade:tariffs:v2:840'] }),
      ]],
      [splitFamily({ restTarget: 'get_tariff_averages' }), /are the same/, accessOf, [miniTool('get_tariff_averages')]],
      [splitFamily(), /rejects the deprecation notice/, accessOf, [
        miniTool('get_tariff_averages', {
          outputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              coverage: { type: 'object', properties: { deprecation: { type: 'string' } } },
            },
          },
        }),
        miniTool('get_price_and_debt_indicators'),
      ]],
    ];
    for (const [family, pattern, access = accessOf, tools = registry] of cases) {
      assert.throws(() => sealAliases(tools, [], [family], [], access), pattern);
    }
  });
});

describe('sealAliases merge family', () => {
  const target = (datasets = ['traffic', 'ddos', 'outages']) => miniTool('get_infrastructure_status', {
    inputSchema: { type: 'object', properties: { dataset: { type: 'array', items: { type: 'string', enum: datasets } } } },
  });
  const merge = { kind: 'merge', name: 'get_internet_activity', target: 'get_infrastructure_status', datasets: ['traffic', 'ddos'] };

  it('translates the old dataset forms and keeps every other argument', () => {
    const sealed = sealAliases([target()], [], [merge], [], accessOf);
    for (const [dataset, expected] of [['traffic', ['traffic']], [['ddos', 'traffic'], ['ddos', 'traffic']], [undefined, ['traffic', 'ddos']], [[], ['traffic', 'ddos']]]) {
      const resolved = sealed.resolve('get_internet_activity', { dataset, country: 'DE', limit: 5 });
      assert.equal(resolved.kind, 'alias');
      assert.equal(resolved.tool.name, 'get_infrastructure_status');
      assert.deepEqual(resolved.arguments, { dataset: expected, country: 'DE', limit: 5 });
      assert.equal(resolved.notice.replacement, 'get_infrastructure_status');
      assert.equal(resolved.argumentsShape, 'target', 'merged arguments must meet the target input schema');
    }
    assert.equal(sealed.resolve('get_internet_activity', null).kind, 'invalid');
    assert.deepEqual(sealed.describe('get_internet_activity').replacements, ['get_infrastructure_status']);
  });

  it('rejects datasets the retired tool never served instead of widening the call', () => {
    const sealed = sealAliases([target()], [], [merge], [], accessOf);
    for (const dataset of ['outages', ['traffic', 'outages'], 7, [7]]) {
      assert.equal(sealed.resolve('get_internet_activity', { dataset }).kind, 'invalid', JSON.stringify(dataset));
    }
  });

  it('refuses to seal when the target is missing or does not offer every merged dataset', () => {
    assert.throws(() => sealAliases([], [], [merge], [], accessOf), /unregistered target/);
    assert.throws(() => sealAliases([target(['outages', 'traffic'])], [], [merge], [], accessOf), /does not offer dataset ddos/);
  });
});

describe('coverageGap', () => {
  it('returns a vanished name and ignores an alias or an opt-out', () => {
    assert.deepEqual(coverageGap(['keep', 'gone'], ['keep'], new Set(), new Set()), ['gone']);
    assert.deepEqual(coverageGap(['keep', 'gone'], ['keep'], new Set(['gone']), new Set()), []);
    assert.deepEqual(coverageGap(['keep', 'gone'], ['keep'], new Set(), new Set(['gone'])), []);
  });

  it('counts a retired name as still served, since an alias or opt-out cannot name it', () => {
    const listed = TOOL_REGISTRY.map((tool) => tool.name);
    const retired = RETIRED_TOOLS.map((tool) => tool.name);
    assert.ok(retired.length > 0);
    assert.deepEqual(
      coverageGap([...listed, ...retired], servedNames(), TOOL_ALIASES.aliasNames(), new Set(TOOL_ALIASES.optOuts().keys())),
      [],
    );
  });

  it('matches the sorted registry and the base revision', () => {
    const current = TOOL_REGISTRY.map((tool) => tool.name).sort();
    const fixture = JSON.parse(readFileSync(path.join(repoRoot, FIXTURE), 'utf8'));
    assert.deepEqual(fixture, current);
    const previous = readBaseNames();
    assert.deepEqual(
      coverageGap(previous, servedNames(), TOOL_ALIASES.aliasNames(), new Set(TOOL_ALIASES.optOuts().keys())),
      [],
    );
  });
});
