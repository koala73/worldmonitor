import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageForSeedMeta, emptyCoverage } from '../scripts/seed-consumer-prices.mjs';
// Runs under `tsx --test tests/*.test.mjs`, so the core TypeScript module is
// importable directly and the vocabulary can be compared value-to-value rather
// than scraped out of the source with a regex that could false-pass on a typo.
import { COVERAGE_FAILURE_REASONS as CORE_FAILURE_REASONS } from '../consumer-prices-core/src/jobs/scrape-coverage.ts';
import { COVERAGE_FAILURE_REASONS as HEALTH_FAILURE_REASONS } from '../api/health.js';

const migration = readFileSync(
  new URL('../consumer-prices-core/migrations/010_scrape_run_coverage.sql', import.meta.url),
  'utf8',
);

const failureReasonsMigration = readFileSync(
  new URL('../consumer-prices-core/migrations/011_scrape_run_failure_reasons.sql', import.meta.url),
  'utf8',
);

test('scrape coverage migration persists a nonnegative rejection counter', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS rejected_count INT NOT NULL DEFAULT 0/);
  assert.match(migration, /CHECK \(rejected_count >= 0\)/);
});

test('failure-reason migration defaults to an empty object and rejects non-object shapes', () => {
  assert.match(
    failureReasonsMigration,
    /ADD COLUMN IF NOT EXISTS failure_reasons JSONB NOT NULL DEFAULT '\{\}'::jsonb/,
  );
  // Without the type guard a stray array or scalar reaches health as an
  // unreadable diagnostic instead of failing at write time.
  assert.match(failureReasonsMigration, /CHECK \(jsonb_typeof\(failure_reasons\) = 'object'\)/);
});

// The vocabulary is duplicated because api/health.js is an Edge module that
// cannot import the core package's TypeScript. Health DROPS anything outside
// its own list, so a code added only to the producer would be silently deleted
// on the way to operators — a diagnostic that vanishes exactly when a new
// failure mode appears. Order matters too: both sides are the same contract.
test('the failure-reason vocabulary is identical in the producer and in health', () => {
  assert.ok(CORE_FAILURE_REASONS.length > 0, 'the producer vocabulary must not be empty');
  assert.deepEqual(
    [...HEALTH_FAILURE_REASONS],
    [...CORE_FAILURE_REASONS],
    'Add the new code to BOTH consumer-prices-core/src/jobs/scrape-coverage.ts '
    + '(COVERAGE_FAILURE_REASONS) and api/health.js (COVERAGE_FAILURE_REASONS), '
    + 'or health will drop it.',
  );
});

test('manual fallback preserves partial coverage and per-retailer diagnostics in seed meta', () => {
  const coverage = {
    ...emptyCoverage('ke'),
    status: 'partial',
    completedPages: 6,
    failedPages: 6,
    completionRatio: 0.5,
    rejectedCount: 3,
    failureReasons: { 'missing-price': 4, 'provider-error': 2 },
    retailers: [{ slug: 'retailer-a', coverageStatus: 'partial', rejectedCount: 3 }],
  };

  assert.deepEqual(coverageForSeedMeta(coverage), {
    status: 'partial',
    completedPages: 6,
    failedPages: 6,
    completionRatio: 0.5,
    rejectedCount: 3,
    failureReasons: { 'missing-price': 4, 'provider-error': 2 },
    retailers: coverage.retailers,
  });
  assert.equal(coverageForSeedMeta({ upstreamUnavailable: true }), undefined);
  assert.equal(coverageForSeedMeta(emptyCoverage('ke')).status, 'unknown');
});
