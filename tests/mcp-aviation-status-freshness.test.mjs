// get_aviation_status reads the page-load aggregate aviation:delays-bootstrap:v2.
// Its freshness must come from the same seed-meta /api/health uses for that
// aggregate (flightDelays), not seed-meta:aviation:faa, which counts the FAA
// side-car alone and stays fresh while the aggregate goes stale (#6987).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { __testing__ as health } from '../api/health.js';

test('get_aviation_status freshness follows the aggregate it reads', () => {
  const tool = CACHE_TOOLS.find((t) => t.name === 'get_aviation_status');
  assert.ok(tool, 'get_aviation_status must be registered');
  assert.deepEqual(tool._cacheKeys, [health.BOOTSTRAP_KEYS.flightDelays]);
  assert.deepEqual(tool._freshnessChecks, [
    { key: health.SEED_META.flightDelays.key, maxStaleMin: health.SEED_META.flightDelays.maxStaleMin },
  ]);
  assert.equal(tool._freshnessChecks[0].key, 'seed-meta:aviation:delays-bootstrap');
});

// The seeder writes enum severities (scripts/seed-aviation.mjs SEVERITY_MAP),
// so a bare 'normal' comparison kept every row and disrupted_only filtered nothing.
test('get_aviation_status disrupted_only drops seeded FLIGHT_DELAY_SEVERITY_NORMAL rows', () => {
  const tool = CACHE_TOOLS.find((t) => t.name === 'get_aviation_status');
  const data = {
    'delays-bootstrap': {
      alerts: [
        { iata: 'JFK', severity: 'FLIGHT_DELAY_SEVERITY_NORMAL' },
        { iata: 'LHR', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR' },
        { iata: 'CDG', severity: 'normal' },
      ],
    },
  };
  const out = tool._postFilter(data, { disrupted_only: true });
  assert.deepEqual(out['delays-bootstrap'].alerts.map((a) => a.iata), ['LHR']);
});
