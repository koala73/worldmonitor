/**
 * Tests for Sprint 2 supply-chain additions:
 *
 * - bypass-corridors.ts: data integrity + BYPASS_CORRIDORS_BY_CHOKEPOINT index
 * - _insurance-tier.ts: threatLevelToInsurancePremiumBps pure function
 * - get-bypass-options handler: unauthenticated returns empty
 * - get-country-cost-shock handler: unauthenticated returns zeros
 * - gateway.ts: new slow-browser entries for both RPCs
 * - premium-paths.ts: both paths registered as PRO-gated
 * - proto: new messages in generated types
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

// ========================================================================
// 1. _insurance-tier.ts pure function
// ========================================================================

import { threatLevelToInsurancePremiumBps } from '../server/worldmonitor/supply-chain/v1/_insurance-tier.ts';

describe('threatLevelToInsurancePremiumBps', () => {
  it('war_zone returns 300 bps', () => {
    assert.equal(threatLevelToInsurancePremiumBps('war_zone'), 300);
  });

  it('critical returns 100 bps', () => {
    assert.equal(threatLevelToInsurancePremiumBps('critical'), 100);
  });

  it('high returns 50 bps', () => {
    assert.equal(threatLevelToInsurancePremiumBps('high'), 50);
  });

  it('elevated returns 20 bps', () => {
    assert.equal(threatLevelToInsurancePremiumBps('elevated'), 20);
  });

  it('normal returns 5 bps', () => {
    assert.equal(threatLevelToInsurancePremiumBps('normal'), 5);
  });

  it('premiums increase monotonically with threat severity', () => {
    const levels = ['normal', 'elevated', 'high', 'critical', 'war_zone'];
    const premiums = levels.map(threatLevelToInsurancePremiumBps);
    for (let i = 1; i < premiums.length; i++) {
      assert.ok(
        premiums[i] > premiums[i - 1],
        `Premium for ${levels[i]} (${premiums[i]}) should be > ${levels[i - 1]} (${premiums[i - 1]})`,
      );
    }
  });
});

// ========================================================================
// 2. bypass-corridors.ts data integrity
// ========================================================================

import {
  BYPASS_CORRIDORS,
  BYPASS_CORRIDORS_BY_CHOKEPOINT,
} from '../src/config/bypass-corridors.ts';

describe('BYPASS_CORRIDORS data integrity', () => {
  it('has at least 20 corridor entries', () => {
    assert.ok(BYPASS_CORRIDORS.length >= 20, `Expected ≥20 corridors, got ${BYPASS_CORRIDORS.length}`);
  });

  it('every entry has required fields', () => {
    for (const c of BYPASS_CORRIDORS) {
      assert.ok(c.id, `missing id`);
      assert.ok(c.name, `missing name for ${c.id}`);
      assert.ok(c.primaryChokepointId, `missing primaryChokepointId for ${c.id}`);
      assert.ok(['alternative_sea_route', 'land_bridge', 'modal_shift', 'pipeline'].includes(c.type),
        `${c.id}: invalid type "${c.type}"`);
      assert.ok(typeof c.addedTransitDays === 'number', `${c.id}: addedTransitDays must be number`);
      assert.ok(typeof c.addedCostMultiplier === 'number', `${c.id}: addedCostMultiplier must be number`);
      assert.ok(Array.isArray(c.suitableCargoTypes), `${c.id}: suitableCargoTypes must be array`);
      assert.ok(['partial_closure', 'full_closure'].includes(c.activationThreshold),
        `${c.id}: invalid activationThreshold "${c.activationThreshold}"`);
      assert.ok(typeof c.notes === 'string', `${c.id}: notes must be string`);
      assert.ok(Array.isArray(c.waypointChokepointIds), `${c.id}: waypointChokepointIds must be array`);
    }
  });

  it('all IDs are unique', () => {
    const ids = BYPASS_CORRIDORS.map(c => c.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'Duplicate corridor IDs found');
  });

  it('capacityConstraintTonnage is null or a positive number', () => {
    for (const c of BYPASS_CORRIDORS) {
      if (c.capacityConstraintTonnage !== null) {
        assert.ok(c.capacityConstraintTonnage >= 0, `${c.id}: capacityConstraintTonnage must be >= 0`);
      }
    }
  });

  it('addedCostMultiplier >= 0.9 and <= 2.0 (sanity range)', () => {
    for (const c of BYPASS_CORRIDORS) {
      assert.ok(c.addedCostMultiplier >= 0.9 && c.addedCostMultiplier <= 2.0,
        `${c.id}: addedCostMultiplier ${c.addedCostMultiplier} out of expected range`);
    }
  });

  it('covers all 13 canonical chokepoints', () => {
    const canonicalIds = [
      'suez', 'malacca_strait', 'hormuz_strait', 'bab_el_mandeb', 'panama',
      'taiwan_strait', 'cape_of_good_hope', 'gibraltar', 'bosphorus',
      'korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait',
    ];
    const covered = new Set(BYPASS_CORRIDORS.map(c => c.primaryChokepointId));
    for (const id of canonicalIds) {
      assert.ok(covered.has(id), `No bypass entry for chokepoint: ${id}`);
    }
  });
});

describe('BYPASS_CORRIDORS_BY_CHOKEPOINT index', () => {
  it('is a Record keyed by primaryChokepointId', () => {
    assert.ok(typeof BYPASS_CORRIDORS_BY_CHOKEPOINT === 'object');
  });

  it('suez has at least 2 bypass options', () => {
    assert.ok(
      (BYPASS_CORRIDORS_BY_CHOKEPOINT['suez'] ?? []).length >= 2,
      'suez should have at least 2 bypass options',
    );
  });

  it('hormuz_strait has at least 3 bypass options', () => {
    assert.ok(
      (BYPASS_CORRIDORS_BY_CHOKEPOINT['hormuz_strait'] ?? []).length >= 3,
      'hormuz_strait should have at least 3 bypass options',
    );
  });

  it('every corridor in the index matches its primary chokepoint', () => {
    for (const [cpId, corridors] of Object.entries(BYPASS_CORRIDORS_BY_CHOKEPOINT)) {
      for (const c of corridors) {
        assert.equal(c.primaryChokepointId, cpId,
          `Corridor ${c.id} in index[${cpId}] has wrong primaryChokepointId: ${c.primaryChokepointId}`);
      }
    }
  });

  it('total entries in index equals BYPASS_CORRIDORS length', () => {
    const total = Object.values(BYPASS_CORRIDORS_BY_CHOKEPOINT).reduce((sum, arr) => sum + arr.length, 0);
    assert.equal(total, BYPASS_CORRIDORS.length, 'Index total does not match BYPASS_CORRIDORS length');
  });
});

// ========================================================================
// Premium enforcement. Membership in PREMIUM_RPC_PATHS is what gates these
// endpoints, so assert against the real Set rather than grepping the module
// for a path string — a path moved into a comment satisfies the grep.
//
// The handler/proto/generated-type/client assertions that used to follow all
// restated lines of source. Generated clients make an unregistered RPC a
// typecheck failure, and the dashboard exercises these paths in
// e2e/variant-live-smoke.spec.ts.
// ========================================================================

describe('Sprint 2 RPCs are premium-gated', () => {
  for (const path of [
    '/api/supply-chain/v1/get-bypass-options',
    '/api/supply-chain/v1/get-country-cost-shock',
    '/api/supply-chain/v1/get-sector-dependency',
  ]) {
    it(`${path} is in PREMIUM_RPC_PATHS`, () => {
      assert.ok(PREMIUM_RPC_PATHS.has(path), `${path} is not premium-gated`);
    });
  }
});
