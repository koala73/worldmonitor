import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { HMAC_SECRET } from './helpers/mcp-pro-deps.mjs';
import { compactCountry, monthRange } from '../shared/oil-trade-windows.js';
import {
  OIL_TRADE_COUNTRIES,
  assembleCountry,
  buildAisSeries,
  buildEiaSeries,
  buildMirrorSeries,
} from '../scripts/seed-oil-trade-series.mjs';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const KEY = 'energy:oil-trade-series:v1';
const META = 'seed-meta:energy:oil-trade-series';
const tool = CACHE_TOOLS.find((t) => t.name === 'get_oil_trade_series');
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MCP_INTERNAL_HMAC_SECRET', 'MCP_TELEMETRY'];
const originalEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

// Raw EIA STEO PAPR_TC values (mb/d) and a PortWatch feed that stalled mid-August.
const EIA_AE = {
  '2025-04': 4.1548, '2025-05': 4.2748, '2025-06': 4.2453, '2025-07': 4.4152, '2025-08': 4.455, '2025-09': 4.5252,
  '2025-10': 4.495, '2025-11': 4.56, '2025-12': 4.5053, '2026-01': 4.5398, '2026-02': 4.6001, '2026-03': 2.6366,
  '2026-04': 2.7363, '2026-05': 2.9561, '2026-06': 4.5166, '2026-07': 4.596563635, '2026-08': 4.366826444,
  '2026-09': 4.436965302, '2026-10': 4.576726735,
};

function country(iso2, eiaValues, ais = { months: new Map(), datasetMaxDate: null }, mirrorRows = []) {
  const spec = OIL_TRADE_COUNTRIES.find((c) => c.iso2 === iso2);
  const rows = Object.entries(eiaValues).map(([period, value]) => ({ seriesId: `PAPR_${spec.eia}`, period, value: String(value) }));
  return compactCountry(assembleCountry({
    spec,
    eia: buildEiaSeries(rows, NOW).get(iso2) ?? new Map(),
    jodi: new Map(),
    mirror: buildMirrorSeries(mirrorRows),
    ais,
    nowMs: NOW,
  }));
}

function payload() {
  const mirrorRows = monthRange('2025-10', '2026-07').flatMap((m) => [
    { reporterISO: 'JPN', period: m.replace('-', ''), cmdCode: '2709', netWgt: 3.4e9 },
    { reporterISO: 'IND', period: m.replace('-', ''), cmdCode: '2709', netWgt: 2.1e9 },
  ]);
  const stalledAis = buildAisSeries([
    { attributes: { year: 2026, month: 7, exportTankerT: 2_187_331, tankerCalls: 282, maxDate: '2026-07-31' } },
    { attributes: { year: 2026, month: 8, exportTankerT: 1_200_000, tankerCalls: 150, maxDate: '2026-08-21' } },
  ]);
  return {
    generatedAt: new Date(NOW).toISOString(),
    throughMonth: '2026-09',
    conversion: { crudeBblPerTonne: 7.33, productsBblPerTonne: 7.6 },
    unavailable: { mirror: [], ais: [] },
    countries: {
      AE: country('AE', EIA_AE, stalledAis, mirrorRows),
      SA: country('SA', Object.fromEntries(Object.keys(EIA_AE).map((m) => [m, 9.5]))),
    },
  };
}

const meta = {
  fetchedAt: NOW - 3_600_000, recordCount: 22, sourceState: 'ok',
  newestItemAt: Date.parse('2026-09-30T23:59:59Z'), oldestItemAt: Date.parse('2026-09-30T23:59:59Z'), maxContentAgeMin: 100 * 1440,
};

function seed(data = payload(), metadata = meta) {
  return installRedis({ [KEY]: { _seed: { fetchedAt: metadata.fetchedAt }, data }, [META]: metadata });
}

beforeEach((t) => {
  assert.ok(tool, 'get_oil_trade_series must be registered');
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
});
afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('cache contract: one canonical key, weekly freshness, content age honoured', () => {
  assert.deepEqual(tool._cacheKeys, [KEY]);
  assert.deepEqual(tool._freshnessChecks, [{ key: META, maxStaleMin: 20160, minRecordCount: 18, honorContentAge: true }]);
  assert.equal(tool._execute, undefined);
});

test('the original question: UAE, last 6 complete months vs the 6 before, with sources and as-of dates', async () => {
  seed();
  const result = await executeTool(tool, { country: ['United Arab Emirates'] }, NOW);
  assert.equal(result.stale, false);
  assert.equal(result.cached_at, new Date(meta.fetchedAt).toISOString());
  const series = result.data.oilTradeSeries;
  assert.equal(series.countries.length, 1);
  const ae = series.countries[0];
  assert.equal(ae.iso2, 'AE');
  assert.deepEqual(ae.comparison.windows.current, { from: '2026-04', to: '2026-09' });
  assert.deepEqual(ae.comparison.windows.prior, { from: '2025-10', to: '2026-03' });

  const production = ae.comparison.metrics.production;
  assert.equal(Math.round(production.current.kbd), 3936);
  assert.equal(Math.round(production.prior.kbd), 4215);
  assert.equal(production.changePct.toFixed(1), '-6.6');
  assert.equal(ae.sources.production.status, 'ok');
  assert.equal(ae.sources.production.lastObserved, '2026-09');
  assert.match(ae.sources.production.name, /EIA/);

  const mirror = ae.comparison.metrics.mirrorCrudeImports;
  assert.deepEqual(mirror.basis.reporters, ['IND', 'JPN']);
  assert.equal(mirror.current.monthsCovered, 4);
  assert.equal(mirror.complete, false);

  assert.equal(ae.sources.jodi.status, 'not_reported');
  assert.equal(ae.comparison.metrics.jodiCrudeExports.current.kbd, null, 'no JODI filing is null, not 0');

  assert.equal(ae.months.length, 24);
  assert.ok(ajv.validate(tool.outputSchema, result), ajv.errorsText());
});

test('a stalled AIS feed is reported stale with its last month, and later months are null, never 0', async () => {
  seed();
  const ae = (await executeTool(tool, { country: 'AE' }, NOW)).data.oilTradeSeries.countries[0];
  assert.equal(ae.sources.ais.status, 'stale');
  assert.equal(ae.sources.ais.lastObserved, '2026-07');
  assert.equal(ae.months.find((m) => m.month === '2026-09').ais, null);
  assert.equal(ae.months.find((m) => m.month === '2026-08').ais.loadingsKbd, null);
  assert.equal(ae.comparison.metrics.aisTankerLoadings.current.monthsCovered, 1);
});

test('without a country every covered country returns its comparison but no monthly rows', async () => {
  seed();
  const series = (await executeTool(tool, {}, NOW)).data.oilTradeSeries;
  assert.deepEqual(series.countries.map((c) => c.iso2).sort(), ['AE', 'SA']);
  for (const c of series.countries) {
    assert.equal(c.months, undefined);
    assert.ok(c.comparison.metrics.production);
  }
  assert.equal(series.windowMonths, 6);
});

test('window_months changes the windows; out-of-range falls back to 6', async () => {
  seed();
  const three = (await executeTool(tool, { country: 'AE', window_months: 3 }, NOW)).data.oilTradeSeries.countries[0];
  assert.deepEqual(three.comparison.windows.current, { from: '2026-07', to: '2026-09' });
  assert.deepEqual(three.comparison.windows.prior, { from: '2026-04', to: '2026-06' });
  const fallback = (await executeTool(tool, { country: 'AE', window_months: 40 }, NOW)).data.oilTradeSeries;
  assert.equal(fallback.windowMonths, 6);
});

test('a seed older than two weekly runs is stale', async () => {
  seed(payload(), { ...meta, fetchedAt: NOW - 15 * 86_400_000 });
  const result = await executeTool(tool, { country: 'AE' }, NOW);
  assert.equal(result.stale, true);
});
