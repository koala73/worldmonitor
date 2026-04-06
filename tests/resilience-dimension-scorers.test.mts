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

  it('scoreTradeSanctions: country absent from sanctions payload gets crisis_monitoring_absent imputation (score 80, not 100)', async () => {
    // Not in the OFAC sanctions payload = stable country not targeted. crisis_monitoring_absent
    // imputation (score=80, certaintyCoverage=0.6). Must NOT be 100 (that was the old P1 bug).
    // WTO sources are loaded (empty) so zero restrictions = real data (score 100), not imputed.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:pressure:v1') return { countries: [{ countryCode: 'RU', entryCount: 500 }] };
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [] };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [] };
      return null;
    };
    const score = await scoreTradeSanctions('FI', reader);
    assert.ok(score.coverage < 1, `imputed coverage < 1 (sanctions partial certainty), got ${score.coverage}`);
    assert.notEqual(score.score, 100, 'absent-from-payload must not get imputed score of 100');
    assert.ok(score.score > 60 && score.score < 95,
      `expected blended score 60–95 (imputed sanctions + perfect WTO), got ${score.score}`);
  });

  it('scoreTradeSanctions: seed outage (null source) does not impute as country-absent', async () => {
    // All sources null = seed outage. Must NOT trigger country-absent imputation.
    const reader = async (_key: string): Promise<unknown | null> => null;
    const score = await scoreTradeSanctions('FI', reader);
    assert.equal(score.coverage, 0, `seed outage must give coverage=0, got ${score.coverage}`);
    assert.equal(score.score, 0, `seed outage must give score=0, got ${score.score}`);
  });

  it('scoreCurrencyExternal: country not in BIS EER list gets curated_list_absent imputation (score 50)', async () => {
    // BIS source is loaded (has data for another country) but MZ is not in it.
    // This is genuine curated_list_absent — impute with certaintyCoverage=0.3.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:bis:eer:v1') return { rates: [{ countryCode: 'US', realChange: 1.2, realEer: 101, date: '2025-09' }] };
      return null;
    };
    const score = await scoreCurrencyExternal('MZ', reader); // Mozambique not in BIS
    assert.equal(score.score, 50, 'curated_list_absent must impute score=50');
    assert.equal(score.coverage, 0.3, 'curated_list_absent certaintyCoverage=0.3');
  });

  it('scoreCurrencyExternal: seed outage (null BIS source) gives coverage=0, no imputation', async () => {
    const reader = async (_key: string): Promise<unknown | null> => null;
    const score = await scoreCurrencyExternal('MZ', reader);
    assert.equal(score.score, 50, 'fallback centre score');
    assert.equal(score.coverage, 0, 'null source must not impute — coverage must be 0');
  });

  it('scoreMacroFiscal: BIS credit absent gets curated_list_absent imputation, debt data still scores', async () => {
    // BIS source is loaded (has data for another country) but HR is not in it.
    // Genuine curated_list_absent — impute with certaintyCoverage=0.3.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:national-debt:v1') return { entries: [{ iso3: 'HRV', debtToGdp: 70, annualGrowth: 1.5 }] };
      if (key === 'economic:bis:credit:v1') return { entries: [{ countryCode: 'US', creditGdpRatio: 200 }] }; // HR absent from loaded source
      return null;
    };
    const score = await scoreMacroFiscal('HR', reader);
    // debt (0.5+0.2=0.7 weight, real) + BIS credit (0.3 weight, imputed certaintyCoverage=0.3)
    // coverage = (1.0×0.7 + 0.3×0.3) / 1.0 = 0.79
    assert.ok(score.coverage > 0.7 && score.coverage < 0.9,
      `coverage should be ~0.79 (debt real + credit imputed), got ${score.coverage}`);
    assert.ok(score.score > 0, 'should produce non-zero score with debt real + credit imputed');
    assert.ok(score.coverage < 1.0, 'coverage must be <1 since BIS credit is imputed not observed');
  });

  it('scoreMacroFiscal: BIS credit seed outage does not impute — real debt still scores', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:national-debt:v1') return { entries: [{ iso3: 'HRV', debtToGdp: 70, annualGrowth: 1.5 }] };
      if (key === 'economic:bis:credit:v1') return null; // seed outage
      return null;
    };
    const score = await scoreMacroFiscal('HR', reader);
    // Only debt data available (weight 0.7); credit source null → no imputation → coverage = 0.7
    assert.ok(score.coverage > 0.65 && score.coverage < 0.75,
      `coverage should be ~0.7 (debt only, credit source missing), got ${score.coverage}`);
    assert.ok(score.score > 0, 'debt data alone should produce a non-zero score');
  });

  it('scoreFoodWater: country absent from FAO/IPC DB gets crisis_monitoring_absent imputation (not WGI proxy)', async () => {
    // IPC/HDX only covers countries IN active food crisis. A country absent from the database
    // is not monitored because it is stable — that is a positive signal (crisis_monitoring_absent),
    // not an unknown gap. The imputed score must come from the absence type, NOT from WGI data.
    const readerWithWgi = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        wgi: { indicators: { 'VA.EST': { value: 1.2, year: 2025 } } },
        fao: null,
        aquastat: null,
      };
      return null;
    };
    const readerWithoutWgi = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return { fao: null, aquastat: null };
      return null;
    };
    const withWgi = await scoreFoodWater('XX', readerWithWgi);
    const withoutWgi = await scoreFoodWater('XX', readerWithoutWgi);

    // IPC food imputation: score=88, certaintyCoverage=0.7 on 0.6-weight IPC block.
    // Aquastat absent: 0 coverage. Expected coverage = 0.7 × 0.6 = 0.42.
    assert.equal(withWgi.score, 88, 'imputed score must be 88 (crisis_monitoring_absent for IPC food)');
    assert.ok(withWgi.coverage > 0.3 && withWgi.coverage < 0.6,
      `coverage should be ~0.42 (IPC imputation only), got ${withWgi.coverage}`);

    // WGI must NOT influence the imputed food score — only absence type matters.
    assert.equal(withWgi.score, withoutWgi.score, 'score must not change based on WGI presence (imputation is absence-type, not proxy)');
    assert.equal(withWgi.coverage, withoutWgi.coverage, 'coverage must not change based on WGI presence');
  });

  it('scoreFoodWater: missing static bundle (seed outage) does not impute as crisis-free', async () => {
    // resilience:static:XX key missing entirely = seeder never ran, not "country not in crisis".
    // Must NOT trigger crisis_monitoring_absent imputation.
    const reader = async (_key: string): Promise<unknown | null> => null;
    const score = await scoreFoodWater('XX', reader);
    assert.equal(score.coverage, 0, `missing static bundle must give coverage=0, got ${score.coverage}`);
    assert.equal(score.score, 0, `missing static bundle must give score=0, got ${score.score}`);
  });

  it('scoreBorderSecurity: displacement source loaded but country absent → crisis_monitoring_absent imputation', async () => {
    // Country not in UNHCR displacement registry = not a significant displacement case (positive signal).
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'conflict:ucdp-events:v1') return { events: [] };
      if (key.startsWith('displacement:summary:v1:')) return { summary: { countries: [{ code: 'SY', totalDisplaced: 1e6, hostTotal: 5e5 }] } };
      return null;
    };
    const score = await scoreBorderSecurity('FI', reader);
    // ucdp loaded (no events, score=100, cc=1.0, weight=0.65) +
    // displacement loaded, FI absent → impute (cc=0.6, weight=0.35)
    // coverage = (1.0×0.65 + 0.6×0.35) / 1.0 = 0.86
    assert.ok(score.coverage > 0.8, `expected coverage >0.8 with source loaded, got ${score.coverage}`);
  });

  it('scoreBorderSecurity: displacement seed outage does not impute', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'conflict:ucdp-events:v1') return { events: [] };
      return null; // displacement source null = seed outage
    };
    const score = await scoreBorderSecurity('FI', reader);
    // ucdp loaded (score=100, cc=1.0, weight=0.65) + displacement null (no imputation, cc=0)
    // coverage = (1.0×0.65 + 0×0.35) / 1.0 = 0.65
    assert.ok(score.coverage > 0.6 && score.coverage < 0.7,
      `seed outage must not inflate coverage beyond ucdp weight, got ${score.coverage}`);
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
