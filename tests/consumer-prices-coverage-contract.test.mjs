import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageForSeedMeta, emptyCoverage } from '../scripts/seed-consumer-prices.mjs';

const migration = readFileSync(
  new URL('../consumer-prices-core/migrations/010_scrape_run_coverage.sql', import.meta.url),
  'utf8',
);

test('scrape coverage migration persists a nonnegative rejection counter', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS rejected_count INT NOT NULL DEFAULT 0/);
  assert.match(migration, /CHECK \(rejected_count >= 0\)/);
});

test('manual fallback preserves partial coverage and per-retailer diagnostics in seed meta', () => {
  const coverage = {
    ...emptyCoverage('ke'),
    status: 'partial',
    completedPages: 6,
    failedPages: 6,
    completionRatio: 0.5,
    rejectedCount: 3,
    retailers: [{ slug: 'retailer-a', coverageStatus: 'partial', rejectedCount: 3 }],
  };

  assert.deepEqual(coverageForSeedMeta(coverage), {
    status: 'partial',
    completedPages: 6,
    failedPages: 6,
    completionRatio: 0.5,
    rejectedCount: 3,
    retailers: coverage.retailers,
  });
  assert.equal(coverageForSeedMeta({ upstreamUnavailable: true }), undefined);
  assert.equal(coverageForSeedMeta(emptyCoverage('ke')).status, 'unknown');
});
