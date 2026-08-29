import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isCalibratedAllocationRuntime } from '../../scripts/run-unit-tests.mjs';

/**
 * Allocation budgets cover two intentionally different call shapes:
 * - Prebuilt-option pure paths: <=16 B/call for each treatment helper.
 * - Production sprite tick: <=212 B/tick when its caller builds both fresh
 *   options literals. The latter preserves roughly 25% headroom over the
 *   locally measured steady-state median instead of pretending those caller
 *   allocations belong to the pure helper bound.
 */
test('converged focus treatment stays within the GC-bracketed allocation budget', (t) => {
  if (!isCalibratedAllocationRuntime()) {
    return t.skip(`allocation budgets are calibrated for Node 24; running ${process.versions.node}`);
  }
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', 'scripts/focus-allocation-check.mjs'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.ok(report.advanceSpriteFocus.roundedMedian <= 16, result.stdout);
  assert.ok(report.applyAircraftBillboardTreatment.roundedMedian <= 16, result.stdout);
  assert.ok(report.productionSpriteTick.roundedMedian <= 212, result.stdout);
});
