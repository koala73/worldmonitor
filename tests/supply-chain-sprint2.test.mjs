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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

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
// 3. get-bypass-options handler source code guards
// ========================================================================

describe('get-bypass-options handler source code', () => {
  const src = readSrc('server/worldmonitor/supply-chain/v1/get-bypass-options.ts');

  it('calls isCallerPremium and returns empty when not PRO', () => {
    assert.match(src, /isCallerPremium/);
    assert.match(src, /if \(!isPro\) return empty/);
  });

  it('filters by suitableCargoTypes.length === 0 (no-bypass placeholder guard)', () => {
    assert.match(src, /suitableCargoTypes\.length === 0/);
  });

  it('filters by activation threshold when closurePct < 100', () => {
    assert.match(src, /closurePct < 100.*full_closure/s);
  });

  it('reads chokepoint status cache via getCachedJson', () => {
    assert.match(src, /getCachedJson\('supply_chain:chokepoints:v4'\)/);
  });

  it('sorts options by liveScore ascending', () => {
    assert.match(src, /liveScore - b\.liveScore/);
  });

  it('uses BYPASS_CORRIDORS_BY_CHOKEPOINT lookup', () => {
    assert.match(src, /BYPASS_CORRIDORS_BY_CHOKEPOINT\[chokepointId\]/);
  });
});

// ========================================================================
// 4. get-country-cost-shock handler source code guards
// ========================================================================

describe('get-country-cost-shock handler source code', () => {
  const src = readSrc('server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts');

  it('calls isCallerPremium and returns empty when not PRO', () => {
    assert.match(src, /isCallerPremium/);
    assert.match(src, /if \(!isPro\) return empty/);
  });

  it('uses threatLevelToInsurancePremiumBps for premium calculation', () => {
    assert.match(src, /threatLevelToInsurancePremiumBps/);
  });

  it('reads chokepoint status cache via getCachedJson', () => {
    assert.match(src, /getCachedJson\('supply_chain:chokepoints:v4'\)/);
  });

  it('returns unavailableReason for non-energy sectors', () => {
    assert.match(src, /HS 27.*mineral fuels.*only/s);
  });

  it('validates iso2 with regex before proceeding', () => {
    assert.match(src, /\^[^\]]*A-Z.*\$.*test\(iso2/s);
  });

  it('uses shockModelSupported from registry for hasEnergyModel', () => {
    assert.match(src, /shockModelSupported/);
    assert.match(src, /hasEnergyModel/);
  });

  it('averages deficitPct across all products (no crude product entry)', () => {
    assert.match(src, /productDeficits/);
    assert.doesNotMatch(src, /product.*===.*'crude'/);
  });
});

// ========================================================================
// 5. Gateway: both RPCs registered as slow-browser
// ========================================================================

describe('Gateway slow-browser tier registration', () => {
  const src = readSrc('server/gateway.ts');

  it('get-bypass-options uses slow-browser tier', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-bypass-options':\s*'slow-browser'/);
  });

  it('get-country-cost-shock uses slow-browser tier', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-country-cost-shock':\s*'slow-browser'/);
  });
});

// ========================================================================
// 6. Premium paths registered
// ========================================================================

describe('Premium paths registration', () => {
  const src = readSrc('src/shared/premium-paths.ts');

  it('get-bypass-options is in PREMIUM_RPC_PATHS', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-bypass-options/);
  });

  it('get-country-cost-shock is in PREMIUM_RPC_PATHS', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-country-cost-shock/);
  });
});

// ========================================================================
// 7. Proto definitions
// ========================================================================

describe('GetBypassOptions proto definition', () => {
  const proto = readSrc('proto/worldmonitor/supply_chain/v1/get_bypass_options.proto');

  it('has GetBypassOptionsRequest message', () => {
    assert.match(proto, /message GetBypassOptionsRequest/);
  });

  it('has GetBypassOptionsResponse message', () => {
    assert.match(proto, /message GetBypassOptionsResponse/);
  });

  it('has BypassOption message', () => {
    assert.match(proto, /message BypassOption/);
  });

  it('chokepoint_id field has required validation', () => {
    assert.match(proto, /\(buf\.validate\.field\)\.required\s*=\s*true/);
  });

  it('live_score field is at field 10', () => {
    assert.match(proto, /double live_score\s*=\s*10/);
  });

  it('bypass_war_risk_tier field is at field 11', () => {
    assert.match(proto, /WarRiskTier bypass_war_risk_tier\s*=\s*11/);
  });
});

describe('GetCountryCostShock proto definition', () => {
  const proto = readSrc('proto/worldmonitor/supply_chain/v1/get_country_cost_shock.proto');

  it('has GetCountryCostShockRequest message', () => {
    assert.match(proto, /message GetCountryCostShockRequest/);
  });

  it('has GetCountryCostShockResponse message', () => {
    assert.match(proto, /message GetCountryCostShockResponse/);
  });

  it('iso2 field has pattern validation', () => {
    assert.match(proto, /\^[^\]]*A-Z.*\$/);
  });

  it('war_risk_premium_bps is int32', () => {
    assert.match(proto, /int32 war_risk_premium_bps/);
  });

  it('has_energy_model is bool', () => {
    assert.match(proto, /bool has_energy_model/);
  });
});

// ========================================================================
// 8. Generated types include new interfaces
// ========================================================================

describe('Generated server types include Sprint 2 interfaces', () => {
  const serverSrc = readSrc('src/generated/server/worldmonitor/supply_chain/v1/service_server.ts');

  it('BypassOption interface is generated', () => {
    assert.match(serverSrc, /interface BypassOption/);
  });

  it('GetBypassOptionsRequest interface is generated', () => {
    assert.match(serverSrc, /interface GetBypassOptionsRequest/);
  });

  it('GetBypassOptionsResponse interface is generated', () => {
    assert.match(serverSrc, /interface GetBypassOptionsResponse/);
  });

  it('GetCountryCostShockRequest interface is generated', () => {
    assert.match(serverSrc, /interface GetCountryCostShockRequest/);
  });

  it('GetCountryCostShockResponse interface is generated', () => {
    assert.match(serverSrc, /interface GetCountryCostShockResponse/);
  });

  it('SupplyChainServiceHandler includes getBypassOptions', () => {
    assert.match(serverSrc, /getBypassOptions\(.*GetBypassOptionsRequest.*GetBypassOptionsResponse/);
  });

  it('SupplyChainServiceHandler includes getCountryCostShock', () => {
    assert.match(serverSrc, /getCountryCostShock\(.*GetCountryCostShockRequest.*GetCountryCostShockResponse/);
  });
});

// ========================================================================
// 9. Client service: new methods exported
// ========================================================================

describe('Supply chain client service: Sprint 2 methods', () => {
  const src = readSrc('src/services/supply-chain/index.ts');

  it('exports fetchBypassOptions function', () => {
    assert.match(src, /export async function fetchBypassOptions/);
  });

  it('exports fetchCountryCostShock function', () => {
    assert.match(src, /export async function fetchCountryCostShock/);
  });

  it('imports GetBypassOptionsResponse from generated client', () => {
    assert.match(src, /GetBypassOptionsResponse/);
  });

  it('imports GetCountryCostShockResponse from generated client', () => {
    assert.match(src, /GetCountryCostShockResponse/);
  });
});

// ========================================================================
// 10. Service proto registers both new RPCs
// ========================================================================

describe('Service proto registers Sprint 2 RPCs', () => {
  const proto = readSrc('proto/worldmonitor/supply_chain/v1/service.proto');

  it('imports get_bypass_options.proto', () => {
    assert.match(proto, /import.*get_bypass_options\.proto/);
  });

  it('imports get_country_cost_shock.proto', () => {
    assert.match(proto, /import.*get_country_cost_shock\.proto/);
  });

  it('registers GetBypassOptions RPC', () => {
    assert.match(proto, /rpc GetBypassOptions\(GetBypassOptionsRequest\)/);
  });

  it('registers GetCountryCostShock RPC', () => {
    assert.match(proto, /rpc GetCountryCostShock\(GetCountryCostShockRequest\)/);
  });

  it('GetBypassOptions path is /get-bypass-options', () => {
    assert.match(proto, /path:\s*"\/get-bypass-options"/);
  });

  it('GetCountryCostShock path is /get-country-cost-shock', () => {
    assert.match(proto, /path:\s*"\/get-country-cost-shock"/);
  });
});
