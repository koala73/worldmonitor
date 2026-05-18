// Tests for the Regional Intelligence snapshot pipeline.
// Pure-function unit tests; no Redis dependency. Run via:
//   npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  REGIONS,
  REGION_IDS,
  THEATERS,
  CORRIDORS,
  GEOGRAPHY_VERSION,
  getRegion,
  getRegionCountries,
  regionForCountry,
  getRegionCorridors,
  countryCriticality,
  isSignalInRegion,
} from '../shared/geography.js';

import { computeBalanceVector, SCORING_VERSION } from '../scripts/regional-snapshot/balance-vector.mjs';
import { deriveRegime, buildRegimeState } from '../scripts/regional-snapshot/regime-derivation.mjs';
import { scoreActors } from '../scripts/regional-snapshot/actor-scoring.mjs';
import { evaluateTriggers } from '../scripts/regional-snapshot/trigger-evaluator.mjs';
import { buildScenarioSets } from '../scripts/regional-snapshot/scenario-builder.mjs';
import { resolveTransmissions, TEMPLATE_VERSION } from '../scripts/regional-snapshot/transmission-templates.mjs';
import { collectEvidence } from '../scripts/regional-snapshot/evidence-collector.mjs';
import { buildPreMeta, buildFinalMeta, MODEL_VERSION } from '../scripts/regional-snapshot/snapshot-meta.mjs';
import { diffRegionalSnapshot, inferTriggerReason } from '../scripts/regional-snapshot/diff-snapshot.mjs';
import { generateSnapshotId, clip, percentile } from '../scripts/regional-snapshot/_helpers.mjs';
import { classifyInputs, FRESHNESS_REGISTRY } from '../scripts/regional-snapshot/freshness.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Geography
// ────────────────────────────────────────────────────────────────────────────

describe('shared/geography', () => {
  it('exports 8 regions with the expected IDs', () => {
    assert.equal(REGIONS.length, 8);
    assert.deepEqual(REGION_IDS.sort(), [
      'east-asia',
      'europe',
      'global',
      'latam',
      'mena',
      'north-america',
      'south-asia',
      'sub-saharan-africa',
    ]);
  });

  it('every region has a non-empty forecastLabel except global', () => {
    for (const r of REGIONS) {
      if (r.id === 'global') continue;
      assert.ok(r.forecastLabel.length > 0, `${r.id} missing forecastLabel`);
    }
  });

  it('every theater belongs to a defined region', () => {
    const regionIds = new Set(REGIONS.map((r) => r.id));
    for (const t of THEATERS) {
      assert.ok(regionIds.has(t.regionId), `Theater ${t.id} -> unknown region ${t.regionId}`);
    }
  });

  it('every corridor belongs to a defined theater and has a valid weight', () => {
    const theaterIds = new Set(THEATERS.map((t) => t.id));
    for (const c of CORRIDORS) {
      assert.ok(theaterIds.has(c.theaterId), `Corridor ${c.id} -> unknown theater ${c.theaterId}`);
      assert.ok(c.weight > 0 && c.weight <= 1, `Corridor ${c.id} weight out of range: ${c.weight}`);
      assert.ok([1, 2, 3].includes(c.tier), `Corridor ${c.id} bad tier ${c.tier}`);
    }
  });

  it('regionForCountry resolves correctly with overrides', () => {
    assert.equal(regionForCountry('AF'), 'south-asia'); // override (WB has it in MEA)
    assert.equal(regionForCountry('PK'), 'south-asia'); // override
    assert.equal(regionForCountry('IR'), 'mena');
    assert.equal(regionForCountry('TW'), 'east-asia'); // manually added
    assert.equal(regionForCountry('US'), 'north-america');
    assert.equal(regionForCountry('DE'), 'europe');
    assert.equal(regionForCountry('NG'), 'sub-saharan-africa');
    assert.equal(regionForCountry('ZZ'), null); // unknown
  });

  it('getRegionCountries returns at least the keyCountries for each region', () => {
    for (const r of REGIONS) {
      if (r.id === 'global') continue;
      const countries = getRegionCountries(r.id);
      for (const key of r.keyCountries) {
        assert.ok(countries.includes(key), `${r.id} keyCountry ${key} missing from ISO2 mapping`);
      }
    }
  });

  it('countryCriticality returns 1.0 for tier-1 corridor controllers', () => {
    assert.equal(countryCriticality('IR'), 1.0); // Hormuz
    assert.equal(countryCriticality('EG'), 1.0); // Suez
    assert.equal(countryCriticality('TR'), 1.0); // Bosphorus
    assert.equal(countryCriticality('XX'), 0.3); // default
  });

  it('GEOGRAPHY_VERSION follows semver', () => {
    assert.match(GEOGRAPHY_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('every region exposes a signalAliases array', () => {
    for (const r of REGIONS) {
      assert.ok(Array.isArray(r.signalAliases), `${r.id} missing signalAliases`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isSignalInRegion: cross-source signal theater matching
// ────────────────────────────────────────────────────────────────────────────
//
// Regression coverage for the silent-drop bug: seed-cross-source-signals.mjs
// emits broad display labels ("Middle East", "Sub-Saharan Africa") that
// don't substring-match any theater ID in region.theaters. The helper must
// handle both fine-grained theater IDs and these broad aliases.

describe('isSignalInRegion', () => {
  it('matches fine-grained theater IDs (kebab-case -> space)', () => {
    assert.equal(isSignalInRegion('persian-gulf', 'mena'), true);
    assert.equal(isSignalInRegion('persian gulf', 'mena'), true);
    assert.equal(isSignalInRegion('Persian Gulf', 'mena'), true);
    assert.equal(isSignalInRegion('Red Sea', 'mena'), true);
    assert.equal(isSignalInRegion('North Africa', 'mena'), true);
    assert.equal(isSignalInRegion('Eastern Europe', 'europe'), true);
    assert.equal(isSignalInRegion('Western Europe', 'europe'), true);
    assert.equal(isSignalInRegion('East Asia', 'east-asia'), true);
    assert.equal(isSignalInRegion('Horn of Africa', 'sub-saharan-africa'), true);
  });

  it('matches the broad display labels the seed actually emits', () => {
    // This is the core regression. Before the fix, these all returned false.
    assert.equal(isSignalInRegion('Middle East', 'mena'), true);
    assert.equal(isSignalInRegion('Sub-Saharan Africa', 'sub-saharan-africa'), true);
    assert.equal(isSignalInRegion('Global', 'global'), true);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    assert.equal(isSignalInRegion('  middle east  ', 'mena'), true);
    assert.equal(isSignalInRegion('MIDDLE EAST', 'mena'), true);
  });

  it('rejects theater labels that belong to other regions', () => {
    assert.equal(isSignalInRegion('Middle East', 'east-asia'), false);
    assert.equal(isSignalInRegion('Middle East', 'sub-saharan-africa'), false);
    assert.equal(isSignalInRegion('Taiwan Strait', 'mena'), false);
    assert.equal(isSignalInRegion('Sub-Saharan Africa', 'mena'), false);
    assert.equal(isSignalInRegion('Eastern Europe', 'mena'), false);
  });

  it('returns false for empty or missing theater', () => {
    assert.equal(isSignalInRegion('', 'mena'), false);
    assert.equal(isSignalInRegion(null, 'mena'), false);
    assert.equal(isSignalInRegion(undefined, 'mena'), false);
  });

  it('returns false for unknown region IDs', () => {
    assert.equal(isSignalInRegion('Middle East', 'not-a-region'), false);
  });

  it('accepts a region object as well as a region ID', () => {
    const mena = REGIONS.find((r) => r.id === 'mena');
    assert.equal(isSignalInRegion('Middle East', mena), true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('clip clamps values to range', () => {
    assert.equal(clip(0.5, 0, 1), 0.5);
    assert.equal(clip(-0.1, 0, 1), 0);
    assert.equal(clip(1.5, 0, 1), 1);
    assert.equal(clip(NaN, 0, 1), 0);
  });

  it('percentile interpolates linearly', () => {
    assert.equal(percentile([0, 1, 2, 3, 4], 0), 0);
    assert.equal(percentile([0, 1, 2, 3, 4], 100), 4);
    assert.equal(percentile([0, 1, 2, 3, 4], 50), 2);
    assert.equal(percentile([], 50), 0);
  });

  it('generateSnapshotId is unique and time-ordered', () => {
    const a = generateSnapshotId();
    const b = generateSnapshotId();
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]+-[0-9a-f]+$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Balance vector
// ────────────────────────────────────────────────────────────────────────────

const baseSources = () => ({
  'risk:scores:sebuf:stale:v2': {
    ciiScores: [
      { region: 'IR', combinedScore: 65, trend: 'TREND_DIRECTION_UP' },
      { region: 'IL', combinedScore: 55, trend: 'TREND_DIRECTION_STABLE' },
      { region: 'SA', combinedScore: 30, trend: 'TREND_DIRECTION_STABLE' },
    ],
  },
  'forecast:predictions:v2': {
    predictions: [
      {
        id: 'f1',
        region: 'Middle East',
        trend: 'rising',
        domain: 'military',
        probability: 0.6,
        confidence: 0.7,
        timeHorizon: 'h24',
        caseFile: { actors: [{ name: 'Iran' }] },
      },
    ],
  },
  'supply_chain:chokepoints:v4': {
    chokepoints: [
      { id: 'hormuz', name: 'Strait of Hormuz', threatLevel: 'elevated' },
      { id: 'babelm', name: 'Bab el-Mandeb', threatLevel: 'high' },
      { id: 'suez', name: 'Suez', threatLevel: 'normal' },
    ],
  },
  'supply_chain:transit-summaries:v1': {
    summaries: { hormuz: { todayTotal: 25, wowChangePct: -12 } },
  },
  'intelligence:cross-source-signals:v1': {
    signals: [
      { id: 's1', type: 'COERCIVE', theater: 'Middle East', severity: 'HIGH', severityScore: 75 },
    ],
  },
  'economic:macro-signals:v1': { verdict: 'NEUTRAL' },
  'energy:mix:v1:_all': {
    IR: { imported: 0.1 },
    SA: { imported: 0.05 },
    AE: { imported: 0.2 },
    EG: { imported: 0.4 },
    IL: { imported: 0.85 },
  },
});

describe('computeBalanceVector', () => {
  it('returns all 7 axes with values in [0, 1] except net_balance', () => {
    const { vector } = computeBalanceVector('mena', baseSources());
    const axes = [
      'coercive_pressure',
      'domestic_fragility',
      'capital_stress',
      'energy_vulnerability',
      'alliance_cohesion',
      'maritime_access',
      'energy_leverage',
    ];
    for (const axis of axes) {
      assert.ok(vector[axis] >= 0 && vector[axis] <= 1, `${axis} out of [0,1]: ${vector[axis]}`);
    }
    assert.ok(vector.net_balance >= -1 && vector.net_balance <= 1);
  });

  it('decomposes net_balance correctly', () => {
    const { vector } = computeBalanceVector('mena', baseSources());
    const pressureMean = (vector.coercive_pressure + vector.domestic_fragility + vector.capital_stress + vector.energy_vulnerability) / 4;
    const bufferMean = (vector.alliance_cohesion + vector.maritime_access + vector.energy_leverage) / 3;
    const expected = bufferMean - pressureMean;
    assert.ok(Math.abs(vector.net_balance - expected) < 0.01, `net_balance=${vector.net_balance} expected≈${expected}`);
  });

  it('always returns at least one driver when there is signal', () => {
    const { vector } = computeBalanceVector('mena', baseSources());
    assert.ok(vector.pressures.length + vector.buffers.length > 0);
  });

  it('weighted-tail domestic fragility amplifies high-criticality countries', () => {
    const sources = {
      'risk:scores:sebuf:stale:v2': {
        ciiScores: [
          // Low CII for low-criticality countries
          { region: 'JO', combinedScore: 10 },
          { region: 'BH', combinedScore: 10 },
          // High CII for tier-1 country
          { region: 'IR', combinedScore: 90 },
        ],
      },
    };
    const { vector } = computeBalanceVector('mena', sources);
    // Should be weighted toward IR's 90 score, not the average of 36
    assert.ok(vector.domestic_fragility > 0.4, `expected fragility > 0.4, got ${vector.domestic_fragility}`);
  });

  it('returns zeros gracefully when no inputs available', () => {
    const { vector } = computeBalanceVector('mena', {});
    assert.equal(vector.coercive_pressure, 0);
    assert.equal(vector.domestic_fragility, 0);
  });

  it('SCORING_VERSION follows semver', () => {
    assert.match(SCORING_VERSION, /^\d+\.\d+\.\d+$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Regime derivation
// ────────────────────────────────────────────────────────────────────────────

describe('deriveRegime', () => {
  const base = () => ({
    coercive_pressure: 0,
    domestic_fragility: 0,
    capital_stress: 0,
    energy_vulnerability: 0,
    alliance_cohesion: 0.5,
    maritime_access: 0.5,
    energy_leverage: 0.5,
    net_balance: 0,
    pressures: [],
    buffers: [],
  });

  it('returns calm by default', () => {
    assert.equal(deriveRegime(base()), 'calm');
  });

  it('returns escalation_ladder when coercive > 0.8 and net < -0.4', () => {
    const v = { ...base(), coercive_pressure: 0.85, net_balance: -0.5 };
    assert.equal(deriveRegime(v), 'escalation_ladder');
  });

  it('returns fragmentation_risk when coercive > 0.6 and alliance < 0.3', () => {
    const v = { ...base(), coercive_pressure: 0.7, alliance_cohesion: 0.2 };
    assert.equal(deriveRegime(v), 'fragmentation_risk');
  });

  it('returns coercive_stalemate when coercive > 0.5 and net > -0.1', () => {
    const v = { ...base(), coercive_pressure: 0.6, net_balance: 0 };
    assert.equal(deriveRegime(v), 'coercive_stalemate');
  });

  it('returns managed_deescalation when net > 0.1 and coercive > 0.3', () => {
    const v = { ...base(), coercive_pressure: 0.4, net_balance: 0.3 };
    assert.equal(deriveRegime(v), 'managed_deescalation');
  });

  it('returns stressed_equilibrium when net < -0.1', () => {
    const v = { ...base(), net_balance: -0.2 };
    assert.equal(deriveRegime(v), 'stressed_equilibrium');
  });

  it('buildRegimeState records transition timestamp on label change', () => {
    const v = { ...base(), net_balance: -0.2 };
    const r = buildRegimeState(v, 'calm', 'test');
    assert.equal(r.label, 'stressed_equilibrium');
    assert.equal(r.previous_label, 'calm');
    assert.ok(r.transitioned_at > 0);
    assert.equal(r.transition_driver, 'test');
  });

  it('buildRegimeState leaves transitioned_at zero when label unchanged', () => {
    const v = base();
    const r = buildRegimeState(v, 'calm');
    assert.equal(r.transitioned_at, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Triggers
// ────────────────────────────────────────────────────────────────────────────

describe('evaluateTriggers', () => {
  it('returns active/watching/dormant arrays', () => {
    const sources = baseSources();
    const { vector } = computeBalanceVector('mena', sources);
    const tl = evaluateTriggers('mena', sources, vector);
    assert.ok(Array.isArray(tl.active));
    assert.ok(Array.isArray(tl.watching));
    assert.ok(Array.isArray(tl.dormant));
  });

  it('mena_coercive_high fires when coercive_pressure >= 0.7', () => {
    const sources = baseSources();
    const vector = { ...computeBalanceVector('mena', sources).vector, coercive_pressure: 0.75 };
    const tl = evaluateTriggers('mena', sources, vector);
    assert.ok(tl.active.some((t) => t.id === 'mena_coercive_high'));
  });

  it('delta operators are dormant in Phase 0 (no historical baseline)', () => {
    const sources = baseSources();
    const { vector } = computeBalanceVector('mena', sources);
    const tl = evaluateTriggers('mena', sources, vector);
    // hormuz_transit_drop and iran_cii_spike use delta operators
    assert.ok(!tl.active.some((t) => t.id === 'hormuz_transit_drop'));
    assert.ok(!tl.active.some((t) => t.id === 'iran_cii_spike'));
  });

  it('only returns triggers for the requested region', () => {
    const sources = baseSources();
    const { vector } = computeBalanceVector('mena', sources);
    const tl = evaluateTriggers('east-asia', sources, vector);
    // No mena_* triggers should appear
    const all = [...tl.active, ...tl.watching, ...tl.dormant];
    assert.ok(!all.some((t) => t.id.startsWith('mena_')));
    assert.ok(!all.some((t) => t.id === 'hormuz_transit_drop'));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario builder
// ────────────────────────────────────────────────────────────────────────────

describe('buildScenarioSets', () => {
  it('returns one set per horizon (24h, 7d, 30d)', () => {
    const sources = baseSources();
    const { vector } = computeBalanceVector('mena', sources);
    const triggers = evaluateTriggers('mena', sources, vector);
    const sets = buildScenarioSets('mena', sources, triggers);
    assert.equal(sets.length, 3);
    assert.deepEqual(sets.map((s) => s.horizon).sort(), ['24h', '30d', '7d']);
  });

  it('lane probabilities sum to 1.0 within each set', () => {
    const sources = baseSources();
    const { vector } = computeBalanceVector('mena', sources);
    const triggers = evaluateTriggers('mena', sources, vector);
    const sets = buildScenarioSets('mena', sources, triggers);
    for (const set of sets) {
      const total = set.lanes.reduce((s, l) => s + l.probability, 0);
      assert.ok(Math.abs(total - 1.0) < 0.005, `${set.horizon} lanes sum ${total}, not 1.0`);
    }
  });

  it('every lane has the four canonical names', () => {
    const sources = baseSources();
    const { vector } = computeBalanceVector('mena', sources);
    const triggers = evaluateTriggers('mena', sources, vector);
    const sets = buildScenarioSets('mena', sources, triggers);
    for (const set of sets) {
      assert.deepEqual(
        set.lanes.map((l) => l.name).sort(),
        ['base', 'containment', 'escalation', 'fragmentation'],
      );
    }
  });

  it('keeps base lane dominant when no forecast or trigger data', () => {
    const sets = buildScenarioSets('global', {}, { active: [], watching: [], dormant: [] });
    for (const set of sets) {
      const base = set.lanes.find((l) => l.name === 'base');
      // With no inputs, base should dominate (initial seed score is 0.4 vs 0.1 for others)
      assert.ok(base.probability > 0.5, `expected base > 0.5, got ${base.probability}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transmission templates
// ────────────────────────────────────────────────────────────────────────────

describe('resolveTransmissions', () => {
  it('returns empty list when no triggers active', () => {
    const out = resolveTransmissions('mena', { active: [], watching: [], dormant: [] });
    assert.equal(out.length, 0);
  });

  it('matches transmission templates to active triggers', () => {
    const triggers = {
      active: [{ id: 'mena_coercive_high', description: '', threshold: {}, activated: true, activated_at: 0, scenario_lane: 'escalation', evidence_ids: [] }],
      watching: [],
      dormant: [],
    };
    const out = resolveTransmissions('mena', triggers);
    assert.ok(out.length > 0);
    for (const t of out) {
      assert.ok(t.template_id);
      assert.equal(t.template_version, TEMPLATE_VERSION);
      assert.ok(t.confidence >= 0 && t.confidence <= 1);
    }
  });

  it('only emits transmissions for the requested region', () => {
    const triggers = {
      active: [{ id: 'taiwan_tension_high', description: '', threshold: {}, activated: true, activated_at: 0, scenario_lane: 'escalation', evidence_ids: [] }],
      watching: [],
      dormant: [],
    };
    const out = resolveTransmissions('mena', triggers);
    assert.equal(out.length, 0); // Taiwan template doesn't list MENA in affected regions... let's check actual output

    const eastAsia = resolveTransmissions('east-asia', triggers);
    assert.ok(eastAsia.length > 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Snapshot meta
// ────────────────────────────────────────────────────────────────────────────

describe('snapshot meta', () => {
  it('buildPreMeta computes confidence from completeness and freshness', () => {
    const allKeys = {};
    for (const s of FRESHNESS_REGISTRY) allKeys[s.key] = { fetchedAt: Date.now() };
    const { pre } = buildPreMeta(allKeys, '1.0.0', '1.0.0');
    assert.equal(pre.snapshot_confidence, 1);
    assert.equal(pre.missing_inputs.length, 0);
    assert.equal(pre.stale_inputs.length, 0);
  });

  it('buildPreMeta marks missing inputs', () => {
    const { pre } = buildPreMeta({}, '1.0.0', '1.0.0');
    assert.ok(pre.snapshot_confidence < 1);
    assert.ok(pre.missing_inputs.length > 0);
  });

  it('buildPreMeta marks stale inputs based on max-age', () => {
    const old = { fetchedAt: Date.now() - 999_999_999 };
    const sources = { 'risk:scores:sebuf:stale:v2': old };
    const { pre } = buildPreMeta(sources, '1.0.0', '1.0.0');
    assert.ok(pre.stale_inputs.includes('risk:scores:sebuf:stale:v2'));
  });

  it('buildFinalMeta merges pre + finalFields preserving snapshot_id', () => {
    const { pre } = buildPreMeta({}, '1.0.0', '1.0.0');
    const final = buildFinalMeta(pre, {
      snapshot_id: 'abc-123',
      trigger_reason: 'regime_shift',
      narrative_provider: 'groq',
      narrative_model: 'mixtral',
    });
    assert.equal(final.snapshot_id, 'abc-123');
    assert.equal(final.trigger_reason, 'regime_shift');
    assert.equal(final.narrative_provider, 'groq');
    assert.equal(final.model_version, MODEL_VERSION);
  });

  // #3728: undated payloads were defaulting to fresh, inflating
  // snapshot_confidence whenever an upstream seeder stalled without a
  // timestamp. Flipped to stale so the confidence score reflects reality.
  it('buildPreMeta treats present-but-undated inputs as stale (#3728)', () => {
    // risk:scores:sebuf:stale:v2 has no metaKey and the payload below has
    // no parseable timestamp field — exactly the case that used to slip
    // through as "fresh".
    const { pre } = buildPreMeta(
      { 'risk:scores:sebuf:stale:v2': { ciiScores: [] } },
      '1.0.0',
      '1.0.0',
    );
    assert.ok(
      pre.stale_inputs.includes('risk:scores:sebuf:stale:v2'),
      'undated payload should land in stale_inputs, not be silently treated as fresh',
    );
  });

  // #3728: valid_until was hardcoded to now+6h regardless of input TTLs, so
  // a snapshot built from a single 30-min-TTL input that was already 20 min
  // old would advertise validity 5.7 hours past the point where its
  // upstream input goes stale. Derive from the registry instead.
  it('valid_until reflects oldest fresh input TTL (#3728)', () => {
    // risk:scores:sebuf:stale:v2 has maxAgeMin=30. With fetchedAt=20min
    // ago, the input expires in ~10min, well before the 6h cap.
    const now = Date.now();
    const fetchedAt = now - 20 * 60_000;
    const { pre } = buildPreMeta(
      { 'risk:scores:sebuf:stale:v2': { ciiScores: [], fetchedAt } },
      '1.0.0',
      '1.0.0',
    );
    const expected = fetchedAt + 30 * 60_000; // ~10min from now
    // 1s tolerance covers Date.now() drift between buildPreMeta and here.
    const drift = Math.abs(pre.valid_until - expected);
    assert.ok(
      drift < 1000,
      `valid_until should be ~${expected} (input ts + maxAgeMin), got ${pre.valid_until} (drift ${drift}ms)`,
    );
    // Sanity: must NOT be the old hardcoded now+6h.
    const sixHoursFromNow = now + 6 * 60 * 60 * 1000;
    assert.ok(
      Math.abs(pre.valid_until - sixHoursFromNow) > 60_000,
      'valid_until must NOT default to now+6h when an input has a tighter TTL',
    );
  });

  it('valid_until = min(input TTLs) when all inputs are fresh — tightest input wins (#3728)', () => {
    // With every registry key fresh, the tightest maxAgeMin sets the bound.
    // Today that is relay:oref:history:v1 at 15min, so the cap (6h) is NOT
    // the binding constraint — this asserts the "min wins" rule. The cap
    // case is exercised separately below.
    const now = Date.now();
    const allKeys = {};
    for (const s of FRESHNESS_REGISTRY) allKeys[s.key] = { fetchedAt: now };
    const { pre } = buildPreMeta(allKeys, '1.0.0', '1.0.0');
    const cap = now + 6 * 60 * 60 * 1000;
    const tightestMin = Math.min(...FRESHNESS_REGISTRY.map((s) => s.maxAgeMin));
    const expectedFromTightest = now + tightestMin * 60_000;
    // 1s tolerance: buildPreMeta snapshots its own Date.now() internally.
    assert.ok(
      Math.abs(pre.valid_until - expectedFromTightest) < 1000,
      `valid_until should be ~now + tightest TTL (${tightestMin}min); got drift ${pre.valid_until - expectedFromTightest}ms`,
    );
    assert.ok(pre.valid_until < cap, 'tightest input must beat the 6h cap when it is < 6h');
  });

  it('valid_until is capped at now + 6h when ALL fresh inputs have TTL > 6h (#3728)', () => {
    // Restrict the sources map to only registry entries with maxAgeMin > 6h
    // so the cap is the binding constraint, not any individual input TTL.
    // (Tightest such entry today: intelligence:gpsjam:v2 at 240min = 4h, so
    // we use a >360min threshold to actually exercise the cap.)
    const SIX_HOURS_MIN = 6 * 60;
    const now = Date.now();
    const longTtlSources = {};
    for (const s of FRESHNESS_REGISTRY) {
      if (s.maxAgeMin > SIX_HOURS_MIN) longTtlSources[s.key] = { fetchedAt: now };
    }
    assert.ok(
      Object.keys(longTtlSources).length > 0,
      'registry must contain at least one entry with maxAgeMin > 6h for this test to be meaningful',
    );
    const { pre, classification } = buildPreMeta(longTtlSources, '1.0.0', '1.0.0');
    // Sanity: every included key should be fresh (so the cap, not a stale
    // fallback, is what's binding valid_until).
    assert.equal(classification.fresh.length, Object.keys(longTtlSources).length);
    const cap = now + 6 * 60 * 60 * 1000;
    // 1s tolerance for tick drift between this Date.now() and buildPreMeta's.
    assert.ok(
      Math.abs(pre.valid_until - cap) < 1000,
      `valid_until should clamp to now + 6h (${cap}) when all inputs out-TTL the cap; got ${pre.valid_until} (drift ${pre.valid_until - cap}ms)`,
    );
  });

  it('valid_until collapses to now when all inputs are stale or missing (#3728)', () => {
    // All inputs missing → fresh[] is empty → valid_until = now.
    const before = Date.now();
    const { pre } = buildPreMeta({}, '1.0.0', '1.0.0');
    const after = Date.now();
    assert.ok(
      pre.valid_until >= before && pre.valid_until <= after,
      `valid_until should collapse to ~now when no inputs are fresh, got ${pre.valid_until} (window: ${before}..${after})`,
    );
    // Sanity: confidence should also be 0 in this all-missing case.
    assert.equal(pre.snapshot_confidence, 0);
  });

  it('valid_until collapses to now when present inputs are all undated (#3728)', () => {
    // Present but undated → classified stale → fresh[] empty → valid_until=now.
    const sources = {};
    for (const s of FRESHNESS_REGISTRY) sources[s.key] = {}; // no timestamps
    const before = Date.now();
    const { pre } = buildPreMeta(sources, '1.0.0', '1.0.0');
    const after = Date.now();
    assert.equal(pre.stale_inputs.length, FRESHNESS_REGISTRY.length);
    assert.ok(
      pre.valid_until >= before && pre.valid_until <= after,
      'undated-everywhere should collapse valid_until to now',
    );
  });

  // #3781 follow-on: 5 upstream feeds whose payloads carry no timestamp
  // `extractTimestamp` recognises would have flipped to STALE on first
  // deploy under #3728's stricter logic. Each is now wired to an existing
  // seed-meta:* companion key so the classifier can prove freshness
  // without the data payload needing a top-level timestamp.
  //
  // Parameterized across all 5 wired keys: any one of them losing its
  // metaKey hint (or the companion key going missing) would re-introduce
  // the on-deploy STALE noise this PR removes.
  for (const [inputKey, metaKey] of [
    ['risk:scores:sebuf:stale:v2',          'seed-meta:intelligence:risk-scores'],
    ['intelligence:cross-source-signals:v1', 'seed-meta:intelligence:cross-source-signals'],
    ['energy:mix:v1:_all',                   'seed-meta:economic:owid-energy-mix'],
    ['supply_chain:transit-summaries:v1',    'seed-meta:supply_chain:transit-summaries'],
    ['relay:oref:history:v1',                'seed-meta:relay:oref:history'],
  ]) {
    it(`buildPreMeta resolves freshness via metaKey when payload has no timestamp — ${inputKey} (#3781)`, () => {
      // Each of these keys serves a payload without a top-level timestamp
      // field. Under the post-#3728 classifier they would land in
      // stale_inputs[] on every run. With metaKey wired, the seed-meta:*
      // fetchedAt is the freshness proof.
      const now = Date.now();
      const sources = { [inputKey]: { /* deliberately undated */ } };
      const metaSources = { [metaKey]: { fetchedAt: now - 5 * 60_000 } };
      const { pre, classification } = buildPreMeta(sources, '1.0.0', '1.0.0', metaSources);
      assert.ok(
        classification.fresh.includes(inputKey),
        `${inputKey}: metaKey fetchedAt should classify the undated payload as fresh`,
      );
      assert.ok(
        !pre.stale_inputs.includes(inputKey),
        `${inputKey}: must not appear in stale_inputs when metaKey is fresh`,
      );
    });
  }

  it('5 #3781 upstream feeds declare metaKey to avoid on-deploy STALE noise', () => {
    // Pre-empt: each of these keys serves a payload without a top-level
    // timestamp field. Under the post-#3728 classifier they would all be
    // classified STALE on first deploy unless their freshness registry
    // entry points at an existing seed-meta:* companion. Lock the wiring
    // in so a later removal will trip a test, not production.
    const expected = {
      'risk:scores:sebuf:stale:v2':          'seed-meta:intelligence:risk-scores',
      'intelligence:cross-source-signals:v1': 'seed-meta:intelligence:cross-source-signals',
      'energy:mix:v1:_all':                   'seed-meta:economic:owid-energy-mix',
      'supply_chain:transit-summaries:v1':    'seed-meta:supply_chain:transit-summaries',
      'relay:oref:history:v1':                'seed-meta:relay:oref:history',
    };
    for (const [key, metaKey] of Object.entries(expected)) {
      const spec = FRESHNESS_REGISTRY.find((s) => s.key === key);
      assert.ok(spec, `registry entry missing for ${key}`);
      assert.equal(
        spec.metaKey,
        metaKey,
        `${key} must declare metaKey=${metaKey} (its payload has no recognised top-level timestamp; removing this would flip it to STALE on every deploy — see PR #3781)`,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Diff engine
// ────────────────────────────────────────────────────────────────────────────

describe('diffRegionalSnapshot', () => {
  function makeSnapshot(overrides = {}) {
    return {
      region_id: 'mena',
      generated_at: Date.now(),
      meta: { snapshot_id: 'x', model_version: '0.1.0', scoring_version: '1.0.0', geography_version: '1.0.0', snapshot_confidence: 1, missing_inputs: [], stale_inputs: [], valid_until: 0, trigger_reason: 'scheduled_6h', narrative_provider: '', narrative_model: '' },
      regime: { label: 'calm', previous_label: '', transitioned_at: 0, transition_driver: '' },
      balance: { coercive_pressure: 0, domestic_fragility: 0, capital_stress: 0, energy_vulnerability: 0, alliance_cohesion: 0.5, maritime_access: 0.7, energy_leverage: 0.5, net_balance: 0, pressures: [], buffers: [] },
      actors: [],
      leverage_edges: [],
      scenario_sets: [{ horizon: '24h', lanes: [{ name: 'base', probability: 1, trigger_ids: [], consequences: [], transmissions: [] }] }],
      transmission_paths: [],
      triggers: { active: [], watching: [], dormant: [] },
      mobility: { airspace: [], flight_corridors: [], airports: [], reroute_intensity: 0, notam_closures: [] },
      evidence: [],
      narrative: { situation: { text: '', evidence_ids: [] }, balance_assessment: { text: '', evidence_ids: [] }, outlook_24h: { text: '', evidence_ids: [] }, outlook_7d: { text: '', evidence_ids: [] }, outlook_30d: { text: '', evidence_ids: [] }, watch_items: [] },
      ...overrides,
    };
  }

  it('returns no diffs for identical snapshots', () => {
    const s = makeSnapshot();
    const diff = diffRegionalSnapshot(s, s);
    assert.equal(diff.regime_changed, null);
    assert.equal(diff.scenario_jumps.length, 0);
    assert.equal(diff.trigger_activations.length, 0);
  });

  it('detects regime change', () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ regime: { ...a.regime, label: 'coercive_stalemate' } });
    const diff = diffRegionalSnapshot(a, b);
    assert.deepEqual(diff.regime_changed, { from: 'calm', to: 'coercive_stalemate' });
  });

  it('detects scenario probability jumps > 15%', () => {
    const a = makeSnapshot();
    const b = makeSnapshot({
      scenario_sets: [{ horizon: '24h', lanes: [{ name: 'base', probability: 0.8, trigger_ids: [], consequences: [], transmissions: [] }] }],
    });
    const diff = diffRegionalSnapshot(a, b);
    assert.equal(diff.scenario_jumps.length, 1);
    assert.equal(diff.scenario_jumps[0].lane, 'base');
  });

  it('detects new trigger activations', () => {
    const a = makeSnapshot();
    const b = makeSnapshot({
      triggers: { active: [{ id: 't1', description: 'New trigger', threshold: {}, activated: true, activated_at: 0, scenario_lane: 'escalation', evidence_ids: [] }], watching: [], dormant: [] },
    });
    const diff = diffRegionalSnapshot(a, b);
    assert.equal(diff.trigger_activations.length, 1);
    assert.equal(diff.trigger_activations[0].id, 't1');
  });

  it('detects buffer failures (> 0.20 drop)', () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ balance: { ...a.balance, alliance_cohesion: 0.2 } });
    const diff = diffRegionalSnapshot(a, b);
    assert.ok(diff.buffer_failures.some((f) => f.axis === 'alliance_cohesion'));
  });

  it('handles null prev (first snapshot ever) gracefully', () => {
    const b = makeSnapshot({ regime: { label: 'coercive_stalemate', previous_label: '', transitioned_at: 0, transition_driver: '' } });
    const diff = diffRegionalSnapshot(null, b);
    assert.deepEqual(diff.regime_changed, { from: '', to: 'coercive_stalemate' });
  });

  it('inferTriggerReason picks regime_shift first', () => {
    const diff = { regime_changed: { from: 'calm', to: 'escalation_ladder' }, scenario_jumps: [], trigger_activations: [{ id: 't1' }], trigger_deactivations: [], corridor_breaks: [], leverage_shifts: [], buffer_failures: [], reroute_waves: null, mobility_disruptions: [] };
    assert.equal(inferTriggerReason(diff), 'regime_shift');
  });

  it('inferTriggerReason falls back to scheduled_6h when nothing changed', () => {
    const diff = { regime_changed: null, scenario_jumps: [], trigger_activations: [], trigger_deactivations: [], corridor_breaks: [], leverage_shifts: [], buffer_failures: [], reroute_waves: null, mobility_disruptions: [] };
    assert.equal(inferTriggerReason(diff), 'scheduled_6h');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Evidence collector: region scoping
// ────────────────────────────────────────────────────────────────────────────
//
// Regression coverage: the chokepoint loop used to iterate all chokepoints
// without filtering by regionId, leaking Taiwan/Baltic events into MENA/SSA
// evidence chains.

describe('collectEvidence region scoping', () => {
  const mixedChokepoints = () => ({
    'supply_chain:chokepoints:v4': {
      chokepoints: [
        { id: 'hormuz', name: 'Strait of Hormuz', threatLevel: 'elevated' },
        { id: 'suez', name: 'Suez', threatLevel: 'high' },
        { id: 'babelm', name: 'Bab el-Mandeb', threatLevel: 'high' },
        { id: 'taiwan_strait', name: 'Taiwan Strait', threatLevel: 'high' },
        { id: 'malacca', name: 'Strait of Malacca', threatLevel: 'elevated' },
        { id: 'panama', name: 'Panama Canal', threatLevel: 'elevated' },
        { id: 'danish', name: 'Danish Straits', threatLevel: 'high' },
        { id: 'bosphorus', name: 'Bosphorus', threatLevel: 'elevated' },
      ],
    },
  });

  it('MENA evidence only includes MENA-owned chokepoints', () => {
    const evidence = collectEvidence('mena', mixedChokepoints());
    const ids = evidence.filter((e) => e.type === 'chokepoint_status').map((e) => e.corridor);
    assert.deepEqual(ids.sort(), ['babelm', 'hormuz', 'suez']);
    assert.ok(!ids.includes('taiwan_strait'));
    assert.ok(!ids.includes('danish'));
    assert.ok(!ids.includes('malacca'));
  });

  it('East Asia evidence only includes East Asia chokepoints', () => {
    const evidence = collectEvidence('east-asia', mixedChokepoints());
    const ids = evidence.filter((e) => e.type === 'chokepoint_status').map((e) => e.corridor);
    assert.deepEqual(ids.sort(), ['malacca', 'taiwan_strait']);
    assert.ok(!ids.includes('hormuz'));
  });

  it('Europe evidence only includes Europe chokepoints', () => {
    const evidence = collectEvidence('europe', mixedChokepoints());
    const ids = evidence.filter((e) => e.type === 'chokepoint_status').map((e) => e.corridor);
    assert.deepEqual(ids.sort(), ['bosphorus', 'danish']);
  });

  it('SSA evidence includes Bab el-Mandeb via horn-of-africa.corridorIds', () => {
    // Bab el-Mandeb physically borders Djibouti/Eritrea (SSA) as well as
    // Yemen (MENA). It belongs to the MENA `red-sea` theater directly, but
    // `horn-of-africa` claims it via corridorIds so SSA also surfaces its
    // threat events. Cape of Good Hope has chokepointId:null and does not
    // appear in the supply_chain:chokepoints:v4 payload, so it is absent
    // here — but babelm now correctly surfaces for SSA.
    const evidence = collectEvidence('sub-saharan-africa', mixedChokepoints());
    const ids = evidence.filter((e) => e.type === 'chokepoint_status').map((e) => e.corridor);
    assert.deepEqual(ids.sort(), ['babelm']);
    assert.ok(!ids.includes('hormuz'));
    assert.ok(!ids.includes('taiwan_strait'));
  });

  it('LatAm evidence includes Panama via caribbean.corridorIds', () => {
    // Panama Canal's primary theater is `north-america` (NA), but the
    // `caribbean` theater claims it via corridorIds so LatAm snapshots
    // also see Panama events. MENA/East Asia chokepoints must still be
    // excluded from LatAm.
    const evidence = collectEvidence('latam', mixedChokepoints());
    const ids = evidence.filter((e) => e.type === 'chokepoint_status').map((e) => e.corridor);
    assert.deepEqual(ids.sort(), ['panama']);
    assert.ok(!ids.includes('hormuz'));
    assert.ok(!ids.includes('taiwan_strait'));
  });

  it('skips chokepoints with normal or empty threat levels even when in region', () => {
    const evidence = collectEvidence('mena', {
      'supply_chain:chokepoints:v4': {
        chokepoints: [
          { id: 'hormuz', threatLevel: 'normal' },
          { id: 'suez', threatLevel: '' },
          { id: 'babelm', threatLevel: 'high' },
        ],
      },
    });
    const ids = evidence.filter((e) => e.type === 'chokepoint_status').map((e) => e.corridor);
    assert.deepEqual(ids, ['babelm']);
  });

  it('cross-source signals emitted with broad "Middle East" label land in MENA evidence', () => {
    // Regression for the theater-matching bug: before the fix, this signal
    // was silently dropped because 'middle east' does not substring-match
    // any of MENA's theater IDs ('levant', 'persian-gulf', 'red-sea',
    // 'north-africa') after kebab-to-space transform.
    const evidence = collectEvidence('mena', {
      'intelligence:cross-source-signals:v1': {
        signals: [
          {
            id: 'sig-broad-mena',
            summary: 'Broad MENA pressure signal',
            theater: 'Middle East',
            severity: 'HIGH',
            severityScore: 80,
            detectedAt: Date.now(),
          },
        ],
      },
    });
    const xssIds = evidence.filter((e) => e.source === 'cross-source').map((e) => e.id);
    assert.ok(xssIds.includes('sig-broad-mena'));
  });

  it('cross-source signals emitted with broad "Sub-Saharan Africa" label land in SSA evidence', () => {
    const evidence = collectEvidence('sub-saharan-africa', {
      'intelligence:cross-source-signals:v1': {
        signals: [
          {
            id: 'sig-broad-ssa',
            summary: 'Broad SSA unrest signal',
            theater: 'Sub-Saharan Africa',
            severity: 'HIGH',
            severityScore: 75,
            detectedAt: Date.now(),
          },
        ],
      },
    });
    const xssIds = evidence.filter((e) => e.source === 'cross-source').map((e) => e.id);
    assert.ok(xssIds.includes('sig-broad-ssa'));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end pipeline (no Redis)
// ────────────────────────────────────────────────────────────────────────────

describe('end-to-end pipeline', () => {
  it('runs the full compute order without throwing', () => {
    const sources = baseSources();
    const { vector: balance } = computeBalanceVector('mena', sources);
    const { actors } = scoreActors('mena', sources);
    const triggers = evaluateTriggers('mena', sources, balance);
    const scenarios = buildScenarioSets('mena', sources, triggers);
    const transmissions = resolveTransmissions('mena', triggers);
    const evidence = collectEvidence('mena', sources);
    const { pre } = buildPreMeta(sources, SCORING_VERSION, GEOGRAPHY_VERSION);
    const snapshotId = generateSnapshotId();
    const meta = buildFinalMeta(pre, { snapshot_id: snapshotId, trigger_reason: 'scheduled_6h' });

    assert.ok(balance);
    assert.ok(Array.isArray(actors));
    assert.ok(triggers);
    assert.equal(scenarios.length, 3);
    assert.ok(Array.isArray(transmissions));
    assert.ok(Array.isArray(evidence));
    assert.ok(meta.snapshot_id);
  });

  it('produces a snapshot for every region without throwing', () => {
    const sources = baseSources();
    for (const region of REGIONS) {
      const { vector } = computeBalanceVector(region.id, sources);
      const triggers = evaluateTriggers(region.id, sources, vector);
      const scenarios = buildScenarioSets(region.id, sources, triggers);
      const transmissions = resolveTransmissions(region.id, triggers);
      const evidence = collectEvidence(region.id, sources);
      assert.ok(vector, `${region.id}: balance computed`);
      assert.equal(scenarios.length, 3, `${region.id}: 3 scenario sets`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Writer-side sanitization (defense-in-depth for stored XSS)
//
// Issue #3730: snapshot evidence/driver strings interpolate upstream Redis
// fields. The renderer escapeHtml-wraps everything, but the writer also
// strips angle brackets so a hostile upstream payload cannot smuggle markup
// into the persisted blob. This test pins the writer-side guarantee end-to-
// end through evidence-collector + balance-vector.
// ────────────────────────────────────────────────────────────────────────────

describe('writer-side XSS hardening (issue #3730)', () => {
  const XSS = '<script>alert(1)</script>';
  const IMG_XSS = '<img src=x onerror=alert(1)>';

  const hostileSources = () => ({
    'intelligence:cross-source-signals:v1': {
      signals: [
        {
          id: `sig-${XSS}`,
          type: `type-${XSS}`,
          summary: `Broad MENA pressure signal ${XSS}`,
          theater: 'Middle East',
          severity: 'CRITICAL',
          severityScore: 90,
          detectedAt: Date.now(),
        },
      ],
    },
    'risk:scores:sebuf:stale:v2': {
      ciiScores: [
        { region: 'IR', combinedScore: 75, trend: `RISING${IMG_XSS}`, computedAt: Date.now() },
      ],
    },
    'supply_chain:chokepoints:v4': {
      chokepoints: [
        { id: 'hormuz', name: `Hormuz ${XSS}`, threatLevel: `high${IMG_XSS}` },
      ],
    },
    'forecast:predictions:v2': {
      predictions: [
        {
          id: `fc-${XSS}`,
          title: `Forecast ${XSS}`,
          region: 'Middle East',
          probability: 0.6,
          confidence: 0.7,
          updatedAt: Date.now(),
        },
      ],
    },
    'economic:macro-signals:v1': { verdict: `CASH${XSS}` },
    'economic:stress-index:v1': { compositeScore: 80, label: `RISKY${XSS}` },
  });

  it('evidence summaries never contain angle brackets', () => {
    const evidence = collectEvidence('mena', hostileSources());
    assert.ok(evidence.length > 0, 'expected at least one evidence item');
    for (const item of evidence) {
      assert.ok(!item.summary.includes('<'), `summary contains "<": ${item.summary}`);
      assert.ok(!item.summary.includes('>'), `summary contains ">": ${item.summary}`);
      assert.ok(!item.id.includes('<'), `id contains "<": ${item.id}`);
      assert.ok(!item.id.includes('>'), `id contains ">": ${item.id}`);
      assert.ok(!item.theater.includes('<'), `theater contains "<": ${item.theater}`);
      assert.ok(!item.corridor.includes('<'), `corridor contains "<": ${item.corridor}`);
    }
  });

  it('balance driver descriptions never contain angle brackets', () => {
    const { vector } = computeBalanceVector('mena', hostileSources());
    const allDrivers = [...vector.pressures, ...vector.buffers];
    assert.ok(allDrivers.length > 0, 'expected at least one driver');
    for (const d of allDrivers) {
      assert.ok(!d.description.includes('<'), `description contains "<": ${d.description}`);
      assert.ok(!d.description.includes('>'), `description contains ">": ${d.description}`);
      for (const eid of d.evidence_ids ?? []) {
        assert.ok(!eid.includes('<'), `evidence_id contains "<": ${eid}`);
        assert.ok(!eid.includes('>'), `evidence_id contains ">": ${eid}`);
      }
    }
  });

  it('the raw "<script>alert(1)</script>" sequence does not survive end-to-end', () => {
    const sources = hostileSources();
    const evidence = collectEvidence('mena', sources);
    const { vector } = computeBalanceVector('mena', sources);
    const serialized = JSON.stringify({ evidence, vector });
    assert.ok(!serialized.includes('<script>'), 'raw <script> tag survived sanitization');
    assert.ok(!serialized.includes('</script>'), 'raw </script> tag survived sanitization');
    assert.ok(!serialized.includes('<img'), 'raw <img tag survived sanitization');
  });
});
