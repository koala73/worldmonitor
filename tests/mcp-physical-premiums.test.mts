import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { normalizePhysicalDivergenceSnapshot } from '../server/_shared/physical-divergence-snapshot.ts';
import { buildProducerBackedPhysicalComparisonFixture } from './helpers/mcp-producer-fixtures.mjs';

const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
assert.ok(tool && tool._postFilter);

const provenance = (metal: 'gold' | 'silver') => ({
  physicalSource: `Shanghai Gold Exchange ${metal === 'gold' ? 'SHAU' : 'SHAG'} PM benchmark`,
  physicalSymbol: metal === 'gold' ? 'SHAU' : 'SHAG',
  physicalAsOf: '2026-08-18',
  paperSource: `COMEX ${metal === 'gold' ? 'GC=F' : 'SI=F'} futures snapshot`,
  paperSymbol: metal === 'gold' ? 'GC=F' : 'SI=F',
  paperAsOf: '2026-08-18T12:22:24.000Z',
  fxSource: 'shared:fx-rates:v1',
  fxPair: 'CNY/USD',
  fxAsOf: '2026-08-18T12:28:48.000Z',
  historyKey: `market:physical-premium-history:v1:${metal}`,
  historyWindowPoints: 250,
  methodologyVersion: 'physical-divergence-v2',
});

const dataset = {
  'stocks-bootstrap': { quotes: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }] },
  'commodities-bootstrap': { quotes: [{ symbol: 'GC=F' }, { symbol: 'SI=F' }] },
  'physical-premium': {
    premiums: [
      {
        metal: 'gold', premiumPct: -1.05,
        physical: { asOf: '2026-08-18' }, paper: { asOf: '2026-08-18T12:22:24.000Z' },
      },
      {
        metal: 'silver', premiumPct: 12.81,
        physical: { asOf: '2026-08-18' }, paper: { asOf: '2026-08-18T12:22:24.000Z' },
      },
    ],
    fx: { pair: 'CNY/USD', rate: 0.1486, asOf: '2026-08-18T12:28:48.000Z' },
  },
  'physical-divergence': {
    methodologyVersion: 'physical-divergence-v2',
    evaluatedAt: '2026-08-18T12:30:00.000Z',
    readings: [
      {
        metal: 'gold', state: 'ok', reason: '', regime: 'elevated', index: 62.5,
        premiumPct: 1.5, premiumUsdPerOz: 45, percentile: 88, robustZ: 1.2,
        delta5d: 0.5, delta20d: 1.4, trend5d: 'widening', trend20d: 'widening',
        historyPoints: 60, historyWindowStart: '2026-06-20', historyWindowEnd: '2026-08-18',
        physicalAsOf: '2026-08-18', paperAsOf: '2026-08-18T12:22:24.000Z',
        methodologyVersion: 'physical-divergence-v2', provenance: provenance('gold'),
      },
      {
        metal: 'silver', state: 'insufficient_history', reason: 'history_points_below_60',
        regime: null, index: null, premiumPct: 5, premiumUsdPerOz: 3,
        percentile: null, robustZ: null, delta5d: null, delta20d: null, trend5d: null, trend20d: null,
        historyPoints: 59, historyWindowStart: '', historyWindowEnd: '',
        physicalAsOf: '2026-08-18', paperAsOf: '2026-08-18T12:22:24.000Z',
        methodologyVersion: 'physical-divergence-v2', provenance: provenance('silver'),
      },
    ],
    composite: {
      state: 'insufficient_history', reason: 'member_not_ok:silver:insufficient_history', index: null,
      weights: [
        { metal: 'gold', weight: 0.7, methodologyVersion: 'physical-divergence-v2' },
        { metal: 'silver', weight: 0.3, methodologyVersion: 'physical-divergence-v2' },
      ],
      methodologyVersion: 'physical-divergence-v2',
    },
    transitions: [{
      id: `physical-premium:gold:normal-elevated:${Date.parse('2026-08-18T12:29:00.000Z')}`,
      metal: 'gold',
      fromRegime: 'normal',
      toRegime: 'elevated',
      detectedAt: Date.parse('2026-08-18T12:29:00.000Z'),
      methodologyVersion: 'physical-divergence-v2',
    }],
  },
  crypto: { quotes: [{ symbol: 'BTC' }] },
};

async function executeWithStoredData(
  params: Record<string, unknown>,
  divergence = dataset['physical-divergence'],
  premiums: unknown = dataset['physical-premium'],
) {
  const stored: Record<string, unknown> = {
    'market:stocks-bootstrap:v1': dataset['stocks-bootstrap'],
    'market:commodities-bootstrap:v1': dataset['commodities-bootstrap'],
    'market:physical-premium:v1': premiums,
    'market:physical-divergence:v1': divergence,
  };
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    const value = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null;
    return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), { status: 200 });
  };
  try {
    return await executeTool(tool, params, Date.parse('2026-08-18T13:00:00.000Z'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

function matchingPremiumCohort(divergence: typeof dataset['physical-divergence']) {
  const premiums = structuredClone(dataset['physical-premium']);
  premiums.premiums = premiums.premiums.map((premium) => {
    const reading = divergence.readings.find((candidate) => candidate.metal === premium.metal);
    assert.ok(reading);
    return {
      ...premium,
      physical: { asOf: reading.physicalAsOf },
      paper: { asOf: reading.paperAsOf },
    };
  });
  premiums.fx.asOf = divergence.readings[0]!.provenance.fxAsOf;
  return premiums;
}

beforeEach(() => mock.method(Date, 'now', () => Date.parse('2026-08-18T12:30:00.000Z')));
afterEach(() => mock.restoreAll());

describe('get_market_data physical premium coverage', () => {
  it('names physical divergence in the discoverable tool-list sentence', () => {
    assert.match(tool.description.split('.')[0], /physical-divergence/);
  });

  it('declares the cache, RPC, and output schema without staling the aggregate tool before activation', () => {
    assert.ok(tool._cacheKeys.includes('market:physical-premium:v1'));
    assert.ok(tool._apiPaths.includes('GET /api/market/v1/get-physical-premiums'));
    assert.ok(tool._cacheKeys.includes('market:physical-divergence:v1'));
    assert.ok(tool._apiPaths.includes('GET /api/market/v1/get-physical-divergence-index'));
    assert.ok(!tool._freshnessChecks.some((check) => check.key === 'seed-meta:market:physical-premium'));
    const schema = JSON.stringify(tool.outputSchema);
    assert.match(schema, /physical-divergence/);
    for (const field of ['premiumUsdPerOz', 'historyWindowStart', 'historyWindowEnd']) {
      assert.match(schema, new RegExp(`"${field}"`));
    }
  });

  it('keeps both commodity quote and physical-premium datasets for asset_class=commodity', () => {
    const filtered = tool._postFilter(structuredClone(dataset), { asset_class: ['commodity'], limit: 0 });
    assert.deepEqual(Object.keys(filtered).sort(), ['commodities-bootstrap', 'physical-divergence', 'physical-premium']);
  });

  it('filters premiums by metal names, symbols, and XAU/XAG aliases', () => {
    const gold = tool._postFilter(structuredClone(dataset), { symbols: ['GC=F'], limit: 0 });
    assert.deepEqual(
      (gold['physical-premium'] as { premiums: Array<{ metal: string }> }).premiums.map((premium) => premium.metal),
      ['gold'],
    );
    assert.deepEqual(
      (gold['physical-divergence'] as { readings: Array<{ metal: string }> }).readings.map((reading) => reading.metal),
      ['gold'],
    );
    assert.equal((gold['physical-divergence'] as { composite?: unknown }).composite, undefined);

    const silver = tool._postFilter(structuredClone(dataset), { symbols: ['xag'], limit: 0 });
    assert.deepEqual(
      (silver['physical-premium'] as { premiums: Array<{ metal: string }> }).premiums.map((premium) => premium.metal),
      ['silver'],
    );
    assert.equal((silver['physical-divergence'] as { composite?: unknown }).composite, undefined);

    const both = tool._postFilter(structuredClone(dataset), { symbols: ['xau', 'xag'], limit: 0 });
    assert.ok((both['physical-divergence'] as { composite?: unknown }).composite);

    const unrelated = tool._postFilter(structuredClone(dataset), { symbols: ['AAPL'], limit: 0 });
    assert.equal((unrelated['physical-divergence'] as { composite?: unknown }).composite, undefined);
  });

  // #6448: "an unknown/unhandled state must surface as an error, never silently map to
  // 'normal'". Containing this one is not equivalent to dropping a corrupt blob — an
  // unrecognised state means the producer knows something this build does not, and quietly
  // omitting the dataset presents an incomplete answer as a complete one. Contrast the
  // methodology case below, which IS contained: that is ordinary deploy skew and self-heals.
  it('surfaces an unknown divergence state rather than silently omitting the dataset', () => {
    const corrupted = structuredClone(dataset);
    corrupted['physical-divergence'].readings[0].state = 'future_state';

    assert.throws(
      () => tool._postFilter?.(corrupted, { asset_class: ['equity'], limit: 0 }),
      /Unknown physical divergence state/,
    );
  });

  it('surfaces an unknown divergence state through the real MCP execution path', async () => {
    const corrupted = structuredClone(dataset['physical-divergence']);
    corrupted.readings[0].state = 'future_state';

    // Must not fall through to the unfiltered payload either: that would serve the raw
    // unvalidated blob the filter just refused.
    await assert.rejects(
      () => executeWithStoredData({ symbols: ['AAPL'], limit: 0 }, corrupted),
      /Unknown physical divergence state/,
    );
  });

  it('contains a malformed non-state divergence snapshot through the real MCP path', async () => {
    const corrupted = structuredClone(dataset['physical-divergence']);
    corrupted.readings[0].methodologyVersion = 'future-method';
    const result = await executeWithStoredData({ symbols: ['AAPL'], limit: 0 }, corrupted);

    assert.equal(result.data['physical-divergence'], undefined);
    assert.deepEqual(
      (result.data['stocks-bootstrap'] as { quotes: Array<{ symbol: string }> }).quotes,
      [{ symbol: 'AAPL' }],
    );
  });

  it('contains divergence when only the premium FX cohort clock differs', () => {
    const mismatched = structuredClone(dataset);
    mismatched['physical-premium'].fx.asOf = '2026-08-18T12:28:49.000Z';

    const filtered = tool._postFilter?.(mismatched, { limit: 0 });

    assert.equal(filtered?.['physical-divergence'], undefined);
    assert.ok(filtered?.['physical-premium']);
  });

  it('contains divergence when the premium cohort is unavailable', async () => {
    const result = await executeWithStoredData({ symbols: ['AAPL'], limit: 0 }, dataset['physical-divergence'], null);

    assert.equal(result.data['physical-divergence'], undefined);
    assert.deepEqual(
      (result.data['stocks-bootstrap'] as { quotes: Array<{ symbol: string }> }).quotes,
      [{ symbol: 'AAPL' }],
    );
  });

  it('returns divergence states through the real cache-tool execution path', async () => {
    const result = await executeWithStoredData({ symbols: ['XAU'], limit: 0 });
    const divergence = result.data['physical-divergence'] as typeof dataset['physical-divergence'];
    assert.equal(divergence.methodologyVersion, 'physical-divergence-v2');
    assert.deepEqual(divergence.readings.map((reading) => reading.metal), ['gold']);
    assert.equal(divergence.readings[0]?.state, 'ok');
    assert.deepEqual(divergence.readings[0]?.provenance, provenance('gold'));
    assert.equal(divergence.readings[0]?.historyKey, provenance('gold').historyKey);
    assert.equal(divergence.composite, undefined);
    assert.equal('transitions' in divergence, false);
  });

  it('returns missing_input through the real cache-tool execution path without a premium cohort', async () => {
    const missing = buildProducerBackedPhysicalComparisonFixture('missing_input');
    assert.doesNotThrow(() => normalizePhysicalDivergenceSnapshot(
      missing.divergence,
      Date.parse('2026-08-18T13:00:00.000Z'),
    ));
    const directlyFiltered = tool._postFilter?.({
      'physical-premium': null,
      'physical-divergence': structuredClone(missing.divergence),
    }, { limit: 0 });
    assert.ok(directlyFiltered?.['physical-divergence']);
    const result = await executeWithStoredData({ limit: 0 }, missing.divergence, null);
    const divergence = result.data['physical-divergence'] as typeof missing.divergence;

    assert.deepEqual(divergence.readings.map((reading) => reading.state), ['missing_input', 'missing_input']);
    assert.ok(divergence.readings.every((reading) => reading.index === null));
    assert.ok(divergence.readings.every((reading) => reading.historyKey === reading.provenance.historyKey));
    assert.equal(divergence.composite.state, 'missing_input');
    assert.equal(divergence.composite.index, null);
  });

  it('degrades aged stored ok readings through the real MCP execution path', async () => {
    const aged = structuredClone(dataset['physical-divergence']);
    aged.readings = aged.readings.map((reading, index) => ({
      ...reading,
      state: 'ok',
      reason: '',
      regime: index === 0 ? 'elevated' : 'normal',
      index: index === 0 ? 62.5 : 20,
      percentile: index === 0 ? 88 : 40,
      robustZ: index === 0 ? 1.2 : 0.2,
      delta5d: index === 0 ? 0.5 : 0,
      delta20d: index === 0 ? 1.4 : 0,
      trend5d: index === 0 ? 'widening' : 'stable',
      trend20d: index === 0 ? 'widening' : 'stable',
      historyPoints: 60,
      historyWindowStart: '1999-11-02',
      historyWindowEnd: '2000-01-01',
      physicalAsOf: '2000-01-01',
      provenance: { ...reading.provenance, physicalAsOf: '2000-01-01' },
    }));
    aged.composite = { ...aged.composite, state: 'ok', reason: '', index: 49.75 };

    const result = await executeWithStoredData({ limit: 0 }, aged, matchingPremiumCohort(aged));
    const divergence = result.data['physical-divergence'] as typeof aged;
    assert.ok(divergence.readings.every((reading) => reading.state === 'stale_input'));
    assert.ok(divergence.readings.every((reading) => reading.index === null));
    assert.equal(divergence.composite.state, 'stale_input');
    assert.equal(divergence.composite.index, null);
    assert.equal(divergence.composite.reason, 'member_not_ok:gold:stale_input');
  });

  it('gives request-time staleness precedence over stored insufficient history', async () => {
    const aged = structuredClone(dataset['physical-divergence']);
    aged.readings = aged.readings.map((reading) => ({
      ...reading,
      state: 'insufficient_history',
      reason: 'history_points_below_60',
      regime: null,
      index: null,
      percentile: null,
      robustZ: null,
      delta5d: null,
      delta20d: null,
      trend5d: null,
      trend20d: null,
      physicalAsOf: '2000-01-01',
      provenance: { ...reading.provenance, physicalAsOf: '2000-01-01' },
    }));
    aged.composite = {
      ...aged.composite,
      state: 'insufficient_history',
      reason: 'member_not_ok:gold:insufficient_history',
      index: null,
    };

    const result = await executeWithStoredData({ limit: 0 }, aged, matchingPremiumCohort(aged));
    const divergence = result.data['physical-divergence'] as typeof aged;
    assert.deepEqual(divergence.readings.map((reading) => reading.state), ['stale_input', 'stale_input']);
    assert.ok(divergence.readings.every((reading) => reading.index === null));
    assert.equal(divergence.composite.state, 'stale_input');
    assert.equal(divergence.composite.reason, 'member_not_ok:gold:stale_input');
    assert.equal(divergence.composite.index, null);
  });
});
