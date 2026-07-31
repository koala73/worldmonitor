import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools';

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
});
