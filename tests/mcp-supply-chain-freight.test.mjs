import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { __testing__ as health } from '../api/health.js';
import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { accumulateHistory, parseSseIndexResponse, parseBdiIndices, parseFredShippingIndex, SHIPPING_SERIES } from '../scripts/seed-supply-chain-trade.mjs';
import { validate } from './helpers/json-schema-mini.mjs';

const tool = CACHE_TOOLS.find(t => t.name === 'get_supply_chain_data');
const points = (n, value = i => i + 1) => Array.from({ length: n }, (_, i) => ({ date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`, value: value(i) }));

function freightFixture() {
  const sse = parseSseIndexResponse({ data: {
    currentDate: '2026-10-16', lastDate: '2026-10-09',
    lineDataList: [{ dataItemTypeName: 'SCFI_T', currentContent: 1100, lastContent: 1000, percentage: 10 }],
  } }, 'SCFI', 'SCFI_T', 'Shanghai Container Freight Index', 'index');
  const undated = parseSseIndexResponse({ data: {
    currentDate: '2026-10-16', lineDataList: [{ dataItemTypeName: 'CCFI_T', currentContent: 900 }],
  } }, 'CCFI', 'CCFI_T', 'China Containerized Freight Index', 'index');
  const fred = SHIPPING_SERIES.map(cfg => parseFredShippingIndex(cfg, { observations: [
    { date: '2026-09-01', value: '120' }, { date: '2026-08-01', value: '100' },
  ] }));
  const baltic = parseBdiIndices('18-October-2026 Baltic Dry Index (BDI) at 2000 points. Baltic Capesize Index (BCI) at 3000 points. Baltic Panamax Index (BPI) at 1500 points. Baltic Supramax Index (BSI) at 1200 points. Baltic Handysize Index (BHSI) at 700 points.');
  assert.equal(baltic.length, 5);
  return { indices: accumulateHistory([...sse, ...undated, ...fred, ...baltic], null), fetchedAt: '2026-10-18T00:00:00Z' };
}

async function run(params, shipping = freightFixture(), gscpi = null, meta = {}) {
  const now = Date.now();
  const stored = {
    'supply_chain:shipping:v2': shipping,
    'economic:fred:v1:GSCPI:0': gscpi,
    'seed-meta:supply_chain:shipping': { fetchedAt: now, recordCount: 4, newestItemAt: now, maxContentAgeMin: 28 * 24 * 60 },
    'seed-meta:economic:gscpi': { fetchedAt: now, recordCount: 24 },
    'seed-meta:trade:customs-revenue': { fetchedAt: now, recordCount: 1 },
    ...meta,
  };
  const originalFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  globalThis.fetch = async url => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    return Response.json({ result: stored[key] == null ? null : JSON.stringify(stored[key]) });
  };
  try { return await executeTool(tool, params, now); }
  finally {
    globalThis.fetch = originalFetch;
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

describe('shippingIndexBaseline', () => {
  it('excludes the latest point and uses population standard deviation', async () => {
    const { shippingIndexBaseline } = await import('../api/mcp/registry/_shipping-freight.ts');
    const result = shippingIndexBaseline(points(13));
    assert.equal(result.baselinePoints, 12);
    assert.equal(result.baselineStart, '2025-01-01');
    assert.ok(Math.abs(result.zScore - (13 - 6.5) / Math.sqrt(143 / 12)) < 1e-10);
  });
  it('returns null with fewer than 12 baseline points or zero variance', async () => {
    const { shippingIndexBaseline } = await import('../api/mcp/registry/_shipping-freight.ts');
    assert.equal(shippingIndexBaseline(points(12)).zScore, null);
    assert.equal(shippingIndexBaseline(points(13, () => 7)).zScore, null);
    assert.deepEqual(shippingIndexBaseline([]), { zScore: null, baselinePoints: 0, baselineStart: null });
  });
});

describe('MCP supply chain freight projection', () => {
  it('returns FRED levels and SSE derived fields from real producer fixtures without Baltic entries', async () => {
    const result = await run({ dataset: ['freight-rates'] });
    const indices = result.data['freight-rates'].indices;
    assert.deepEqual(indices.map(i => i.indexId).sort(), ['CCFI', 'PCU483111483111', 'SCFI', 'TSIFRGHT']);
    const sse = indices.find(i => i.indexId === 'SCFI');
    assert.equal(sse.periodChangePct, 10);
    assert.equal(sse.direction, 'up');
    assert.equal(sse.observationDate, '2026-10-16');
    assert.equal(sse.source, 'Shanghai Shipping Exchange');
    assert.equal(indices.find(i => i.indexId === 'CCFI').direction, null);
    for (const idx of indices) {
      assert.equal(idx.baselinePoints, idx.indexId === 'SCFI' || idx.indexId === 'CCFI' ? 0 : 1);
      for (const key of ['changePct', 'previousValue', 'spikeAlert', 'priorPeriodValue']) assert.equal(Object.hasOwn(idx, key), false, key);
      if (['SCFI', 'CCFI'].includes(idx.indexId)) {
        assert.equal(Object.hasOwn(idx, 'currentValue'), false);
        assert.equal(Object.hasOwn(idx, 'history'), false);
      } else {
        assert.equal(idx.currentValue, 120);
        assert.equal(idx.periodChangePct, 20);
        assert.equal(idx.priorPeriodDate, '2026-08-01');
        assert.equal(idx.frequency, 'monthly');
        assert.equal(idx.history.length, 2);
      }
    }
    assert.deepEqual(validate(tool.outputSchema, result), []);
    assert.deepEqual(Object.keys(result.data), ['freight-rates']);
  });
  it('preserves null and unavailable datasets and does not pass through unrecognized sources', async () => {
    assert.equal((await run({ dataset: ['freight-rates'] }, null, { series: {} })).data['freight-rates'], null);
    const result = await run({ dataset: ['freight-rates'] }, { indices: [{ indexId: 'FUTURE', currentValue: 123 }] });
    assert.deepEqual(result.data['freight-rates'].indices, []);
  });
  it('derives FRED movement from dated history and ignores fabricated legacy movement', async () => {
    const fixture = freightFixture();
    const fred = fixture.indices.find(i => i.indexId === 'TSIFRGHT');
    fred.history = [{ date: '2026-09-01', value: 120 }];
    fred.changePct = 999;
    const result = await run({ dataset: ['freight-rates'] }, fixture);
    const idx = result.data['freight-rates'].indices.find(i => i.indexId === 'TSIFRGHT');
    assert.equal(idx.periodChangePct, null);
    assert.equal(idx.direction, null);
  });
  it('returns newest N GSCPI observations in chronological order with NY Fed attribution', async () => {
    const observations = Array.from({ length: 24 }, (_, i) => ({ date: new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 10), value: i / 10 }));
    const result = await run({ dataset: ['gscpi'], limit: 12 }, null, { series: { series_id: 'GSCPI', units: 'Standard Deviations', observations } });
    assert.deepEqual(result.data.gscpi.series.observations, observations.slice(-12));
    assert.equal(result.data.gscpi.series.units, 'Standard Deviations');
    assert.equal(result.data.gscpi.source, 'Federal Reserve Bank of New York');
    assert.deepEqual(Object.keys(result.data), ['gscpi']);
    assert.deepEqual(validate(tool.outputSchema, result), []);
    assert.equal((await run({ dataset: ['gscpi'], limit: 0 }, null, { series: { observations } })).data.gscpi.series.observations.length, 24);
  });
  it('rounds positive fractional limits down without treating them as the zero opt-out', async () => {
    const observations = [{ date: '2026-08-01', value: 0.1 }, { date: '2026-09-01', value: 0.2 }];
    for (const [limit, expected] of [[0.5, []], [1.5, observations.slice(-1)], [0, observations]]) {
      const result = await run({ limit }, undefined, { series: { observations } });
      assert.deepEqual(result.data.gscpi.series.observations, expected);
      assert.equal(result.data['freight-rates'].indices.length, limit === 0 ? 4 : Math.floor(limit));
    }
  });
  it('flags frozen freight observations despite a fresh heartbeat', async () => {
    const meta = { fetchedAt: Date.now(), recordCount: 4, newestItemAt: Date.now() - 40 * 86_400_000, maxContentAgeMin: 28 * 24 * 60 };
    const frozen = await run({ dataset: ['freight-rates'] }, undefined, null, { 'seed-meta:supply_chain:shipping': meta });
    assert.equal(frozen.stale, true);
    const current = await run({ dataset: ['freight-rates'] });
    assert.equal(current.stale, false);
  });
  it('uses health-aligned freshness checks and flags expired freight and GSCPI metadata', async () => {
    for (const { key, maxStaleMin } of [health.SEED_META.shippingRates, health.SEED_META.gscpi]) {
      assert.ok(tool._freshnessChecks.some(c => c.key === key && c.maxStaleMin === maxStaleMin));
      const result = await run({}, undefined, null, { [key]: { fetchedAt: Date.now() - (maxStaleMin + 1) * 60_000 } });
      assert.equal(result.stale, true);
    }
  });
});
