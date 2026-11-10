import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing__ } from '../api/health.js';

// seed-fuel-prices runs once a week (Railway cron `0 6 * * 2`) and its data
// lives for 10 days (CACHE_TTL in scripts/seed-fuel-prices.mjs). A budget of
// exactly 7 days expires the moment the next run starts, so every run longer
// than a minute opened a STALE_SEED incident (WORLDMONITOR-1DG: 10081 > 10080).
const WEEK_MIN = 7 * 24 * 60;
const CACHE_TTL_MIN = 864000 / 60;

test('the fuel-prices budget outlasts a weekly run and still trips before the data expires', () => {
  const { maxStaleMin } = __testing__.SEED_META.fuelPrices;
  assert.ok(maxStaleMin >= WEEK_MIN + 12 * 60, `budget ${maxStaleMin} leaves under 12h for a weekly run`);
  assert.ok(maxStaleMin < CACHE_TTL_MIN, `budget ${maxStaleMin} reaches the ${CACHE_TTL_MIN}min data TTL`);
});
