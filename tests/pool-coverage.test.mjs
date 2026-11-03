import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasPoolCoverageShortfall,
  parsePoolCounts,
  poolCoverageMargins,
  PREDICTION_MARKET_MIN_POOL_COUNTS,
} from '../api/_pool-coverage.js';

const FLOORS = PREDICTION_MARKET_MIN_POOL_COUNTS;

// Margin reporting answers a question the shortfall check structurally cannot:
// health's minimums are byte-identical to the producer's publication floors, so
// a producer that refuses to publish below its floor means health only ever
// sees a passing cohort or a stale one. "How close is this to blocking?" has to
// be read from a passing cohort or it is never read at all.
test('poolCoverageMargins reports distance to each floor and flags the thin ones', () => {
  assert.deepEqual(
    poolCoverageMargins({ geopolitical: 1, tech: 5, finance: 11 }, FLOORS, 10),
    {
      geopolitical: { count: 1, floor: 1, margin: 0, low: true },
      tech: { count: 5, floor: 1, margin: 4, low: true },
      finance: { count: 11, floor: 1, margin: 10, low: false },
    },
  );
});

test('poolCoverageMargins treats a breached floor as low rather than hiding it', () => {
  const margins = poolCoverageMargins({ geopolitical: 0, tech: 1, finance: 1 }, FLOORS, 10);
  assert.deepEqual(margins.geopolitical, { count: 0, floor: 1, margin: -1, low: true });
});

test('poolCoverageMargins fails closed on unusable input', () => {
  assert.equal(poolCoverageMargins(null, FLOORS, 10), null);
  assert.equal(poolCoverageMargins({ geopolitical: 1, tech: 1, finance: 1 }, null, 10), null);
  // A missing or malformed count cannot yield an honest margin.
  assert.equal(poolCoverageMargins({ geopolitical: 1, tech: 1 }, FLOORS, 10), null);
  assert.equal(poolCoverageMargins({ geopolitical: 1, tech: 1, finance: '1' }, FLOORS, 10), null);
  // A margin threshold is required and must be a non-negative integer.
  assert.equal(poolCoverageMargins({ geopolitical: 1, tech: 1, finance: 1 }, FLOORS, null), null);
  assert.equal(poolCoverageMargins({ geopolitical: 1, tech: 1, finance: 1 }, FLOORS, -1), null);
});

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
