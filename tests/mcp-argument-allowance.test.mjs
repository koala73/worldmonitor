import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { makePipelineMock } from './helpers/mcp-pro-deps.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { validateToolArgs } from '../api/mcp/_validate-args.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MCP_TELEMETRY', 'MCP_INTERNAL_HMAC_SECRET']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function setup() {
  process.env.MCP_TELEMETRY = 'false';
  installRedis({
    'economic:eu-gas-storage:v1': { history: [{ date: '2026-10-18', fillPct: 80 }] },
    'cyber:threats-bootstrap:v2': { threats: [{ country: 'IQ' }] },
    'sanctions:entities:v1': [],
    'sanctions:pressure:v1': {},
    'sanctions:changes:v1': { fetchedAt: 1, events: [] },
  });
  const redisFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (...args) => { fetches++; return redisFetch(...args); };
  const pipe = makePipelineMock({ initialCount: 2 });
  return { pipe, fetches: () => fetches };
}

const meters = [
  ['free account', undefined, true],
  ['Pro', { allowance: 'mcp', limit: 50 }, false],
  ['API', { allowance: 'api', counter: 'api', limit: 1000 }, false],
];
const call = (pipe, name, args, budget, freeAccount) => dispatchToolsCall(
  new Request('https://worldmonitor.app/mcp'),
  { kind: 'user_key', userId: 'argument-validation-user' },
  { redisPipeline: pipe.pipeline },
  { id: 42, params: { name, arguments: args } }, {}, undefined, budget, freeAccount,
);

for (const [meter, budget, freeAccount] of meters) {
  for (const [name, args, field] of [
    ['get_tariff_trends', { dataset: ['tariffs', 'bigmac'] }, 'dataset'],
    ['get_price_and_debt_indicators', { dataset: ['tariffs'] }, 'dataset'],
    ['get_tariff_trends', { country: 'Atlantis' }, 'country'],
    ['get_price_and_debt_indicators', { country: 'Atlantis' }, 'country'],
    ['get_energy_storage', { dataset: ['unsupported'] }, 'dataset'],
    ['get_energy_storage', { limit: 1.5 }, 'limit'],
    ['get_energy_storage', { limit: -1 }, 'limit'],
    ['get_energy_storage', { limit: Number.MAX_SAFE_INTEGER + 1 }, 'limit'],
    ['get_energy_storage', { limit: '3' }, 'limit'],
    ['get_energy_storage', [], 'arguments'],
    ['get_energy_storage', null, 'arguments'],
    ['get_cyber_threats', { country: 'Atlantis' }, 'country'],
  ]) {
    it(`${meter}: ${name} rejects ${JSON.stringify(args)} without spending allowance`, async () => {
      const { pipe, fetches } = setup();
      const response = await call(pipe, name, args, budget, freeAccount);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.error?.code, -32602, JSON.stringify(body));
      assert.equal(body.error.message, 'Invalid params');
      assert.ok(body.error.data.violations.some(v => v.field === field || v.field.startsWith(`${field}.`)));
      assert.equal(pipe.count, 2, 'daily counter must remain unchanged');
      assert.deepEqual(pipe.ops, [], 'validation must precede every reservation');
      assert.equal(fetches(), 0, 'invalid arguments must not fetch data');
    });
  }

  it(`${meter}: valid storage calls remain charged`, async () => {
    const { pipe, fetches } = setup();
    const response = await call(pipe, 'get_energy_storage', { dataset: ['eu-gas-storage'], limit: 0 }, budget, freeAccount);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(pipe.count, 3);
    assert.ok(fetches() > 0);
  });

  it(`${meter}: data fetch failures remain charged`, async () => {
    const { pipe } = setup();
    globalThis.fetch = async () => { throw new Error('controlled upstream outage'); };
    await call(pipe, 'get_energy_storage', {}, budget, freeAccount);
    assert.equal(pipe.count, 3, 'no refund after execution starts');
  });
}

it('Pro rejects an unresolved required country before reservation or RPC fetch', async () => {
  const { pipe, fetches } = setup();
  const response = await call(pipe, 'get_country_coverage', { country_code: 'Atlantis' }, meters[1][1], false);
  assert.equal((await response.json()).error?.code, -32602);
  assert.equal(pipe.count, 2);
  assert.deepEqual(pipe.ops, []);
  assert.equal(fetches(), 0);
});

for (const [name, args, field] of [
  ['get_macro_history', { dataset: 'world-cpi', country: 'Atlantis' }, 'country'],
  ['get_supply_chain_cost_shock', { mode: 'energy', country: 'Atlantis', chokepoint_id: 'hormuz_strait' }, 'country'],
  ['compute_energy_shock', { country: 'Atlantis', chokepoint_id: 'hormuz_strait' }, 'country'],
  ['get_internet_activity', { dataset: 'traffic', country: 'Atlantis' }, 'country'],
  ['get_tariff_averages', { reporter: 'Atlantis' }, 'reporter'],
  ['get_bilateral_tariff', { reporter: 'US', partner: 'Atlantis', hs_code: '270900' }, 'partner'],
  ['get_us_import_duty', { partner: 'Atlantis', hs_code: '270900' }, 'partner'],
  ['get_macro_history', { dataset: 'us-cpi', country: 'US' }, 'country'],
  ['get_internet_activity', { dataset: 'ddos', country: 'US' }, 'country'],
  ['get_country_brief_section', { section: 'food' }, 'arguments'],
  ['get_supply_chain_cost_shock', { mode: 'energy', country: 'JP', chokepoint_id: 'suez', closure_days: 1 }, 'closure_days'],
  ['get_supply_chain_cost_shock', { mode: 'multi-sector', country: 'JP', chokepoint_id: 'suez', hs2: '27' }, 'hs2'],
  ['get_bilateral_tariff', { reporter: 'US', partner: 'CN', hs_code: 'bad' }, 'hs_code'],
  ['get_us_import_duty', { partner: 'CN', hs_code: 'bad' }, 'hs_code'],
  ['get_food_stocks', { country_code: 'Atlantis' }, 'country_code'],
  ['get_food_stocks', { country_code: 'EG', commodity: 'potatoes' }, 'commodity'],
  ['get_country_brief_section', { section: 'food', arguments: { countryCode: 'EG', commodity: 'potatoes' } }, 'arguments.commodity'],
  ['search_intel_history', { query: 'shipping', country: 'Atlantis' }, 'country'],
  ['get_similar_events', { situation: 'a naval blockade', country: 'Atlantis' }, 'country'],
  ['get_intel_timeline', { country: 'Atlantis' }, 'country'],
  ['get_intel_timeline', {}, 'domain'],
  ['get_forecast_scorecard', { view: 'archive', before: 'bad' }, 'before'],
  ['open_country_brief', { country_code: 'Atlantis' }, 'country_code'],
  ['get_country_brief_section', { section: 'signalsRaw', arguments: { country_code: 'ZZ' } }, 'arguments'],
  ['open_news_dashboard', { map_latitude: 1 }, 'view'],
  ['get_alert_digest', { view: 'today', movers_days: 7 }, 'movers_days'],
]) {
  it(`${name} rejects invalid ${field} before reservation`, async () => {
    const { pipe, fetches } = setup();
    const body = await (await call(pipe, name, args, meters[1][1], false)).json();
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error.data.violations[0].field, field);
    assert.deepEqual(pipe.ops, []);
    assert.equal(pipe.count, 2);
    assert.equal(fetches(), 0);
  });
}

for (const [meter, budget] of meters.slice(1)) {
  for (const [args, field] of [
    [{ screen: '  ' }, 'screen'],
    [{ screen: 'Example', changes_since_days: 1 }, 'screen'],
    [{ changes_cursor: '1:0' }, 'changes_cursor'],
    [{ changes_since_days: 1, changes_cursor: 'bad' }, 'changes_cursor'],
  ]) {
    it(`${meter}: sanctions rejects ${JSON.stringify(args)} before spending allowance`, async () => {
      const { pipe, fetches } = setup();
      const body = await (await call(pipe, 'get_sanctions_data', args, budget, false)).json();
      assert.equal(body.error?.code, -32602, JSON.stringify(body));
      assert.equal(body.error.data.violations[0].field, field);
      assert.equal(pipe.count, 2);
      assert.deepEqual(pipe.ops, []);
      assert.equal(fetches(), 0);
    });
  }
}

for (const [meter, budget] of meters.slice(1)) {
  for (const [args, field] of [
    [{ operation: 'analysis', symbols: ['AAPL', 'MSFT'] }, 'symbols'],
    [{ operation: 'backtest', symbols: ['AAPL', 'MSFT'] }, 'symbols'],
    [{ operation: 'analysis', symbols: ['??'] }, 'symbols'],
    [{ operation: 'history', symbols: ['  '] }, 'symbols'],
    [{ operation: 'backtest', symbols: ['AAPL'], include_news: false }, 'include_news'],
    [{ operation: 'analysis', symbols: ['AAPL'], limit_per_symbol: 4 }, 'limit_per_symbol'],
    [{ operation: 'history', symbols: ['AAPL'], eval_window_days: 10 }, 'eval_window_days'],
  ]) {
    it(`${meter}: stock research rejects ${JSON.stringify(args)} without spending allowance`, async () => {
      const { pipe, fetches } = setup();
      const body = await (await call(pipe, 'get_stock_research', args, budget, false)).json();
      assert.equal(body.error?.code, -32602, JSON.stringify(body));
      assert.equal(body.error.data.violations[0].field, field);
      assert.equal(pipe.count, 2, 'daily counter must remain unchanged');
      assert.deepEqual(pipe.ops, [], 'validation must precede every reservation');
      assert.equal(fetches(), 0, 'invalid arguments must not fetch data');
    });
  }

  for (const operation of ['analysis', 'backtest', 'history', 'stored-backtests']) {
    it(`${meter}: valid stock ${operation} remains charged and normalizes symbols`, async () => {
      const { pipe } = setup();
      process.env.MCP_INTERNAL_HMAC_SECRET = 'stock-allowance-test-secret';
      let fetches = 0;
      globalThis.fetch = async input => {
        fetches++;
        const url = new URL(String(input));
        const single = operation === 'analysis' || operation === 'backtest';
        assert.equal(url.searchParams.get(single ? 'symbol' : 'symbols'), 'AAPL');
        return Response.json(single ? { available: false, symbol: 'AAPL' } : { items: [] });
      };
      const body = await (await call(pipe, 'get_stock_research', { operation, symbols: [' aapl '] }, budget, false)).json();
      assert.equal(body.error, undefined, JSON.stringify(body));
      assert.notEqual(body.result?.isError, true, JSON.stringify(body));
      assert.equal(pipe.count, meter === 'API' ? 4 : 3);
      assert.equal(fetches, 1);
    });
  }

  it(`${meter}: stock data fetch failures remain charged`, async () => {
    const { pipe } = setup();
    process.env.MCP_INTERNAL_HMAC_SECRET = 'stock-allowance-test-secret';
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('controlled upstream outage'); };
    await call(pipe, 'get_stock_research', { operation: 'analysis', symbols: ['AAPL'] }, budget, false);
    assert.equal(pipe.count, meter === 'API' ? 4 : 3, 'no refund after execution starts');
    assert.equal(fetches, 1);
  });
}

it('invalid panel openings and refreshes do not allocate a paid panel', async () => {
  const { pipe, fetches } = setup();
  for (const extra of [{}, { refresh: true, request_id: crypto.randomUUID() }]) {
    const response = await call(pipe, 'get_market_data', { asset_class: ['invalid'], ...extra }, meters[1][1], false);
    assert.equal((await response.json()).error?.code, -32602);
  }
  assert.equal(pipe.count, 2);
  assert.deepEqual(pipe.ops, []);
  assert.equal(fetches(), 0);
});

it('API country brief rejects malformed UUIDs before spending allowance', async () => {
  const { pipe, fetches } = setup();
  const body = await (await call(pipe, 'open_country_brief', { country_code: 'US', request_id: 'bad' }, meters[2][1], false)).json();
  assert.equal(body.error?.code, -32602);
  assert.equal(body.error.data.violations[0].field, 'request_id');
  assert.equal(pipe.count, 2);
  assert.deepEqual(pipe.ops, []);
  assert.equal(fetches(), 0);
});

for (const [name, args] of [
  ['open_country_brief', { country_code: 'Atlantis' }],
  ['get_country_brief_section', { section: 'signalsRaw', arguments: { country_code: 'ZZ' } }],
  ['open_news_dashboard', { map_latitude: 1 }],
  ['get_alert_digest', { view: 'today', movers_days: 7 }],
  ['get_country_brief_section', { section: 'food', arguments: { countryCode: 'EG', commodity: 'potatoes' } }],
]) {
  it(`API ${name} validates local refinements before spending allowance`, async () => {
    const { pipe, fetches } = setup();
    const body = await (await call(pipe, name, args, meters[2][1], false)).json();
    assert.equal(body.error?.code, -32602);
    assert.equal(pipe.count, 2);
    assert.deepEqual(pipe.ops, []);
    assert.equal(fetches(), 0);
  });
}

it('repeated invalid calls leave a free account able to make a valid call', async () => {
  const { pipe } = setup();
  for (let i = 0; i < 6; i++) {
    assert.equal((await (await call(pipe, 'get_energy_storage', { limit: -1 }, undefined, true)).json()).error?.code, -32602);
  }
  assert.equal(pipe.count, 2);
  assert.equal((await (await call(pipe, 'get_energy_storage', {}, undefined, true)).json()).error, undefined);
  assert.equal(pipe.count, 3);
});

it('validates required selectors, nested defaults and unique members without changing arguments', () => {
  const scorecard = TOOL_REGISTRY.find(tool => tool.name === 'get_five_factor_scorecard');
  for (const args of [{ country_code: 'US' }, { members: ['US', 'CA'] }]) assert.doesNotThrow(() => validateToolArgs(scorecard, args));
  for (const args of [{}, { country_code: 'US', members: ['US', 'CA'] }, { members: ['US', 'US'] }]) {
    assert.throws(() => validateToolArgs(scorecard, args), RpcValidationError);
  }
  const reader = TOOL_REGISTRY.find(tool => tool.name === 'get_country_brief_section');
  const args = { section: 'food', arguments: { countryCode: 'US' } };
  const original = structuredClone(args);
  assert.doesNotThrow(() => validateToolArgs(reader, args));
  assert.deepEqual(args, original, 'defaulted reader fields must stay omitted');
  assert.throws(() => validateToolArgs(reader, { section: 'food', arguments: { countryCode: 'US', extra: true } }), RpcValidationError);
  assert.throws(() => validateToolArgs(reader, { section: 'food', arguments: { countryCode: 'USA' } }), RpcValidationError);
});

it('country hooks reject unresolved filters while retaining aliases and Eurostat aggregates', () => {
  for (const tool of TOOL_REGISTRY.filter(tool => tool._validateArgs)) {
    const field = ['country', 'countries', 'country_code'].find(field => tool.inputSchema.properties[field]);
    if (!field) continue;
    const base = tool.name === 'get_macro_history' ? { dataset: 'world-cpi' } : {};
    if (tool.name === 'get_conflict_events') {
      // Conflict country is a free-text name substring; this hook parses only the area and age filters.
      for (const value of ['Atlantis', 'sud', 'IQ']) assert.doesNotThrow(() => tool._validateArgs({ [field]: value }), tool.name);
      continue;
    }
    if (['get_food_stocks', 'search_intel_history', 'get_intel_timeline', 'get_similar_events', 'open_news_dashboard'].includes(tool.name)) {
      assert.throws(() => tool._validateArgs({ [field]: 'Atlantis' }), RpcValidationError, tool.name);
      assert.doesNotThrow(() => tool._validateArgs({ [field]: 'IQ' }), tool.name);
      assert.throws(() => tool._validateArgs({ [field]: 'IRQ' }), RpcValidationError, tool.name);
      continue;
    }
    for (const value of ['Atlantis', { toString: 'x' }]) assert.throws(() => tool._validateArgs({ ...base, [field]: value }), RpcValidationError, tool.name);
    for (const value of ['IQ', 'IRQ', 'Iraq']) {
      if (tool.name === 'get_focal_points') continue;
      assert.doesNotThrow(() => tool._validateArgs({ ...base, [field]: value }), tool.name);
    }
  }
  for (const name of ['get_eu_housing_cycle', 'get_eu_quarterly_gov_debt', 'get_eu_industrial_production']) {
    assert.doesNotThrow(() => TOOL_REGISTRY.find(tool => tool.name === name)._validateArgs({ countries: ['EA20', 'EU27_2020', 'EL'] }));
  }
});

it('food stocks preserves omitted and empty commodities and downstream aliases', () => {
  const tool = TOOL_REGISTRY.find(tool => tool.name === 'get_food_stocks');
  assert.doesNotThrow(() => validateToolArgs(tool, { country_code: 'EG' }));
  for (const commodity of ['', '  ', 'wheat', 'corn', 'maize', 'rice', 'soy', 'soybean', 'soybeans', 'barley', 'palmOil', 'palm_oil', 'palm-oil', ' PALM OIL ']) {
    assert.doesNotThrow(() => validateToolArgs(tool, { country_code: 'EG', commodity }), commodity);
    assert.doesNotThrow(() => validateToolArgs(TOOL_REGISTRY.find(tool => tool.name === 'get_country_brief_section'), { section: 'food', arguments: { countryCode: 'EG', commodity } }), commodity);
  }
});

it('supply vulnerabilities retains country names and alpha-3 aliases through schema validation', () => {
  const tool = TOOL_REGISTRY.find(tool => tool.name === 'get_supply_vulnerabilities');
  for (const country_code of ['AE', 'ARE', 'United Arab Emirates']) {
    assert.doesNotThrow(() => validateToolArgs(tool, { country_code }), country_code);
  }
});

it('covers the validation vocabulary in every published tool input schema', () => {
  const supported = new Set('$schema type properties required items enum const minimum maximum exclusiveMinimum minLength maxLength pattern minItems maxItems uniqueItems additionalProperties oneOf description default format'.split(' '));
  function check(schema) {
    if (!schema || typeof schema !== 'object') return;
    for (const [key, value] of Object.entries(schema)) {
      assert.ok(supported.has(key), `Implement input validation for schema keyword ${key}`);
      if (key === 'properties') Object.values(value).forEach(check);
      else if (key === 'oneOf') value.forEach(check);
      else if (key === 'items' || key === 'additionalProperties') check(value);
    }
  }
  TOOL_REGISTRY.forEach(tool => check(tool.inputSchema));
});
