import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasPoolCoverageShortfall,
  parsePoolCounts,
  PREDICTION_MARKET_MIN_POOL_COUNTS,
} from '../api/_pool-coverage.js';

const FLOORS = PREDICTION_MARKET_MIN_POOL_COUNTS;

test('parsePoolCounts accepts a complete non-negative integer map', () => {
  assert.deepEqual(
    parsePoolCounts({ geopolitical: 18, tech: 12, finance: 8, extra: 99 }, FLOORS),
    { geopolitical: 18, tech: 12, finance: 8 },
  );
});

test('parsePoolCounts fails closed on missing, malformed, or negative values', () => {
  assert.equal(parsePoolCounts(null, FLOORS), null);
  assert.equal(parsePoolCounts(undefined, FLOORS), null);
  assert.equal(parsePoolCounts([], FLOORS), null);
  assert.equal(parsePoolCounts('nope', FLOORS), null);
  assert.equal(parsePoolCounts({ geopolitical: 1, tech: 1 }, FLOORS), null);
  assert.equal(parsePoolCounts({ geopolitical: 1, tech: '1', finance: 1 }, FLOORS), null);
  assert.equal(parsePoolCounts({ geopolitical: 1.5, tech: 1, finance: 1 }, FLOORS), null);
  assert.equal(parsePoolCounts({ geopolitical: -1, tech: 1, finance: 1 }, FLOORS), null);
  assert.equal(parsePoolCounts({ geopolitical: 1, tech: 1, finance: Number.MAX_SAFE_INTEGER + 1 }, FLOORS), null);
});

test('parsePoolCounts is a no-op when no floors are configured', () => {
  assert.equal(parsePoolCounts({ geopolitical: 1 }, null), null);
  assert.equal(parsePoolCounts({ geopolitical: 1 }, undefined), null);
});

test('hasPoolCoverageShortfall fails closed on missing counts and respects floors', () => {
  assert.equal(hasPoolCoverageShortfall(null, FLOORS), true);
  assert.equal(hasPoolCoverageShortfall(undefined, FLOORS), true);
  assert.equal(hasPoolCoverageShortfall({ geopolitical: 1, tech: 1 }, FLOORS), true);
  assert.equal(hasPoolCoverageShortfall({ geopolitical: 1, tech: '1', finance: 1 }, FLOORS), true);
  assert.equal(hasPoolCoverageShortfall({ geopolitical: 0, tech: 1, finance: 1 }, FLOORS), true);
  assert.equal(hasPoolCoverageShortfall({ geopolitical: 1, tech: 1, finance: 1 }, FLOORS), false);
  assert.equal(hasPoolCoverageShortfall({ geopolitical: 1, tech: 1, finance: 36 }, FLOORS), false);
  assert.equal(hasPoolCoverageShortfall(null, null), false);
});
