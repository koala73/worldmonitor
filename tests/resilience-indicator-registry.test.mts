import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESILIENCE_DIMENSION_ORDER } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  INDICATOR_REGISTRY,
  getIndicatorSourceKeys,
} from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import type { IndicatorSpec } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  SCORER_DOC_PARITY_NON_LINEAR_IDS,
  SCORER_DOC_PARITY_SPECS,
} from './helpers/resilience-scorer-doc-parity-specs.mts';

const ACTIVE_ENERGY_V2_INDICATORS = new Map<string, { weight: number; tier: IndicatorSpec['tier'] }>([
  ['importedFossilDependence', { weight: 0.35, tier: 'core' }],
  ['lowCarbonGenerationShare', { weight: 0.2, tier: 'core' }],
  ['powerLossesPct', { weight: 0.2, tier: 'core' }],
  ['euGasStorageStress', { weight: 0.1, tier: 'enrichment' }],
  ['energyPriceStress', { weight: 0.15, tier: 'core' }],
]);

const LEGACY_ONLY_ENERGY_INDICATORS = [
  'energyImportDependency',
  'gasShare',
  'coalShare',
  'renewShare',
  'electricityConsumption',
] as const;

const SCORER_REGISTRY_PARITY_SPECS = SCORER_DOC_PARITY_SPECS;

describe('indicator registry', () => {
  it('covers all 22 dimensions (20 active + 2 retired)', () => {
    const coveredDimensions = new Set(INDICATOR_REGISTRY.map((i) => i.dimension));
    for (const dimId of RESILIENCE_DIMENSION_ORDER) {
      assert.ok(coveredDimensions.has(dimId), `${dimId} has no indicators in registry`);
    }
    // Plan 2026-04-25-004 Phase 2: 22 dims = 20 active + 2 retired
    // (19 active in Phase 1 + financialSystemExposure added in Phase 2).
    assert.equal(coveredDimensions.size, 22);
  });

  it('has no duplicate indicator ids', () => {
    const ids = INDICATOR_REGISTRY.map((i) => i.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `duplicate ids: ${ids.filter((id, idx) => ids.indexOf(id) !== idx).join(', ')}`);
  });

  it('every indicator has valid direction and positive weight', () => {
    for (const spec of INDICATOR_REGISTRY) {
      assert.ok(['higherBetter', 'lowerBetter', 'indicatorSemantics'].includes(spec.direction), `${spec.id} has invalid direction: ${spec.direction}`);
      assert.ok(spec.weight > 0, `${spec.id} has non-positive weight: ${spec.weight}`);
    }
  });

  it('every indicator has valid cadence and scope', () => {
    const validCadences = new Set(['realtime', 'daily', 'weekly', 'monthly', 'quarterly', 'annual']);
    const validScopes = new Set(['global', 'curated']);
    for (const spec of INDICATOR_REGISTRY) {
      assert.ok(validCadences.has(spec.cadence), `${spec.id} has invalid cadence: ${spec.cadence}`);
      assert.ok(validScopes.has(spec.scope), `${spec.id} has invalid scope: ${spec.scope}`);
    }
  });

  it('composite sourceKeys include sourceKey and do not duplicate entries', () => {
    for (const spec of INDICATOR_REGISTRY) {
      const sourceKeys = getIndicatorSourceKeys(spec);
      assert.ok(sourceKeys.length >= 1, `${spec.id} must have at least one source key`);
      assert.equal(
        sourceKeys[0],
        spec.sourceKey,
        `${spec.id} sourceKeys[0] must be the primary sourceKey for legacy callers`,
      );
      assert.equal(
        sourceKeys.length,
        new Set(sourceKeys).size,
        `${spec.id} sourceKeys must not contain duplicates`,
      );
    }
  });

  it('importedFossilDependence documents both composite inputs for audits', () => {
    const spec = INDICATOR_REGISTRY.find((indicator) => indicator.id === 'importedFossilDependence');
    assert.ok(spec, 'importedFossilDependence must exist in registry');
    assert.deepEqual(
      getIndicatorSourceKeys(spec),
      [
        'resilience:fossil-electricity-share:v1',
        'resilience:static:{ISO2}',
      ],
      'importedFossilDependence must audit both fossil-electricity share and static net-import dependency inputs',
    );
  });

  it('foodWater documents one dynamic AQUASTAT scorer slot, not split phantom rows', () => {
    const foodWaterIds = INDICATOR_REGISTRY
      .filter((indicator) => indicator.dimension === 'foodWater' && indicator.tier !== 'experimental')
      .map((indicator) => indicator.id);
    assert.deepEqual(
      foodWaterIds,
      ['ipcPeopleInCrisis', 'ipcPhase', 'aquastatScore'],
      'foodWater registry must mirror scoreFoodWater: IPC people, IPC phase, and one dynamic aquastatScore slot',
    );

    const aquastat = INDICATOR_REGISTRY.find((indicator) => indicator.id === 'aquastatScore');
    assert.ok(aquastat, 'aquastatScore must exist in registry');
    assert.equal(aquastat.weight, 0.4, 'aquastatScore weight must mirror scoreFoodWater');
    assert.equal(aquastat.direction, 'indicatorSemantics', 'aquastatScore direction is routed by scoreAquastatValue indicator tags');
  });

  it('goalposts worst != best for every indicator', () => {
    for (const spec of INDICATOR_REGISTRY) {
      assert.notEqual(spec.goalposts.worst, spec.goalposts.best, `${spec.id} has worst === best (${spec.goalposts.worst})`);
    }
  });

  it('imputation entries have valid type, score in [0,100], certainty in (0,1]', () => {
    const withImputation = INDICATOR_REGISTRY.filter((i): i is IndicatorSpec & { imputation: NonNullable<IndicatorSpec['imputation']> } => i.imputation != null);
    assert.ok(withImputation.length > 0, 'expected at least one indicator with imputation');
    for (const spec of withImputation) {
      assert.ok(['absenceSignal', 'conservative'].includes(spec.imputation.type), `${spec.id} has invalid imputation type`);
      assert.ok(spec.imputation.score >= 0 && spec.imputation.score <= 100, `${spec.id} imputation score out of range`);
      assert.ok(spec.imputation.certainty > 0 && spec.imputation.certainty <= 1, `${spec.id} imputation certainty out of range`);
    }
  });

  it('every dimension has non-experimental weights that sum to ~1.0', () => {
    // Weight-sum invariant applies to the CURRENTLY-ACTIVE indicator
    // set only. Indicators at tier='experimental' are dormant rollback,
    // retired, or in-progress work and their weights must not be counted
    // against the active 1.0 invariant.
    const byDimension = new Map<string, IndicatorSpec[]>();
    for (const spec of INDICATOR_REGISTRY) {
      if (spec.tier === 'experimental') continue;
      const list = byDimension.get(spec.dimension) ?? [];
      list.push(spec);
      byDimension.set(spec.dimension, list);
    }
    for (const [dimId, specs] of byDimension) {
      const totalWeight = specs.reduce((sum, s) => sum + s.weight, 0);
      assert.ok(
        Math.abs(totalWeight - 1) < 0.01,
        `${dimId} non-experimental weights sum to ${totalWeight.toFixed(4)}, expected ~1.0`,
      );
    }
  });

  it('active production energy-v2 indicators are non-experimental and weight to 1.0', () => {
    const energySpecs = INDICATOR_REGISTRY.filter((spec) => spec.dimension === 'energy');
    const byId = new Map(energySpecs.map((spec) => [spec.id, spec]));
    const activeSpecs: IndicatorSpec[] = [];

    for (const [id, expected] of ACTIVE_ENERGY_V2_INDICATORS) {
      const spec = byId.get(id);
      assert.ok(spec, `active energy-v2 indicator ${id} missing from registry`);
      assert.equal(
        spec.tier,
        expected.tier,
        `${id} must be tier=${expected.tier} now that production constructVersions.energy is v2`,
      );
      assert.notEqual(spec.tier, 'experimental', `${id} must not be experimental in the active production construct`);
      assert.equal(spec.weight, expected.weight, `${id} weight must mirror scoreEnergyV2`);
      activeSpecs.push(spec);
    }

    const activeWeight = activeSpecs.reduce((sum, spec) => sum + spec.weight, 0);
    assert.ok(
      Math.abs(activeWeight - 1) < 0.001,
      `active energy-v2 registry weights sum to ${activeWeight.toFixed(4)}, expected 1.0`,
    );
  });

  it('mirrors scorer-used affected blended inputs', () => {
    const byId = new Map(INDICATOR_REGISTRY.map((spec) => [spec.id, spec]));

    for (const expected of SCORER_REGISTRY_PARITY_SPECS) {
      const spec = byId.get(expected.id);
      assert.ok(spec, `scorer-used indicator ${expected.id} missing from INDICATOR_REGISTRY`);
      assert.equal(spec.dimension, expected.dimension, `${expected.id} dimension must mirror the scorer dimension`);
      assert.equal(spec.direction, expected.registryDirection, `${expected.id} direction must mirror scorer normalization`);
      assert.deepEqual(spec.goalposts, expected.registryGoalposts, `${expected.id} goalposts must mirror scorer normalization anchors`);
      assert.equal(spec.weight, expected.weight, `${expected.id} weight must mirror weightedBlend input`);
      assert.equal(spec.sourceKey, expected.sourceKey, `${expected.id} sourceKey must mirror scorer seed source`);
      assert.equal(spec.tier, expected.tier, `${expected.id} tier must preserve public-score registry parity`);
    }

    const parityDimensions = [...new Set(SCORER_REGISTRY_PARITY_SPECS.map((spec) => spec.dimension))];
    for (const dimension of parityDimensions) {
      const expectedIds = SCORER_REGISTRY_PARITY_SPECS
        .filter((spec) => spec.dimension === dimension)
        .map((spec) => spec.id);
      const expectedIdSet = new Set(expectedIds);
      const actualIds = INDICATOR_REGISTRY
        .filter((spec) => spec.dimension === dimension && (spec.tier !== 'experimental' || expectedIdSet.has(spec.id)))
        .map((spec) => spec.id);
      assert.deepEqual(
        actualIds,
        expectedIds,
        `${dimension} registry rows must list exactly the scorer-used blended inputs, excluding unrelated experimental rollback rows`,
      );
    }
  });

  it('non-linear scorer indicators carry explicit registry normalization metadata', () => {
    const byId = new Map(INDICATOR_REGISTRY.map((spec) => [spec.id, spec]));
    for (const id of SCORER_DOC_PARITY_NON_LINEAR_IDS) {
      const spec = byId.get(id);
      assert.ok(spec, `${id} must exist in INDICATOR_REGISTRY`);
      assert.ok(spec.normalization, `${id} must declare non-linear normalization metadata`);
      assert.notEqual(spec.normalization.kind, 'linear', `${id} must not be treated as a generic linear goalpost metric`);
      assert.ok(
        'disclaimer' in spec.normalization && spec.normalization.disclaimer.length > 20,
        `${id} non-linear normalization must explain how tooling should interpret goalposts`,
      );
    }

    const inflation = byId.get('inflationStability');
    assert.equal(inflation?.normalization?.kind, 'targetBand');
    assert.deepEqual(
      inflation?.normalization.kind === 'targetBand' ? inflation.normalization.targetBand : null,
      { min: 1, max: 3 },
      'inflationStability must document the 1-3% target band used by scoreInflationStability',
    );
    assert.deepEqual(
      inflation?.normalization.kind === 'targetBand' ? inflation.normalization.zeroScoreAt : null,
      { min: -5, max: 50 },
      'inflationStability must document both deflation and high-inflation zero-score anchors',
    );
  });

  it('legacy-only energy indicators stay experimental rollback surfaces under active v2', () => {
    const byId = new Map(INDICATOR_REGISTRY.map((spec) => [spec.id, spec]));
    for (const id of LEGACY_ONLY_ENERGY_INDICATORS) {
      const spec = byId.get(id);
      assert.ok(spec, `legacy energy indicator ${id} missing from registry`);
      assert.equal(
        spec.tier,
        'experimental',
        `${id} is legacy-only under energy v2 and must not re-enter Core while production constructVersions.energy is v2`,
      );
    }
  });

  it('experimental weights are bounded at or below 1.0 per dimension', () => {
    // Loose invariant for experimental indicators. A dimension's
    // experimental set may only carry PART of the post-promotion
    // weight — if some legacy indicators are RETAINED across the
    // construct-repair (e.g. PR 1 retains energyPriceStress at a
    // different weight and renames gasStorageStress to
    // euGasStorageStress, both already in the non-experimental set),
    // the experimental-only subsum will be < 1.0.
    //
    // Post-promotion weight-sum correctness for future staged indicator
    // sets is the SCORER's responsibility to verify (via behavioural
    // tests for that construct), not the
    // registry's. This test enforces only the upper bound: no
    // dimension should accumulate experimental weight in excess of
    // the total it will eventually ship under the flag.
    const byDimension = new Map<string, IndicatorSpec[]>();
    for (const spec of INDICATOR_REGISTRY) {
      if (spec.tier !== 'experimental') continue;
      const list = byDimension.get(spec.dimension) ?? [];
      list.push(spec);
      byDimension.set(spec.dimension, list);
    }
    for (const [dimId, specs] of byDimension) {
      const experimentalWeight = specs.reduce((sum, s) => sum + s.weight, 0);
      assert.ok(
        experimentalWeight <= 1.0 + 0.01,
        `${dimId} experimental weights sum to ${experimentalWeight.toFixed(4)}, must not exceed 1.0`,
      );
    }
  });
});
