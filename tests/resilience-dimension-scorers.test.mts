import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IMPUTATION,
  IMPUTE,
  type ImputationClass,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_TYPES,
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
  scorer: (countryCode: string, reader?: (key: string) => Promise<unknown | null>) => Promise<{ score: number; coverage: number; observedWeight: number; imputedWeight: number; imputationClass: ImputationClass | null }>,
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

  it('scoreTradeSanctions: country with 0 OFAC designations scores 100 (full-count key, not imputed)', async () => {
    // country-counts:v1 covers ALL countries. A country absent from the map has 0 designations
    // which is a real data point (score=100), not an imputed absence.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:country-counts:v1') return { RU: 500, IR: 350 }; // FI absent = 0
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [] };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [] };
      return null;
    };
    const score = await scoreTradeSanctions('FI', reader);
    assert.equal(score.score, 100, 'FI with 0 designations must score 100 (not sanctioned)');
    // WB tariff rate absent (no static record) reduces coverage from 1.0 to 0.75
    assert.equal(score.coverage, 0.75, 'coverage reflects missing WB tariff rate');
  });

  it('scoreTradeSanctions: heavily sanctioned country scores low', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:country-counts:v1') return { RU: 500 };
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [] };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [] };
      return null;
    };
    const score = await scoreTradeSanctions('RU', reader);
    // Sanctions metric alone = 0 (score floored); WTO sources are empty (no restrictions = 100).
    // Available: 0.45+0.15+0.15 = 0.75. Score: (0*0.45 + 100*0.15 + 100*0.15)/0.75 = 40.
    assert.ok(score.score < 55, `RU with 500 designations should score below midpoint, got ${score.score}`);
  });

  it('scoreTradeSanctions: seed outage (null source) does not impute as country-absent', async () => {
    const reader = async (_key: string): Promise<unknown | null> => null;
    const score = await scoreTradeSanctions('FI', reader);
    assert.equal(score.coverage, 0, `seed outage must give coverage=0, got ${score.coverage}`);
    assert.equal(score.score, 0, `seed outage must give score=0, got ${score.score}`);
  });

  it('scoreTradeSanctions: reporter-set country with zero restrictions scores 100 (real data)', async () => {
    const reporterSet = ['US', 'CN', 'DE', 'JP', 'GB', 'IN', 'BR', 'RU', 'KR', 'AU', 'CA', 'MX', 'FR', 'IT', 'NL'];
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:country-counts:v1') return {};
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [], _reporterCountries: reporterSet };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [], _reporterCountries: reporterSet };
      return null;
    };
    const score = await scoreTradeSanctions('US', reader);
    assert.equal(score.score, 100, 'reporter with 0 restrictions must score 100 (genuine zero)');
    // WB tariff rate absent (no static record) reduces coverage from 1.0 to 0.75
    assert.equal(score.coverage, 0.75, 'coverage reflects missing WB tariff rate');
  });

  it('scoreTradeSanctions: non-reporter country gets IMPUTE.wtoData (blended score=84, coverage=0.57)', async () => {
    const reporterSet = ['US', 'CN', 'DE', 'JP', 'GB', 'IN', 'BR', 'RU', 'KR', 'AU', 'CA', 'MX', 'FR', 'IT', 'NL'];
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:country-counts:v1') return {};
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [], _reporterCountries: reporterSet };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [], _reporterCountries: reporterSet };
      return null;
    };
    const score = await scoreTradeSanctions('BF', reader);
    // BF (Burkina Faso) not in reporter set: sanctions=100 (0 designations, weight 0.45),
    // restrictions=60 (imputed, weight 0.15, cc=0.4), barriers=60 (imputed, weight 0.15, cc=0.4),
    // WB tariff=null (weight 0.25). Available weight = 0.75.
    // Blended score: (100*0.45 + 60*0.15 + 60*0.15) / 0.75 = 84
    assert.equal(score.score, 84, 'non-reporter blended with sanctions=100 and imputed WTO=60');
    // Coverage: (1.0*0.45 + 0.4*0.15 + 0.4*0.15 + 0*0.25) / 1.0 = 0.57
    assert.equal(score.coverage, 0.57, 'non-reporter coverage reflects imputed WTO metrics and absent tariff');
  });

  it('scoreTradeSanctions: WTO seed outage returns null for both trade metrics', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:country-counts:v1') return { US: 10 };
      return null;
    };
    const score = await scoreTradeSanctions('US', reader);
    // Only sanctions loaded (weight 0.45). WTO restrictions + barriers + WB tariff null.
    assert.ok(score.score > 0, 'sanctions data alone produces non-zero score');
    assert.ok(score.coverage > 0.4 && score.coverage < 0.5,
      `coverage should be ~0.45 (only sanctions loaded), got ${score.coverage}`);
  });

  it('scoreCurrencyExternal: non-BIS country with no IMF data falls back to curated_list_absent (score 50)', async () => {
    // BIS loaded, IMF macro also null — no inflation proxy available → curated_list_absent imputation.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:bis:eer:v1') return { rates: [{ countryCode: 'US', realChange: 1.2, realEer: 101, date: '2025-09' }] };
      return null; // economic:imf:macro:v1 also null
    };
    const score = await scoreCurrencyExternal('MZ', reader); // Mozambique not in BIS
    assert.equal(score.score, 50, 'curated_list_absent must impute score=50 when IMF also missing');
    assert.equal(score.coverage, 0.3, 'curated_list_absent certaintyCoverage=0.3');
  });

  it('scoreCurrencyExternal: non-BIS country with IMF inflation uses inflation proxy (coverage 0.45)', async () => {
    // BIS loaded, IMF macro has inflation → use inflation proxy instead of curated_list_absent.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:bis:eer:v1') return { rates: [{ countryCode: 'US', realChange: 1.2, realEer: 101, date: '2025-09' }] };
      if (key === 'economic:imf:macro:v2') return { countries: { MZ: { inflationPct: 8, currentAccountPct: -5, year: 2024 } } };
      return null;
    };
    const score = await scoreCurrencyExternal('MZ', reader);
    // normalizeLowerBetter(min(8,50), 0, 50) = (50-8)/50*100 = 84
    assert.equal(score.score, 84, 'low-inflation country gets high currency score via IMF proxy');
    assert.equal(score.coverage, 0.45, 'IMF inflation proxy coverage=0.45 (better than pure imputation)');
  });

  it('scoreCurrencyExternal: non-BIS country with hyperinflation is capped at score 0', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:bis:eer:v1') return { rates: [{ countryCode: 'US', realChange: 1.2, realEer: 101, date: '2025-09' }] };
      if (key === 'economic:imf:macro:v2') return { countries: { ZW: { inflationPct: 250, currentAccountPct: -8, year: 2024 } } };
      return null;
    };
    const score = await scoreCurrencyExternal('ZW', reader);
    // min(250, 50) = 50 → normalizeLowerBetter(50, 0, 50) = 0
    assert.equal(score.score, 0, 'hyperinflation ≥50% is capped → score 0');
    assert.equal(score.coverage, 0.45, 'hyperinflation still gets IMF proxy coverage=0.45');
  });

  it('scoreCurrencyExternal: BIS outage + IMF inflation present → uses proxy with coverage=0.35', async () => {
    // BIS seed is completely down (null), but IMF macro is available.
    // The inflation proxy should still be applied — BIS outage must not block the IMF path.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:imf:macro:v2') return { countries: { MZ: { inflationPct: 6, currentAccountPct: -2, year: 2024 } } };
      return null; // economic:bis:eer:v1 null = BIS seed outage
    };
    const score = await scoreCurrencyExternal('MZ', reader);
    // normalizeLowerBetter(min(6,50), 0, 50) = (50-6)/50*100 = 88
    assert.equal(score.score, 88, 'BIS outage must not block IMF inflation proxy');
    assert.equal(score.coverage, 0.35, 'BIS outage reduces proxy coverage to 0.35 (primary source unavailable)');
  });

  it('scoreCurrencyExternal: both BIS and IMF null → coverage=0, no imputation', async () => {
    const reader = async (_key: string): Promise<unknown | null> => null;
    const score = await scoreCurrencyExternal('MZ', reader);
    assert.equal(score.score, 50, 'both sources null → fallback centre score');
    assert.equal(score.coverage, 0, 'both sources null → coverage=0');
  });

  it('scoreCurrencyExternal: FX reserves contribute to score alongside BIS data', async () => {
    const withReserves = await scoreCurrencyExternal('NO', fixtureReader);
    const readerNoReserves = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:NO') {
        const base = RESILIENCE_FIXTURES['resilience:static:NO'] as Record<string, unknown>;
        return { ...base, fxReservesMonths: null };
      }
      return fixtureReader(key);
    };
    const withoutReserves = await scoreCurrencyExternal('NO', readerNoReserves);
    assert.ok(withReserves.score !== withoutReserves.score, 'reserves data must change the BIS-country score');
    assert.ok(withReserves.coverage > 0, 'coverage must be positive with BIS + reserves');
  });

  it('scoreCurrencyExternal: non-BIS country with good reserves scores higher than with bad reserves', async () => {
    const makeReader = (months: number) => async (key: string): Promise<unknown | null> => {
      if (key === 'economic:bis:eer:v1') return { rates: [{ countryCode: 'US', realChange: 1.2, realEer: 101, date: '2025-09' }] };
      if (key === 'economic:imf:macro:v2') return { countries: { MZ: { inflationPct: 15, currentAccountPct: -5, year: 2024 } } };
      if (key === 'resilience:static:MZ') return { fxReservesMonths: { source: 'worldbank', months, year: 2023 } };
      return null;
    };
    const goodRes = await scoreCurrencyExternal('MZ', makeReader(12));
    const badRes = await scoreCurrencyExternal('MZ', makeReader(1.5));
    assert.ok(goodRes.score > badRes.score, `good reserves (${goodRes.score}) must score higher than bad (${badRes.score})`);
    assert.equal(goodRes.coverage, badRes.coverage, 'coverage should be the same when both have inflation+reserves');
    assert.equal(goodRes.coverage, 0.55, 'non-BIS with inflation+reserves gets coverage=0.55');
  });

  it('scoreMacroFiscal: IMF current account loaded, surplus country scores higher than deficit', async () => {
    const makeReader = (caPct: number) => async (key: string): Promise<unknown | null> => {
      if (key === 'economic:national-debt:v1') return { entries: [{ iso3: 'HRV', debtToGdp: 70, annualGrowth: 1.5 }] };
      if (key === 'economic:imf:macro:v2') return { countries: { HR: { inflationPct: 3.0, currentAccountPct: caPct, govRevenuePct: 40, year: 2024 } } };
      return null;
    };
    const surplus = await scoreMacroFiscal('HR', makeReader(10));
    const deficit = await scoreMacroFiscal('HR', makeReader(-15));
    assert.ok(surplus.score > deficit.score, `surplus (${surplus.score}) must score higher than deficit (${deficit.score})`);
    assert.equal(surplus.coverage, 1, 'all real data → coverage=1');
  });

  it('scoreMacroFiscal: IMF macro seed outage does not impute — debt growth still scores', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:national-debt:v1') return { entries: [{ iso3: 'HRV', debtToGdp: 70, annualGrowth: 1.5 }] };
      return null; // economic:imf:macro:v1 null = seed outage
    };
    const score = await scoreMacroFiscal('HR', reader);
    // govRevenuePct (0.5) and currentAccountPct (0.3) come from IMF macro (null = outage).
    // Only debtGrowth (weight=0.2) has real data → coverage = 0.2.
    assert.ok(score.coverage > 0.15 && score.coverage < 0.25,
      `coverage should be ~0.2 (debt growth only, IMF outage), got ${score.coverage}`);
    assert.ok(score.score > 0, 'debt growth data alone should produce a non-zero score');
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

  it('scoreCyberDigital: country with zero threats in loaded feed gets null, not 100', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'cyber:threats:v2') return { threats: [{ country: 'United States', severity: 'CRITICALITY_LEVEL_HIGH' }] };
      if (key === 'infra:outages:v1') return { outages: [] };
      if (key === 'intelligence:gpsjam:v2') return { hexes: [] };
      return null;
    };
    const score = await scoreCyberDigital('FI', reader);
    assert.equal(score.score, 0, 'zero events in all three loaded feeds must yield score=0 (not 100)');
    assert.equal(score.coverage, 0, 'zero events in all three loaded feeds must yield coverage=0');
  });

  it('scoreCyberDigital: country with real threats scores normally', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'cyber:threats:v2') return { threats: [
        { country: 'Finland', severity: 'CRITICALITY_LEVEL_HIGH' },
        { country: 'Finland', severity: 'CRITICALITY_LEVEL_MEDIUM' },
      ] };
      if (key === 'infra:outages:v1') return { outages: [{ countryCode: 'FI', severity: 'OUTAGE_SEVERITY_PARTIAL' }] };
      if (key === 'intelligence:gpsjam:v2') return { hexes: [] };
      return null;
    };
    const score = await scoreCyberDigital('FI', reader);
    assert.ok(score.score > 0, `country with real threats must have score > 0, got ${score.score}`);
    assert.ok(score.score < 100, `country with real threats must have score < 100, got ${score.score}`);
    assert.ok(score.coverage > 0, `coverage should be > 0 with real data, got ${score.coverage}`);
  });

  it('scoreCyberDigital: feed outage (null source) returns score=0 and zero coverage', async () => {
    const reader = async (_key: string): Promise<unknown | null> => null;
    const score = await scoreCyberDigital('US', reader);
    assert.equal(score.score, 0, 'all feeds null (seed outage) must yield score=0');
    assert.equal(score.coverage, 0, 'all feeds null (seed outage) must yield coverage=0');
  });

  it('scoreInformationCognitive: correctly unwraps news:threat:summary:v1 { byCountry } envelope', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:US') return RESILIENCE_FIXTURES['resilience:static:US'];
      if (key === 'intelligence:social:reddit:v1') return RESILIENCE_FIXTURES['intelligence:social:reddit:v1'];
      if (key === 'news:threat:summary:v1') return {
        byCountry: { US: { critical: 1, high: 3, medium: 2, low: 1 } },
        generatedAt: '2026-04-06T00:00:00.000Z',
      };
      return null;
    };
    const score = await scoreInformationCognitive('US', reader);
    assert.ok(score.score > 0, `should produce a score with wrapped payload, got ${score.score}`);
    assert.ok(score.coverage > 0, `should have coverage with threat data present, got ${score.coverage}`);
  });

  it('scoreInformationCognitive: zero news threats in loaded feed gets null', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return { rsf: { score: 80, rank: 20, year: 2025 } };
      if (key === 'intelligence:social:reddit:v1') return { posts: [] };
      if (key === 'news:threat:summary:v1') return {
        byCountry: { US: { critical: 1, high: 2, medium: 3, low: 1 } },
        generatedAt: '2026-04-06T00:00:00.000Z',
      };
      return null;
    };
    const score = await scoreInformationCognitive('XX', reader);
    assert.ok(score.score === 20, `RSF only (no threat, no velocity), got ${score.score}`);
  });

  it('scoreBorderSecurity: zero UCDP events still scores (UCDP is global registry)', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'conflict:ucdp-events:v1') return { events: [] };
      if (key.startsWith('displacement:summary:v1:')) return { summary: { countries: [] } };
      return null;
    };
    const score = await scoreBorderSecurity('FI', reader);
    assert.ok(score.coverage > 0, `UCDP loaded with zero events must still contribute to coverage, got ${score.coverage}`);
    assert.ok(score.score > 50, `zero UCDP events = peaceful country, should score high, got ${score.score}`);
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

  it('weightedBlend returns observedWeight and imputedWeight', async () => {
    const result = await scoreMacroFiscal('US', fixtureReader);
    assert.ok(typeof result.observedWeight === 'number', 'observedWeight must be a number');
    assert.ok(typeof result.imputedWeight === 'number', 'imputedWeight must be a number');
    assert.ok(result.observedWeight >= 0, 'observedWeight must be >= 0');
    assert.ok(result.imputedWeight >= 0, 'imputedWeight must be >= 0');
  });

  it('imputationShare = 0 when all data is real (US has full IMF + debt data)', async () => {
    const dimensions = await scoreAllDimensions('US', fixtureReader);
    const totalImputed = Object.values(dimensions).reduce((s, d) => s + d.imputedWeight, 0);
    const totalObserved = Object.values(dimensions).reduce((s, d) => s + d.observedWeight, 0);
    const imputationShare = (totalImputed + totalObserved) > 0
      ? totalImputed / (totalImputed + totalObserved)
      : 0;
    assert.ok(imputationShare < 0.15, `US imputationShare should be low with rich data, got ${imputationShare.toFixed(4)}`);
  });

  it('imputationShare > 0 when crisis_monitoring_absent imputation is active', async () => {
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        wgi: { indicators: { VA: { value: 1.5, year: 2025 } } },
        fao: null,
        aquastat: null,
      };
      return null;
    };
    const result = await scoreFoodWater('XX', reader);
    assert.ok(result.imputedWeight > 0, `crisis_monitoring_absent imputation must produce imputedWeight > 0, got ${result.imputedWeight}`);
    assert.equal(result.observedWeight, 0, 'no real data available, observedWeight should be 0');
  });

  it('every dimension has a type tag (baseline/stress/mixed)', () => {
    for (const dimId of RESILIENCE_DIMENSION_ORDER) {
      assert.ok(RESILIENCE_DIMENSION_TYPES[dimId], `${dimId} missing type tag`);
      assert.ok(
        ['baseline', 'stress', 'mixed'].includes(RESILIENCE_DIMENSION_TYPES[dimId]),
        `${dimId} has invalid type`,
      );
    }
  });

  it('scoreLogisticsSupply: high trade/GDP country feels more shipping stress than autarky', async () => {
    const makeReader = (tradeToGdpPct: number) => async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        infrastructure: { indicators: { 'IS.ROD.PAVE.ZS': { value: 80, year: 2025 } } },
        tradeToGdp: { tradeToGdpPct, year: 2023, source: 'worldbank' },
      };
      if (key === 'supply_chain:shipping_stress:v1') return { stressScore: 70 };
      if (key === 'supply_chain:transit-summaries:v1') return { summaries: { suez: { disruptionPct: 10, incidentCount7d: 5 } } };
      return null;
    };
    const openEconomy = await scoreLogisticsSupply('XX', makeReader(100));
    const autarky = await scoreLogisticsSupply('XX', makeReader(10));
    assert.ok(openEconomy.score < autarky.score,
      `Open economy (trade/GDP=100%, score=${openEconomy.score}) should score lower than autarky (trade/GDP=10%, score=${autarky.score}) under shipping stress`);
  });

  it('scoreLogisticsSupply: missing tradeToGdp defaults to 0.5 exposure factor', async () => {
    const withTrade25 = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        infrastructure: { indicators: { 'IS.ROD.PAVE.ZS': { value: 80, year: 2025 } } },
        tradeToGdp: { tradeToGdpPct: 25, year: 2023, source: 'worldbank' },
      };
      if (key === 'supply_chain:shipping_stress:v1') return { stressScore: 70 };
      if (key === 'supply_chain:transit-summaries:v1') return { summaries: { suez: { disruptionPct: 10, incidentCount7d: 5 } } };
      return null;
    };
    const withoutTrade = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        infrastructure: { indicators: { 'IS.ROD.PAVE.ZS': { value: 80, year: 2025 } } },
      };
      if (key === 'supply_chain:shipping_stress:v1') return { stressScore: 70 };
      if (key === 'supply_chain:transit-summaries:v1') return { summaries: { suez: { disruptionPct: 10, incidentCount7d: 5 } } };
      return null;
    };
    const known = await scoreLogisticsSupply('XX', withTrade25);
    const unknown = await scoreLogisticsSupply('XX', withoutTrade);
    assert.equal(known.score, unknown.score,
      `trade/GDP=25% gives exposure=0.5 which equals the default 0.5, so scores should match`);
  });

  it('scoreEnergy: high import dependency country feels more energy price stress', async () => {
    const makeReader = (importDep: number) => async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        iea: { energyImportDependency: { value: importDep, year: 2024, source: 'IEA' } },
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 5000, year: 2025 } } },
      };
      if (key === 'economic:energy:v1:all') return { prices: [{ change: 15 }, { change: -12 }, { change: 18 }] };
      return null;
    };
    const highDep = await scoreEnergy('XX', makeReader(90));
    const lowDep = await scoreEnergy('XX', makeReader(10));
    assert.ok(highDep.score < lowDep.score,
      `High import dependency (90%, score=${highDep.score}) should score lower than low dependency (10%, score=${lowDep.score}) under energy price stress`);
  });

  it('scoreEnergy: missing import dependency defaults to 0.5 exposure factor (between high and low)', async () => {
    const makeReader = (iea: unknown) => async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        iea,
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 5000, year: 2025 } } },
      };
      if (key === 'economic:energy:v1:all') return { prices: [{ change: 15 }, { change: -12 }, { change: 18 }] };
      return null;
    };
    const highDep = await scoreEnergy('XX', makeReader({ energyImportDependency: { value: 90, year: 2024, source: 'IEA' } }));
    const missingDep = await scoreEnergy('XX', makeReader(null));
    const lowDep = await scoreEnergy('XX', makeReader({ energyImportDependency: { value: 5, year: 2024, source: 'IEA' } }));
    const zeroDep = await scoreEnergy('XX', makeReader({ energyImportDependency: { value: 0, year: 2024, source: 'IEA' } }));
    const exporterDep = await scoreEnergy('XX', makeReader({ energyImportDependency: { value: -30, year: 2024, source: 'IEA' } }));
    assert.ok(missingDep.score <= lowDep.score,
      `Missing dependency (score=${missingDep.score}) should score <= low dep (score=${lowDep.score}) since default exposure=0.5 is moderate`);
    assert.ok(missingDep.score >= highDep.score,
      `Missing dependency (score=${missingDep.score}) should score >= high dep (score=${highDep.score})`);
    // The clamp at _dimension-scorers.ts:847 floors negative dependency to 0 exposure.
    // A net exporter (-30) must produce the same score as dependency=0, proving the clamp works.
    assert.equal(exporterDep.score, zeroDep.score,
      `Net exporter (score=${exporterDep.score}) must equal zero-dependency (score=${zeroDep.score}) — negative values should clamp to 0 exposure`);
  });

  it('scoreLogisticsSupply: static bundle outage (null) excludes exposure-weighted stress metrics', async () => {
    const outageReader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return null;
      if (key === 'supply_chain:shipping_stress:v1') return { stressScore: 80 };
      if (key === 'supply_chain:transit-summaries:v1') return { summaries: { suez: { disruptionPct: 15, incidentCount7d: 8 } } };
      return null;
    };
    const result = await scoreLogisticsSupply('XX', outageReader);
    assert.equal(result.score, 0, 'All metrics null when static bundle is missing and no roads data');
    assert.equal(result.coverage, 0, 'Coverage should be 0 when all sub-metrics are null');

    const withStaticReader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        infrastructure: { indicators: { 'IS.ROD.PAVE.ZS': { value: 80, year: 2025 } } },
      };
      if (key === 'supply_chain:shipping_stress:v1') return { stressScore: 80 };
      if (key === 'supply_chain:transit-summaries:v1') return { summaries: { suez: { disruptionPct: 15, incidentCount7d: 8 } } };
      return null;
    };
    const withStatic = await scoreLogisticsSupply('XX', withStaticReader);
    assert.ok(withStatic.score > 0, `Static bundle present should produce non-zero score (got ${withStatic.score})`);
    assert.ok(withStatic.coverage > result.coverage, 'Coverage should be higher with static bundle present');
  });

  it('scoreEnergy: static bundle outage (null) excludes exposure-weighted energy price stress', async () => {
    const outageReader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return null;
      if (key === 'economic:energy:v1:all') return { prices: [{ change: 20 }, { change: -15 }, { change: 25 }] };
      return null;
    };
    const result = await scoreEnergy('XX', outageReader);
    assert.equal(result.score, 0, 'All metrics null when static bundle is missing');
    assert.equal(result.coverage, 0, 'Coverage should be 0 when all sub-metrics are null');

    const withStaticReader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        iea: { energyImportDependency: { value: 60, year: 2024, source: 'IEA' } },
        infrastructure: { indicators: { 'EG.USE.ELEC.KH.PC': { value: 5000, year: 2025 } } },
      };
      if (key === 'economic:energy:v1:all') return { prices: [{ change: 20 }, { change: -15 }, { change: 25 }] };
      return null;
    };
    const withStatic = await scoreEnergy('XX', withStaticReader);
    assert.ok(withStatic.score > 0, `Static bundle present should produce non-zero score (got ${withStatic.score})`);
    assert.ok(withStatic.coverage > result.coverage, 'Coverage should be higher with static bundle present');
  });

  it('scoreHealthPublicService: physician density contributes to score', async () => {
    const makeReader = (physiciansPer1k: number) => async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        who: { indicators: {
          uhcIndex: { value: 75, year: 2024 },
          measlesCoverage: { value: 90, year: 2024 },
          hospitalBeds: { value: 3, year: 2024 },
          physiciansPer1k: { value: physiciansPer1k, year: 2024 },
          healthExpPerCapitaUsd: { value: 2000, year: 2024 },
        } },
      };
      return null;
    };
    const highDoc = await scoreHealthPublicService('XX', makeReader(4.5));
    const lowDoc = await scoreHealthPublicService('XX', makeReader(0.3));
    assert.ok(highDoc.score > lowDoc.score,
      `High physician density (${highDoc.score}) should score better than low (${lowDoc.score})`);
  });

  it('scoreHealthPublicService: health expenditure contributes to score', async () => {
    const makeReader = (healthExp: number) => async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return {
        who: { indicators: {
          uhcIndex: { value: 75, year: 2024 },
          measlesCoverage: { value: 90, year: 2024 },
          hospitalBeds: { value: 3, year: 2024 },
          physiciansPer1k: { value: 2.0, year: 2024 },
          healthExpPerCapitaUsd: { value: healthExp, year: 2024 },
        } },
      };
      return null;
    };
    const highExp = await scoreHealthPublicService('XX', makeReader(6000));
    const lowExp = await scoreHealthPublicService('XX', makeReader(100));
    assert.ok(highExp.score > lowExp.score,
      `High health expenditure (${highExp.score}) should score better than low (${lowExp.score})`);
  });
});

// T1.7 Phase 1 of the country-resilience reference-grade upgrade plan.
// Foundation-only slice: the 4-class imputation taxonomy (stable-absence,
// unmonitored, source-failure, not-applicable) is defined as an exported
// type, and every entry in the IMPUTATION and IMPUTE tables carries an
// imputationClass tag. These tests pin the classification so downstream
// work (T1.5 source-recency badges, T1.6 widget dimension confidence) can
// consume the taxonomy without risk of drift.
describe('resilience imputation taxonomy (T1.7)', () => {
  const VALID_CLASSES: readonly ImputationClass[] = [
    'stable-absence',
    'unmonitored',
    'source-failure',
    'not-applicable',
  ] as const;

  function assertValidClass(label: string, value: string): void {
    assert.ok(
      (VALID_CLASSES as readonly string[]).includes(value),
      `${label} has imputationClass="${value}", expected one of [${VALID_CLASSES.join(', ')}]`,
    );
  }

  it('IMPUTATION entries carry the expected semantic classes', () => {
    // Crisis-monitoring sources (IPC, UCDP, UNHCR) publish globally; absence
    // means the country is stable, so it is tagged stable-absence.
    assert.equal(IMPUTATION.crisis_monitoring_absent.imputationClass, 'stable-absence');
    assert.equal(IMPUTATION.crisis_monitoring_absent.score, 85);
    assert.equal(IMPUTATION.crisis_monitoring_absent.certaintyCoverage, 0.7);

    // Curated-list sources (BIS, WTO) may not cover every country; absence
    // is ambiguous, so it is tagged unmonitored.
    assert.equal(IMPUTATION.curated_list_absent.imputationClass, 'unmonitored');
    assert.equal(IMPUTATION.curated_list_absent.score, 50);
    assert.equal(IMPUTATION.curated_list_absent.certaintyCoverage, 0.3);
  });

  it('every IMPUTATION entry has a valid imputationClass', () => {
    for (const [key, entry] of Object.entries(IMPUTATION)) {
      assertValidClass(`IMPUTATION.${key}`, entry.imputationClass);
    }
  });

  it('IMPUTE per-metric overrides inherit or override the class consistently', () => {
    // Food-specific crisis-monitoring override (IPC phase data).
    assert.equal(IMPUTE.ipcFood.imputationClass, 'stable-absence');
    // Trade-specific curated-list override (WTO trade restrictions).
    assert.equal(IMPUTE.wtoData.imputationClass, 'unmonitored');
    // Displacement-specific crisis-monitoring override (UNHCR flows).
    assert.equal(IMPUTE.unhcrDisplacement.imputationClass, 'stable-absence');

    // Shared references: bisEer and bisCredit alias IMPUTATION.curated_list_absent
    // so their class must match exactly (same object reference, same tag).
    assert.equal(IMPUTE.bisEer.imputationClass, 'unmonitored');
    assert.equal(IMPUTE.bisCredit.imputationClass, 'unmonitored');
    assert.equal(IMPUTE.bisEer, IMPUTATION.curated_list_absent);
    assert.equal(IMPUTE.bisCredit, IMPUTATION.curated_list_absent);
  });

  it('every IMPUTE entry has a valid imputationClass', () => {
    for (const [key, entry] of Object.entries(IMPUTE)) {
      assertValidClass(`IMPUTE.${key}`, entry.imputationClass);
    }
  });

  it('stable-absence entries score higher than unmonitored, across BOTH tables (semantic sanity)', () => {
    // stable-absence = strong positive signal (feed is comprehensive,
    // nothing happened). unmonitored = we do not know, penalized.
    // The invariant must hold across every entry in both IMPUTATION and
    // IMPUTE, otherwise a per-metric override can silently break the
    // ordering (e.g. a `stable-absence` override with a score lower than
    // an `unmonitored` entry would pass a tables-only check but violate
    // the taxonomy's semantic meaning).
    //
    // Raised in review of PR #2944: the earlier version of this test
    // only checked the two base entries in IMPUTATION and would have
    // missed a regression in an IMPUTE override.
    const allEntries = [
      ...Object.entries(IMPUTATION).map(([k, v]) => ({ label: `IMPUTATION.${k}`, entry: v })),
      ...Object.entries(IMPUTE).map(([k, v]) => ({ label: `IMPUTE.${k}`, entry: v })),
    ];

    const stableAbsence = allEntries.filter((e) => e.entry.imputationClass === 'stable-absence');
    const unmonitored = allEntries.filter((e) => e.entry.imputationClass === 'unmonitored');

    assert.ok(stableAbsence.length > 0, 'expected at least one stable-absence entry across both tables');
    assert.ok(unmonitored.length > 0, 'expected at least one unmonitored entry across both tables');

    const minStableScore = Math.min(...stableAbsence.map((e) => e.entry.score));
    const maxUnmonitoredScore = Math.max(...unmonitored.map((e) => e.entry.score));
    assert.ok(
      minStableScore > maxUnmonitoredScore,
      `every stable-absence entry must score higher than every unmonitored entry. ` +
      `min stable-absence score = ${minStableScore}, max unmonitored score = ${maxUnmonitoredScore}. ` +
      `stable-absence entries: ${stableAbsence.map((e) => `${e.label}=${e.entry.score}`).join(', ')}. ` +
      `unmonitored entries: ${unmonitored.map((e) => `${e.label}=${e.entry.score}`).join(', ')}.`,
    );

    const minStableCertainty = Math.min(...stableAbsence.map((e) => e.entry.certaintyCoverage));
    const maxUnmonitoredCertainty = Math.max(...unmonitored.map((e) => e.entry.certaintyCoverage));
    assert.ok(
      minStableCertainty > maxUnmonitoredCertainty,
      `every stable-absence entry must have higher certaintyCoverage than every unmonitored entry. ` +
      `min stable-absence certainty = ${minStableCertainty}, max unmonitored certainty = ${maxUnmonitoredCertainty}. ` +
      `stable-absence entries: ${stableAbsence.map((e) => `${e.label}=${e.entry.certaintyCoverage}`).join(', ')}. ` +
      `unmonitored entries: ${unmonitored.map((e) => `${e.label}=${e.entry.certaintyCoverage}`).join(', ')}.`,
    );
  });
});

// T1.7 schema pass: imputationClass propagation through weightedBlend and
// the direct early-return paths that bypass weightedBlend (e.g.
// scoreCurrencyExternal when BIS EER is the only source). These tests use
// real scorers with crafted readers so weightedBlend's aggregation
// semantics are exercised without exporting it.
describe('resilience dimension imputationClass propagation (T1.7)', () => {
  it('single fully-imputed metric: foodWater reports stable-absence via IMPUTE.ipcFood', async () => {
    // resilience:static:{ISO2} loaded with fao:null and aquastat:null → the
    // IPC metric imputes (weight 0.6) and aquastat is null (weight 0.4).
    // availableWeight = 0.6, observed = 0, imputed = 0.6 → fully imputed,
    // dominant class is stable-absence (the only class present).
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return { fao: null, aquastat: null };
      return null;
    };
    const result = await scoreFoodWater('XX', reader);
    assert.equal(result.observedWeight, 0, 'no observed data');
    assert.ok(result.imputedWeight > 0, 'imputed data present');
    assert.equal(result.imputationClass, 'stable-absence',
      `foodWater should propagate stable-absence from IMPUTE.ipcFood, got ${result.imputationClass}`);
  });

  it('single fully-imputed metric: tradeSanctions reports unmonitored via IMPUTE.wtoData', async () => {
    // Non-reporter in WTO restrictions + barriers, no sanctions/tariff data.
    // Both imputed metrics share the unmonitored class.
    const reporterSet = ['US', 'DE'];
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [], _reporterCountries: reporterSet };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [], _reporterCountries: reporterSet };
      return null;
    };
    const result = await scoreTradeSanctions('BF', reader);
    assert.equal(result.observedWeight, 0, 'no observed data for BF in this reader');
    assert.ok(result.imputedWeight > 0, 'WTO imputation should produce imputed weight');
    assert.equal(result.imputationClass, 'unmonitored',
      `tradeSanctions should propagate unmonitored from IMPUTE.wtoData, got ${result.imputationClass}`);
  });

  it('observed + imputed: imputationClass is null when the dimension has any real data', async () => {
    // Mix: real sanctions data (observed) + WTO impute (imputed) → observedWeight > 0
    // means imputationClass must be null.
    const reporterSet = ['US'];
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'sanctions:country-counts:v1') return { BF: 2 };
      if (key === 'trade:restrictions:v1:tariff-overview:50') return { restrictions: [], _reporterCountries: reporterSet };
      if (key === 'trade:barriers:v1:tariff-gap:50') return { barriers: [], _reporterCountries: reporterSet };
      return null;
    };
    const result = await scoreTradeSanctions('BF', reader);
    assert.ok(result.observedWeight > 0, 'sanctions provide observed weight');
    assert.ok(result.imputedWeight > 0, 'WTO still imputes for non-reporter');
    assert.equal(result.imputationClass, null,
      `observed + imputed must yield null imputationClass, got ${result.imputationClass}`);
  });

  it('zero observed + zero imputed: imputationClass is null (true no-data case)', async () => {
    // cyberDigital with all sources null returns score=0 coverage=0 (no
    // data at all). This must not be mislabelled as an imputation class.
    const reader = async (_key: string): Promise<unknown | null> => null;
    const result = await scoreCyberDigital('XX', reader);
    assert.equal(result.observedWeight, 0);
    assert.equal(result.imputedWeight, 0);
    assert.equal(result.imputationClass, null,
      `no-data case must yield null imputationClass, got ${result.imputationClass}`);
  });

  it('scoreCurrencyExternal early-return: curated_list_absent propagates unmonitored', async () => {
    // BIS loaded but country not listed, IMF macro null, no reserves → the
    // function early-returns with IMPUTE.bisEer, which aliases
    // IMPUTATION.curated_list_absent → unmonitored.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'economic:bis:eer:v1') return { rates: [{ countryCode: 'US', realChange: 1.0, realEer: 100, date: '2025-09' }] };
      return null;
    };
    const result = await scoreCurrencyExternal('MZ', reader);
    assert.equal(result.observedWeight, 0);
    assert.equal(result.imputedWeight, 1);
    assert.equal(result.imputationClass, 'unmonitored',
      `scoreCurrencyExternal BIS-absent early return must propagate unmonitored, got ${result.imputationClass}`);
  });

  it('scoreBorderSecurity: UNHCR displacement absent propagates stable-absence', async () => {
    // UCDP loaded but zero events for XX, displacement loaded but country
    // absent → IMPUTE.unhcrDisplacement (stable-absence) on the 0.35
    // weight metric. The UCDP metric is observed (0 events → score != null),
    // which means the dimension still has observedWeight > 0 and the
    // imputationClass must be null.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'conflict:ucdp-events:v1') return { events: [] };
      if (key.startsWith('displacement:summary:v1')) return { summary: { countries: [] } };
      return null;
    };
    const result = await scoreBorderSecurity('XX', reader);
    assert.ok(result.observedWeight > 0, 'UCDP contributes observed weight');
    assert.equal(result.imputationClass, null,
      `observed + imputed mix must yield null imputationClass, got ${result.imputationClass}`);
  });

  it('scoreBorderSecurity: UCDP outage + displacement impute → fully imputed stable-absence', async () => {
    // UCDP source null (returns null score, excluded), displacement loaded
    // with country absent → only the imputed unhcrDisplacement metric
    // contributes. observedWeight = 0, imputedWeight > 0, dominant class
    // is stable-absence.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key.startsWith('displacement:summary:v1')) return { summary: { countries: [] } };
      return null;
    };
    const result = await scoreBorderSecurity('XX', reader);
    assert.equal(result.observedWeight, 0, 'UCDP null → no observed');
    assert.ok(result.imputedWeight > 0, 'displacement imputed');
    assert.equal(result.imputationClass, 'stable-absence',
      `borderSecurity with only displacement impute must be stable-absence, got ${result.imputationClass}`);
  });
});
