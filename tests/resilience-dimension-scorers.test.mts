import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_ORDER,
  scoreAllDimensions,
  scoreBorderSecurity,
  scoreCurrencyExternal,
  scoreCyberDigital,
  scoreEnergy,
  scoreFoodWater,
  scoreGovernanceInstitutional,
  scoreHealthPublicService,
  scoreInformationCognitive,
  scoreInfrastructure,
  scoreLogisticsSupply,
  scoreMacroFiscal,
  scoreSocialCohesion,
  scoreTradeSanctions,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { RESILIENCE_FIXTURES, fixtureReader } from './helpers/resilience-fixtures.mts';

async function scoreTriple(
  scorer: (countryCode: string, reader?: (key: string) => Promise<unknown | null>) => Promise<{ score: number; coverage: number }>,
) {
  const [no, us, ye] = await Promise.all([
    scorer('NO', fixtureReader),
    scorer('US', fixtureReader),
    scorer('YE', fixtureReader),
  ]);
  return { no, us, ye };
}

function assertOrdered(label: string, no: number, us: number, ye: number) {
  assert.ok(no >= us, `${label}: expected NO (${no}) >= US (${us})`);
  assert.ok(us > ye, `${label}: expected US (${us}) > YE (${ye})`);
}

describe('resilience dimension scorers', () => {
  it('produce plausible country ordering for the economic dimensions', async () => {
    const macro = await scoreTriple(scoreMacroFiscal);
    const currency = await scoreTriple(scoreCurrencyExternal);
    const trade = await scoreTriple(scoreTradeSanctions);

    assertOrdered('macroFiscal', macro.no.score, macro.us.score, macro.ye.score);
    assertOrdered('currencyExternal', currency.no.score, currency.us.score, currency.ye.score);
    assertOrdered('tradeSanctions', trade.no.score, trade.us.score, trade.ye.score);
  });

  it('produce plausible country ordering for infrastructure and energy', async () => {
    const cyber = await scoreTriple(scoreCyberDigital);
    const logistics = await scoreTriple(scoreLogisticsSupply);
    const infrastructure = await scoreTriple(scoreInfrastructure);
    const energy = await scoreTriple(scoreEnergy);

    assertOrdered('cyberDigital', cyber.no.score, cyber.us.score, cyber.ye.score);
    assertOrdered('logisticsSupply', logistics.no.score, logistics.us.score, logistics.ye.score);
    assertOrdered('infrastructure', infrastructure.no.score, infrastructure.us.score, infrastructure.ye.score);
    assertOrdered('energy', energy.no.score, energy.us.score, energy.ye.score);
  });

  it('produce plausible country ordering for social, governance, health, and food dimensions', async () => {
    const governance = await scoreTriple(scoreGovernanceInstitutional);
    const social = await scoreTriple(scoreSocialCohesion);
    const border = await scoreTriple(scoreBorderSecurity);
    const information = await scoreTriple(scoreInformationCognitive);
    const health = await scoreTriple(scoreHealthPublicService);
    const foodWater = await scoreTriple(scoreFoodWater);

    assertOrdered('governanceInstitutional', governance.no.score, governance.us.score, governance.ye.score);
    assertOrdered('socialCohesion', social.no.score, social.us.score, social.ye.score);
    assertOrdered('borderSecurity', border.no.score, border.us.score, border.ye.score);
    assertOrdered('informationCognitive', information.no.score, information.us.score, information.ye.score);
    assertOrdered('healthPublicService', health.no.score, health.us.score, health.ye.score);
    assertOrdered('foodWater', foodWater.no.score, foodWater.us.score, foodWater.ye.score);
  });

  it('returns all 13 dimensions with bounded scores and coverage', async () => {
    const dimensions = await scoreAllDimensions('US', fixtureReader);

    assert.deepEqual(Object.keys(dimensions).sort(), [...RESILIENCE_DIMENSION_ORDER].sort());
    for (const dimensionId of RESILIENCE_DIMENSION_ORDER) {
      const result = dimensions[dimensionId];
      assert.ok(result.score >= 0 && result.score <= 100, `${dimensionId} score out of bounds: ${result.score}`);
      assert.ok(result.coverage >= 0 && result.coverage <= 1, `${dimensionId} coverage out of bounds: ${result.coverage}`);
    }
  });

  it('scoreEnergy with full data uses 7-metric blend and high coverage', async () => {
    const no = await scoreEnergy('NO', fixtureReader);
    assert.ok(no.coverage >= 0.85, `NO coverage should be >=0.85 with full data, got ${no.coverage}`);
    assert.ok(no.score > 50, `NO score should be >50 (high renewables, low dependency), got ${no.score}`);
  });

  it('scoreEnergy without OWID mix data degrades gracefully to 4-metric blend', async () => {
    const noOwidReader = async (key: string) => {
      if (key.startsWith('energy:mix:v1:')) return null;
      return RESILIENCE_FIXTURES[key] ?? null;
    };
    const no = await scoreEnergy('NO', noOwidReader);
    assert.ok(no.coverage > 0, `Coverage should be >0 even without OWID data, got ${no.coverage}`);
    // dep (0.25) + energyStress (0.10) + electricityConsumption (0.30) = 0.65 of 1.00 total
    assert.ok(no.coverage < 0.75, `Coverage should be <0.75 without mix data (3 of 7 metrics), got ${no.coverage}`);
    assert.ok(no.score > 0, `Score should be non-zero with only iea + electricity data, got ${no.score}`);
  });

  it('scoreEnergy: high renewShare country scores better than high coalShare at equal dependency', async () => {
    const renewableReader = async (key: string) => {
      if (key === 'resilience:static:XX') return { iea: { energyImportDependency: { value: 50 } } };
      if (key === 'energy:mix:v1:XX') return { gasShare: 5, coalShare: 0, renewShare: 90 };
      if (key === 'economic:energy:v1:all') return null;
      return null;
    };
    const fossilReader = async (key: string) => {
      if (key === 'resilience:static:XX') return { iea: { energyImportDependency: { value: 50 } } };
      if (key === 'energy:mix:v1:XX') return { gasShare: 5, coalShare: 80, renewShare: 5 };
      if (key === 'economic:energy:v1:all') return null;
      return null;
    };
    const renewable = await scoreEnergy('XX', renewableReader);
    const fossil = await scoreEnergy('XX', fossilReader);
    assert.ok(renewable.score > fossil.score,
      `Renewable-heavy (${renewable.score}) should score better than coal-heavy (${fossil.score})`);
  });

  it('Lebanon-like profile: null IEA (Eurostat EU-only gap) + crisis-level electricity → energy < 50', async () => {
    // Pre-fix, Lebanon scored ~89 on energy because: Eurostat is EU-only → dependency=null
    // (missing 0.25 weight), and OWID showed low fossil use during crisis → appeared "clean".
    // Fix: EG.USE.ELEC.KH.PC captures grid collapse (1200 kWh/cap vs USA 12000).
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:LB') return RESILIENCE_FIXTURES['resilience:static:LB'];
      if (key === 'energy:mix:v1:LB') return RESILIENCE_FIXTURES['energy:mix:v1:LB'];
      if (key === 'economic:energy:v1:all') return RESILIENCE_FIXTURES['economic:energy:v1:all'];
      return null;
    };
    const score = await scoreEnergy('LB', reader);
    assert.ok(score.score < 50, `Lebanon energy should be < 50 with crisis-level consumption (null IEA), got ${score.score}`);
    assert.ok(score.coverage > 0, 'should have non-zero coverage even with null IEA');
  });

  it('certainty imputation: country absent from sanctions list scores 100 for the sanctions sub-metric', async () => {
    // Without imputation, a country not in the sanctions list loses 55% coverage weight,
    // which can trigger false lowConfidence for stable economies like Finland.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:pressure:v1') return { countries: [{ countryCode: 'RU', entryCount: 500 }] };
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [] };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [] };
      return null;
    };
    const score = await scoreTradeSanctions('FI', reader);
    assert.equal(score.score, 100, 'unsanctioned country with zero trade friction should score 100');
    assert.equal(score.coverage, 1, 'should have full coverage when all 3 trade sub-metrics are present');
  });

  it('memoizes repeated seed reads inside scoreAllDimensions', async () => {
    const hits = new Map<string, number>();
    const countingReader = async (key: string) => {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return RESILIENCE_FIXTURES[key] ?? null;
    };

    await scoreAllDimensions('US', countingReader);

    for (const [key, count] of hits.entries()) {
      assert.equal(count, 1, `expected ${key} to be read once, got ${count}`);
    }
  });
});
