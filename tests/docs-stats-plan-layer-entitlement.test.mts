/**
 * The free-tier map-layer entitlement gate (#5387).
 *
 * Public plan copy claimed the free tier included "all 56 map layers" while
 * `LAYER_REGISTRY.resilienceScore` was `premium: 'locked'` and denied to
 * non-premium users at three enforcement sites. The copy now quotes the
 * registry TOTAL and names the Pro-only layer instead of quoting a free count,
 * because a truthful free count is not derivable: `isSunsetLayer` drops
 * iranAttacks unless VITE_ENABLE_IRAN_ATTACKS=true, App.ts hides cyberThreats
 * unless VITE_ENABLE_CYBER_LAYER=true, and VARIANT_LAYER_ORDER means no single
 * site renders the whole registry.
 *
 * That phrasing is only true while resilienceScore is the ONLY web-locked
 * entry — and a count pin cannot notice a second lock, because the total does
 * not move when a layer flips to 'locked'. These tests drive both failure
 * branches with synthetic inputs so "the gate would have caught it" is
 * executed rather than asserted.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStats,
  validatePlanLayerEntitlementCopy,
  PLAN_LAYER_COPY_SURFACES,
  PLAN_LAYER_PRO_ONLY_KEY,
  DOC_VALIDATORS,
} from '../scripts/docs-stats.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const REAL_STATS = computeStats();
const ONLY_LOCKED = { lockedLayerKeys: [PLAN_LAYER_PRO_ONLY_KEY] };

describe('locked-layer set', () => {
  it('derives exactly one web-locked layer from the real registry', () => {
    // The desktop-only `_desktop ? 'locked' : undefined` ternaries on
    // iranAttacks/gpsJamming must NOT count — plan copy describes the web.
    assert.deepEqual(REAL_STATS.lockedLayerKeys, [PLAN_LAYER_PRO_ONLY_KEY]);
    assert.equal(REAL_STATS.lockedLayerDefinitions, 1);
  });

  it('publishes no free-layer count, which would not be derivable', () => {
    // Regression guard for the original fix attempt: `layerDefinitions -
    // lockedLayerDefinitions` overstates the free count (sunset + env-gated
    // layers are reachable by nobody), so the stat must not come back.
    assert.equal((REAL_STATS as Record<string, unknown>).freeLayerDefinitions, undefined);
  });

  it('fires when a SECOND layer becomes Pro-locked', () => {
    const failures = validatePlanLayerEntitlementCopy(
      { lockedLayerKeys: ['cables', PLAN_LAYER_PRO_ONLY_KEY] },
      read,
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /web-locks \[cables, resilienceScore\]/);
    // The operator needs to be told WHICH copy now over-promises.
    for (const surface of PLAN_LAYER_COPY_SURFACES) assert.ok(failures[0].includes(surface));
  });

  it('fires when the Pro-only layer is unlocked without updating the copy', () => {
    const failures = validatePlanLayerEntitlementCopy({ lockedLayerKeys: [] }, read);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /web-locks \[\]/);
  });
});

describe('copy surfaces', () => {
  it('passes on the real repo', () => {
    assert.deepEqual(validatePlanLayerEntitlementCopy(REAL_STATS, read), []);
  });

  it('fires once per surface that stops naming the Pro-only layer', () => {
    for (const dropped of PLAN_LAYER_COPY_SURFACES) {
      const failures = validatePlanLayerEntitlementCopy(ONLY_LOCKED, (p: string) =>
        p === dropped ? read(p).replaceAll('Resilience', 'Instability') : read(p),
      );
      assert.equal(failures.length, 1, `${dropped}: expected exactly one failure`);
      assert.match(failures[0], new RegExp(`^${dropped}: free-tier copy must name`));
    }
  });

  it('reports a missing surface rather than passing it over', () => {
    const failures = validatePlanLayerEntitlementCopy(ONLY_LOCKED, (p: string) => {
      if (p === 'docs/accounts.mdx') throw new Error('ENOENT');
      return read(p);
    });
    assert.deepEqual(failures, ['docs/accounts.mdx: file not found']);
  });
});

describe('--check wiring', () => {
  // A validator that is unit-tested but dropped from the CLI leaves the whole
  // suite green while the gate no longer runs. DOC_VALIDATORS is the wiring.
  it('runs the plan-layer entitlement gate as part of --check', () => {
    assert.ok(DOC_VALIDATORS.includes(validatePlanLayerEntitlementCopy));
  });

  it('exits 0 end to end on the real repo', () => {
    const result = spawnSync('node', ['scripts/docs-stats.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
});
