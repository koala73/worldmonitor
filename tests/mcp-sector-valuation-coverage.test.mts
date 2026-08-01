import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySectorValuationFreshness,
  CACHE_TOOLS,
} from '../api/mcp/registry/cache-tools';

describe('get_market_data sector valuation coverage contract', () => {
  it('declares the valuation coverage agents receive from market:sectors:v2', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool);
    assert.match(tool.description, /valuation coverage/i);

    const sectors = tool.outputSchema?.properties?.data?.properties?.sectors;
    const coverage = sectors?.properties?.valuationCoverage;
    assert.ok(coverage, 'valuationCoverage must be discoverable in the MCP output schema');
    assert.deepEqual(
      Object.keys(coverage.properties || {}).sort(),
      [
        'expectedValuationCount',
        'fetchedAt',
        'source',
        'sourceStatus',
        'stale',
        'valuationCount',
      ],
    );
    assert.deepEqual(coverage.properties?.sourceStatus?.enum, ['ok', 'partial', 'degraded']);
  });

  it('checks the sector seed metadata as part of aggregate market freshness', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool);
    const sectorCheck = tool._freshnessChecks?.find(
      (check) => check.key === 'seed-meta:market:sectors',
    );
    assert.deepEqual(sectorCheck, {
      key: 'seed-meta:market:sectors',
      maxStaleMin: 30,
    });
  });

  it('marks valuation coverage stale once the published snapshot ages past the sector budget', () => {
    const now = 1_700_000_000_000;
    const data = {
      sectors: {
        valuationCoverage: {
          valuationCount: 12,
          expectedValuationCount: 12,
          sourceStatus: 'ok',
          source: 'yahoo_quote_summary_authenticated_direct',
          fetchedAt: now - 31 * 60_000,
          stale: false,
        },
      },
    };

    applySectorValuationFreshness(data, now);
    assert.equal(data.sectors.valuationCoverage.stale, true);

    applySectorValuationFreshness(data, now - 31 * 60_000);
    assert.equal(data.sectors.valuationCoverage.stale, false);
  });
});
