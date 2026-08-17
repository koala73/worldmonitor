import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildChinaCorridorSourceBundle } from '../server/worldmonitor/supply-chain/v1/china-corridor-source-adapters';
import { buildChinaActivityNowcastInputs } from '../server/worldmonitor/economic/v1/get-china-activity-nowcast';
import { evaluateChinaActivityNowcast } from '../shared/china-activity-nowcast';
import { CHINA_ENERGY_DEMAND_METRIC_KEYS } from '../shared/china-corridor-control-towers';
import { buildSpineEntry } from '../scripts/seed-energy-spine.mjs';
import { extractCountryData } from '../scripts/seed-jodi-oil.mjs';
import { DEMAND_CHANGE_BASIS } from '../scripts/shared/jodi-demand-change.mjs';

// The demand change crosses two runtime boundaries that share no code: the
// Railway seeders write JSON into Redis, and the Vercel handlers read it back.
// Every layer fails closed, so a single renamed field or a drifted basis
// literal would silently and permanently withhold `china_energy_demand_change`
// with no crash, no log, and every per-file unit test still green. These tests
// exercise the seams themselves.

const EVALUATED_AT = '2026-07-25T12:00:00.000Z';
const SECONDARY_PRODUCTS = ['GASOLINE', 'GASDIES', 'JETKERO', 'RESFUEL', 'LPG'];

function demandRows(month: string, perProductKbd: number) {
  return SECONDARY_PRODUCTS.map((product) => ({
    REF_AREA: 'CN',
    TIME_PERIOD: month,
    ENERGY_PRODUCT: product,
    FLOW_BREAKDOWN: 'TOTDEMO',
    UNIT_MEASURE: 'KBD',
    OBS_VALUE: String(perProductKbd),
    ASSESSMENT_CODE: '1',
  }));
}

/** Drive the real seeder chain, then the real handler chain, end to end. */
function evaluateThroughFullChain(rows: unknown[]) {
  const jodiOil = extractCountryData(rows, 'CN');
  const spine = buildSpineEntry('CN', {
    mix: null,
    jodiOil,
    jodiGas: null,
    ieaStocks: null,
  });
  const bundle = buildChinaCorridorSourceBundle({
    energySpine: spine,
    energySpineMeta: { fetchedAt: Date.parse('2026-07-25T06:00:00.000Z') },
  }, EVALUATED_AT);
  const corridors = {
    generatedAt: EVALUATED_AT,
    corridors: [{
      id: 'china-yangtze-river-delta',
      name: 'Yangtze River Delta',
      description: '',
      boundary: [],
      nodes: [],
      availability: 'partial',
      conditions: [{
        family: 'power_energy',
        providerId: bundle.families.power_energy.providerId,
        availability: 'available',
        reason: null,
        sourceSignals: bundle.families.power_energy.signals,
        provenance: {},
      }],
    }],
  };
  const inputs = buildChinaActivityNowcastInputs({
    evaluatedAt: EVALUATED_AT,
    macro: { unavailable: true, indicators: [] } as never,
    corridors: corridors as never,
    marketValues: new Map(),
  });
  return {
    spine,
    signal: bundle.families.power_energy.signals[0],
    observation: inputs.proxyObservations
      .find((item) => item.seriesId === 'china_energy_demand_change'),
    contribution: evaluateChinaActivityNowcast({ evaluatedAt: EVALUATED_AT, ...inputs })
      .contributions.find((item) => item.seriesId === 'china_energy_demand_change'),
  };
}

describe('China energy-demand change crosses every runtime seam (#6067)', () => {
  it('carries a real seeded change through the spine, corridor, and nowcast', () => {
    const { spine, signal, observation, contribution } = evaluateThroughFullChain([
      ...demandRows('2026-04', 220),
      ...demandRows('2025-04', 200),
    ]);

    // Seeder -> spine
    assert.equal(spine.coverage.hasDemandChange, true);
    assert.equal(spine.demandChange.basis, DEMAND_CHANGE_BASIS);
    assert.equal(spine.demandChange.unit, '% change');
    assert.deepEqual(spine.demandChange.products, ['diesel', 'fuelOil', 'gasoline', 'jet', 'lpg']);
    assert.equal(spine.demandChange.currentDemandKbd, 1100);
    assert.equal(spine.demandChange.priorDemandKbd, 1000);
    assert.equal(Math.round(spine.demandChange.percentChange * 1e6) / 1e6, 10);
    assert.equal(spine.demandPeriodEnd, '2026-04-30T23:59:59.999Z');

    // Spine -> corridor condition
    assert.equal(signal?.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.percent], 10);
    assert.equal(signal?.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.unit], '% change');
    assert.equal(
      signal?.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.products],
      '["diesel","fuelOil","gasoline","jet","lpg"]',
    );
    assert.equal(
      signal?.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.changePeriodEnd],
      '2026-04-30T23:59:59.999Z',
    );

    // Corridor -> nowcast
    assert.equal(observation?.value, 10);
    assert.equal(observation?.observedAt, '2026-04-30T23:59:59.999Z');
    assert.equal(contribution?.included, true);
    assert.equal(contribution?.direction, 'strengthening');
    assert.equal(contribution?.exclusionReason, null);
  });

  it('refuses the whole chain when the seeder observed no comparable prior', () => {
    // Only the current month is reported: no year-over-year comparison exists.
    const { spine, signal, observation, contribution } = evaluateThroughFullChain(
      demandRows('2026-04', 220),
    );

    assert.equal(spine.demandChange, null);
    assert.equal(spine.coverage.hasDemandChange, false);
    // The period is still published, so the exclusion reason stays truthful.
    assert.equal(spine.demandPeriodEnd, '2026-04-30T23:59:59.999Z');
    assert.equal(signal?.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.percent], undefined);
    assert.equal(
      signal?.metrics[CHINA_ENERGY_DEMAND_METRIC_KEYS.periodEnd],
      '2026-04-30T23:59:59.999Z',
    );
    assert.equal(observation?.value, null);
    assert.equal(contribution?.included, false);
    assert.equal(contribution?.exclusionReason, 'missing_directional_value');
  });

  it('pins the reviewed basis literal on both sides of the runtime boundary', () => {
    // The seeder (Node, Railway) and the handlers (TypeScript, Vercel) share no
    // code, so the literal is duplicated. If one side is edited alone, a real
    // change stops being recognised and the family goes quiet.
    const root = new URL('..', import.meta.url);
    const sources = [
      'server/worldmonitor/economic/v1/get-china-activity-nowcast.ts',
      'server/worldmonitor/supply-chain/v1/china-corridor-source-adapters.ts',
    ].map((path) => readFileSync(new URL(path, root), 'utf8'));

    for (const source of sources) {
      const declared = /ENERGY_DEMAND_CHANGE_BASIS = '([^']+)'/.exec(source)?.[1];
      assert.equal(
        declared,
        DEMAND_CHANGE_BASIS,
        'server-side basis literal drifted from the seeder constant',
      );
    }
  });
});
