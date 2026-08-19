import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
assert.ok(tool && tool._postFilter);

const dataset = {
  'stocks-bootstrap': { quotes: [{ symbol: 'AAPL' }] },
  'commodities-bootstrap': { quotes: [{ symbol: 'GC=F' }, { symbol: 'SI=F' }] },
  'physical-premium': {
    premiums: [
      { metal: 'gold', premiumPct: -1.05 },
      { metal: 'silver', premiumPct: 12.81 },
    ],
    fx: { pair: 'CNY/USD', rate: 0.1486 },
  },
  crypto: { quotes: [{ symbol: 'BTC' }] },
};

describe('get_market_data physical premium coverage', () => {
  it('declares the cache, RPC, and output schema without staling the aggregate tool before activation', () => {
    assert.ok(tool._cacheKeys.includes('market:physical-premium:v1'));
    assert.ok(tool._apiPaths.includes('GET /api/market/v1/get-physical-premiums'));
    assert.ok(!tool._freshnessChecks.some((check) => check.key === 'seed-meta:market:physical-premium'));
    assert.match(JSON.stringify(tool.outputSchema), /physical-premium/);
  });

  it('keeps both commodity quote and physical-premium datasets for asset_class=commodity', () => {
    const filtered = tool._postFilter(structuredClone(dataset), { asset_class: ['commodity'], limit: 0 });
    assert.deepEqual(Object.keys(filtered).sort(), ['commodities-bootstrap', 'physical-premium']);
  });

  it('filters premiums by metal names, symbols, and XAU/XAG aliases', () => {
    const gold = tool._postFilter(structuredClone(dataset), { symbols: ['GC=F'], limit: 0 });
    assert.deepEqual(
      (gold['physical-premium'] as { premiums: Array<{ metal: string }> }).premiums.map((premium) => premium.metal),
      ['gold'],
    );

    const silver = tool._postFilter(structuredClone(dataset), { symbols: ['xag'], limit: 0 });
    assert.deepEqual(
      (silver['physical-premium'] as { premiums: Array<{ metal: string }> }).premiums.map((premium) => premium.metal),
      ['silver'],
    );
  });
});
