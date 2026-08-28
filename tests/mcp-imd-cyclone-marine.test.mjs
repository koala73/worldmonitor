import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { IMD_CANONICAL_KEY } from '../scripts/lib/imd-cyclone-marine.mjs';

const findTool = (name) => CACHE_TOOLS.find((tool) => tool.name === name);

function snapshot(overrides = {}) {
  return {
    coverageState: 'ok',
    skipReason: null,
    generatedAt: 1_700_000_000_000,
    products: {
      cycloneTrack: { status: 'ok', reason: null, recordCount: 1 },
      cycloneWind: { status: 'ok', reason: null, recordCount: 1 },
      cycloneCou: { status: 'ok', reason: null, recordCount: 1 },
      portWarning: { status: 'ok', reason: null, recordCount: 1 },
      seaBulletin: { status: 'ok', reason: null, recordCount: 1 },
      coastalBulletin: { status: 'ok', reason: null, recordCount: 1 },
      fishermenWarning: { status: 'disabled', reason: 'INDEXED_WITHOUT_FIELD_REFERENCE', recordCount: 0 },
    },
    failedProducts: [],
    cycloneEvents: [{ id: 'cyc-1', title: 'Cyclone Test', category: 'severeStorms' }],
    portAlerts: [{ id: 'port-1', event: 'IMD Port Warning' }],
    marineBulletins: [{ id: 'sea-1', event: 'IMD Sea Area Bulletin' }],
    cyclones: [{ id: 'pt-1', product: 'cycloneTrack' }],
    windRadii: [{ id: 'wind-1', product: 'cycloneWind' }],
    cones: [{ id: 'cone-1', product: 'cycloneCou' }],
    portWarnings: [{ id: 'pw-1', product: 'portWarning' }],
    seaBulletins: [{ id: 'sb-1', product: 'seaBulletin' }],
    coastalBulletins: [{ id: 'cb-1', product: 'coastalBulletin' }],
    sourceName: 'India Meteorological Department',
    sourceUrl: 'https://api.imd.gov.in/public/api_reference.html',
    attribution: 'Data source: India Meteorological Department.',
    ...overrides,
  };
}

async function runTool(stored, params = {}, now = Date.now()) {
  const tool = findTool('get_imd_cyclone_marine');
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    const value = Object.hasOwn(stored, key) ? stored[key] : null;
    return new Response(JSON.stringify({
      result: value == null ? null : JSON.stringify(value),
    }), { status: 200 });
  };
  try {
    return await executeTool(tool, params, now);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

describe('get_imd_cyclone_marine cache tool', () => {
  const tool = findTool('get_imd_cyclone_marine');

  it('covers the standalone IMD key for MCP-bootstrap parity', () => {
    assert.ok(tool, 'tool must exist in CACHE_TOOLS');
    assert.equal(IMD_CANONICAL_KEY, 'weather:imd-cyclone-marine:v1');
    assert.deepEqual(tool._cacheKeys, [IMD_CANONICAL_KEY]);
    assert.equal(tool._cacheLabels[IMD_CANONICAL_KEY], 'imd_cyclone_marine');
    assert.equal(tool._freshnessChecks[0].key, 'seed-meta:weather:imd-cyclone-marine');
    assert.equal(tool._freshnessChecks[0].maxStaleMin, 45);
    assert.deepEqual(tool._apiPaths, []);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(TOOL_REGISTRY.some((entry) => entry.name === 'get_imd_cyclone_marine'));
  });

  it('keeps coverageState when no filters are applied', () => {
    const data = { imd_cyclone_marine: snapshot() };
    const result = tool._postFilter(data, {});
    assert.equal(result.imd_cyclone_marine.coverageState, 'ok');
    assert.equal(result.imd_cyclone_marine.cycloneEvents.length, 1);
    assert.equal(result.imd_cyclone_marine.portAlerts.length, 1);
    assert.equal(result.imd_cyclone_marine.marineBulletins.length, 1);
  });

  it('caps product lists without dropping coverageState', () => {
    const data = {
      imd_cyclone_marine: snapshot({
        cycloneEvents: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}` })),
      }),
    };
    tool._postFilter(data, { limit: 2 });
    assert.equal(data.imd_cyclone_marine.cycloneEvents.length, 2);
    assert.equal(data.imd_cyclone_marine.coverageState, 'ok');
  });

  it('dataset cyclone keeps cyclone lists and coverage metadata', () => {
    const data = { imd_cyclone_marine: snapshot() };
    tool._postFilter(data, { dataset: ['cyclone'] });
    assert.equal(data.imd_cyclone_marine.coverageState, 'ok');
    assert.equal(data.imd_cyclone_marine.cycloneEvents.length, 1);
    assert.equal(data.imd_cyclone_marine.cyclones.length, 1);
    assert.equal(data.imd_cyclone_marine.portAlerts.length, 0);
    assert.equal(data.imd_cyclone_marine.marineBulletins.length, 0);
    assert.equal(data.imd_cyclone_marine.products.portWarning.status, 'ok');
  });

  it('disabled snapshots stay disabled, not all-clear', async () => {
    const now = Date.now();
    const disabled = snapshot({
      coverageState: 'disabled',
      skipReason: 'IMD_API_KEY_MISSING',
      cycloneEvents: [],
      portAlerts: [],
      marineBulletins: [],
      cyclones: [],
      windRadii: [],
      cones: [],
      portWarnings: [],
      seaBulletins: [],
      coastalBulletins: [],
    });
    const result = await runTool({
      'weather:imd-cyclone-marine:v1': disabled,
      'seed-meta:weather:imd-cyclone-marine': {
        fetchedAt: now - 5 * 60_000,
        recordCount: 0,
        coverageState: 'disabled',
        sourceState: 'unavailable',
      },
    }, {}, now);
    assert.equal(result.data.imd_cyclone_marine.coverageState, 'disabled');
    assert.equal(result.data.imd_cyclone_marine.skipReason, 'IMD_API_KEY_MISSING');
    assert.equal(result.data.imd_cyclone_marine.cycloneEvents.length, 0);
    assert.equal(result.stale, false);
  });

  it('marks a state-less cache snapshot unavailable, never all-clear', async () => {
    const result = await runTool({
      [IMD_CANONICAL_KEY]: {},
    });
    assert.equal(result.data.imd_cyclone_marine.coverageState, 'unavailable');
    assert.equal(result.data.imd_cyclone_marine.skipReason, 'IMD_CACHE_INVALID');
  });

  it('degraded snapshots keep failed product state', async () => {
    const now = Date.now();
    const degraded = snapshot({
      coverageState: 'degraded',
      skipReason: 'portWarning',
      failedProducts: ['portWarning'],
      products: {
        ...snapshot().products,
        portWarning: { status: 'failed', reason: 'FETCH_FAILED', recordCount: 0, carried: false },
      },
      portAlerts: [],
      portWarnings: [],
    });
    const result = await runTool({
      'weather:imd-cyclone-marine:v1': degraded,
      'seed-meta:weather:imd-cyclone-marine': {
        fetchedAt: now - 5 * 60_000,
        recordCount: 4,
        coverageState: 'degraded',
        sourceState: 'degraded',
      },
    }, {}, now);
    assert.equal(result.data.imd_cyclone_marine.coverageState, 'degraded');
    assert.deepEqual(result.data.imd_cyclone_marine.failedProducts, ['portWarning']);
    assert.equal(result.data.imd_cyclone_marine.products.portWarning.status, 'failed');
    assert.equal(result.data.imd_cyclone_marine.cycloneEvents.length, 1);
    assert.equal(result.stale, false);
  });
});
