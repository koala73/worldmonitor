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

type FixtureMap = Record<string, unknown>;

const FIXTURES: FixtureMap = {
  'resilience:static:NO': {
    wgi: {
      indicators: {
        'VA.EST': { value: 1.9, year: 2025 },
        'PV.EST': { value: 1.7, year: 2025 },
        'GE.EST': { value: 1.8, year: 2025 },
        'RQ.EST': { value: 1.9, year: 2025 },
        'RL.EST': { value: 1.8, year: 2025 },
        'CC.EST': { value: 1.9, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 100, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 90, year: 2025 },
      },
    },
    gpi: { score: 1.5, rank: 12, year: 2025 },
    rsf: { score: 92, rank: 4, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 3.5, year: 2024 },
        uhcIndex: { value: 88, year: 2024 },
        measlesCoverage: { value: 97, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 10, phase: 'IPC Phase 1', year: 2025 },
    aquastat: { indicator: 'Renewable water availability', value: 4000, year: 2024 },
    iea: { energyImportDependency: { value: 15, year: 2024, source: 'IEA' } },
  },
  'resilience:static:US': {
    wgi: {
      indicators: {
        'VA.EST': { value: 0.9, year: 2025 },
        'PV.EST': { value: 0.6, year: 2025 },
        'GE.EST': { value: 1.1, year: 2025 },
        'RQ.EST': { value: 1.2, year: 2025 },
        'RL.EST': { value: 1.0, year: 2025 },
        'CC.EST': { value: 1.1, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 100, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 74, year: 2025 },
      },
    },
    gpi: { score: 2.4, rank: 132, year: 2025 },
    rsf: { score: 70, rank: 45, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 2.8, year: 2024 },
        uhcIndex: { value: 82, year: 2024 },
        measlesCoverage: { value: 91, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 5000, phase: 'IPC Phase 2', year: 2025 },
    aquastat: { indicator: 'Renewable water availability', value: 1500, year: 2024 },
    iea: { energyImportDependency: { value: 25, year: 2024, source: 'IEA' } },
  },
  'resilience:static:YE': {
    wgi: {
      indicators: {
        'VA.EST': { value: -1.9, year: 2025 },
        'PV.EST': { value: -2.3, year: 2025 },
        'GE.EST': { value: -1.8, year: 2025 },
        'RQ.EST': { value: -1.7, year: 2025 },
        'RL.EST': { value: -2.0, year: 2025 },
        'CC.EST': { value: -2.1, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 60, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 20, year: 2025 },
      },
    },
    gpi: { score: 3.8, rank: 160, year: 2025 },
    rsf: { score: 25, rank: 150, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 0.7, year: 2024 },
        uhcIndex: { value: 45, year: 2024 },
        measlesCoverage: { value: 58, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 2_000_000, phase: 'IPC Phase 4', year: 2025 },
    aquastat: { indicator: 'Water stress', value: 85, year: 2024 },
    iea: { energyImportDependency: { value: 95, year: 2024, source: 'IEA' } },
  },
  'economic:national-debt:v1': {
    entries: [
      { iso3: 'NOR', debtToGdp: 40, annualGrowth: 1 },
      { iso3: 'USA', debtToGdp: 120, annualGrowth: 6 },
      { iso3: 'YEM', debtToGdp: 180, annualGrowth: 12 },
    ],
  },
  'economic:bis:credit:v1': {
    entries: [
      { countryCode: 'NO', creditGdpRatio: 85 },
      { countryCode: 'US', creditGdpRatio: 150 },
      { countryCode: 'YE', creditGdpRatio: 220 },
    ],
  },
  'economic:bis:eer:v1': {
    rates: [
      { countryCode: 'NO', realChange: 1.0, realEer: 100, date: '2025-08' },
      { countryCode: 'NO', realChange: -0.5, realEer: 101, date: '2025-09' },
      { countryCode: 'NO', realChange: 0.8, realEer: 102, date: '2025-10' },
      { countryCode: 'NO', realChange: -0.6, realEer: 101, date: '2025-11' },
      { countryCode: 'US', realChange: 2.0, realEer: 104, date: '2025-08' },
      { countryCode: 'US', realChange: -4.0, realEer: 108, date: '2025-09' },
      { countryCode: 'US', realChange: 3.0, realEer: 106, date: '2025-10' },
      { countryCode: 'US', realChange: -3.0, realEer: 110, date: '2025-11' },
      { countryCode: 'YE', realChange: 12.0, realEer: 120, date: '2025-08' },
      { countryCode: 'YE', realChange: -15.0, realEer: 128, date: '2025-09' },
      { countryCode: 'YE', realChange: 20.0, realEer: 135, date: '2025-10' },
      { countryCode: 'YE', realChange: -18.0, realEer: 145, date: '2025-11' },
    ],
  },
  'sanctions:pressure:v1': {
    countries: [
      { countryCode: 'NO', countryName: 'Norway', entryCount: 0, newEntryCount: 0, vesselCount: 0, aircraftCount: 0 },
      { countryCode: 'US', countryName: 'United States', entryCount: 40, newEntryCount: 4, vesselCount: 2, aircraftCount: 1 },
      { countryCode: 'YE', countryName: 'Yemen', entryCount: 160, newEntryCount: 8, vesselCount: 10, aircraftCount: 6 },
    ],
  },
  'trade:restrictions:v1:tariff-overview:50': {
    restrictions: [
      { reportingCountry: 'United States', status: 'IN_FORCE' },
      { reportingCountry: 'United States', status: 'IN_FORCE' },
      { affectedCountry: 'United States', status: 'PLANNED' },
      { reportingCountry: 'Yemen', status: 'IN_FORCE' },
      { reportingCountry: 'Yemen', status: 'IN_FORCE' },
      { reportingCountry: 'Yemen', status: 'IN_FORCE' },
      { affectedCountry: 'Yemen', status: 'PLANNED' },
      { affectedCountry: 'Yemen', status: 'PLANNED' },
    ],
  },
  'trade:barriers:v1:tariff-gap:50': {
    barriers: [
      { notifyingCountry: 'United States' },
      { notifyingCountry: 'United States' },
      { notifyingCountry: 'United States' },
      { notifyingCountry: 'Yemen' },
      { notifyingCountry: 'Yemen' },
      { notifyingCountry: 'Yemen' },
      { notifyingCountry: 'Yemen' },
      { notifyingCountry: 'Yemen' },
      { notifyingCountry: 'Yemen' },
    ],
  },
  'cyber:threats:v2': {
    threats: [
      { country: 'Norway', severity: 'CRITICALITY_LEVEL_LOW' },
      { country: 'United States', severity: 'CRITICALITY_LEVEL_CRITICAL' },
      { country: 'United States', severity: 'CRITICALITY_LEVEL_HIGH' },
      { country: 'United States', severity: 'CRITICALITY_LEVEL_HIGH' },
      { country: 'United States', severity: 'CRITICALITY_LEVEL_MEDIUM' },
      { country: 'United States', severity: 'CRITICALITY_LEVEL_MEDIUM' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_CRITICAL' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_CRITICAL' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_CRITICAL' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_HIGH' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_HIGH' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_HIGH' },
      { country: 'Yemen', severity: 'CRITICALITY_LEVEL_MEDIUM' },
    ],
  },
  'infra:outages:v1': {
    outages: [
      { countryCode: 'US', severity: 'OUTAGE_SEVERITY_MAJOR' },
      { countryCode: 'US', severity: 'OUTAGE_SEVERITY_MAJOR' },
      { countryCode: 'US', severity: 'OUTAGE_SEVERITY_PARTIAL' },
      { countryCode: 'YE', severity: 'OUTAGE_SEVERITY_TOTAL' },
      { countryCode: 'YE', severity: 'OUTAGE_SEVERITY_TOTAL' },
      { countryCode: 'YE', severity: 'OUTAGE_SEVERITY_MAJOR' },
      { countryCode: 'YE', severity: 'OUTAGE_SEVERITY_PARTIAL' },
    ],
  },
  'intelligence:gpsjam:v2': {
    hexes: [
      { countryCode: 'US', level: 'medium' },
      { countryCode: 'US', level: 'medium' },
      { countryCode: 'YE', level: 'high' },
      { countryCode: 'YE', level: 'high' },
      { countryCode: 'YE', level: 'high' },
      { countryCode: 'YE', level: 'medium' },
    ],
  },
  'supply_chain:shipping_stress:v1': {
    stressScore: 35,
  },
  'supply_chain:transit-summaries:v1': {
    summaries: {
      suez: { disruptionPct: 6, incidentCount7d: 4 },
      panama: { disruptionPct: 4, incidentCount7d: 1 },
    },
  },
  'economic:energy:v1:all': {
    prices: [
      { change: 5 },
      { change: -8 },
      { change: 7 },
      { change: 9 },
    ],
  },
  'unrest:events:v1': {
    events: [
      { country: 'United States', severity: 'EVENT_SEVERITY_MEDIUM', fatalities: 1 },
      { country: 'United States', severity: 'EVENT_SEVERITY_HIGH', fatalities: 3 },
      { country: 'Yemen', severity: 'EVENT_SEVERITY_HIGH', fatalities: 18 },
      { country: 'Yemen', severity: 'EVENT_SEVERITY_HIGH', fatalities: 9 },
      { country: 'Yemen', severity: 'EVENT_SEVERITY_MEDIUM', fatalities: 4 },
    ],
  },
  'conflict:ucdp-events:v1': {
    events: [
      { country: 'Yemen', deathsBest: 120, violenceType: 'VIOLENCE_TYPE_STATE_BASED' },
      { country: 'Yemen', deathsBest: 70, violenceType: 'VIOLENCE_TYPE_ONE_SIDED' },
    ],
  },
  [`displacement:summary:v1:${new Date().getFullYear()}`]: {
    summary: {
      countries: [
        { code: 'NO', totalDisplaced: 5_000, hostTotal: 2_000 },
        { code: 'US', totalDisplaced: 100_000, hostTotal: 10_000 },
        { code: 'YE', totalDisplaced: 4_000_000, hostTotal: 500_000 },
      ],
    },
  },
  'intelligence:social:reddit:v1': {
    posts: [
      { title: 'Norway grid resilience remains strong', velocityScore: 5 },
      { title: 'United States election unrest concerns rise again', velocityScore: 25 },
      { title: 'United States cyber incident response under pressure', velocityScore: 18 },
      { title: 'Yemen crisis worsens as conflict expands', velocityScore: 80 },
      { title: 'Yemen aid access collapses amid strikes', velocityScore: 65 },
    ],
  },
  'news:threat:summary:v1': {
    NO: { critical: 0, high: 0, medium: 0, low: 1 },
    US: { critical: 0, high: 2, medium: 4, low: 2 },
    YE: { critical: 4, high: 6, medium: 5, low: 1 },
  },
};

function fixtureReader(key: string): Promise<unknown | null> {
  return Promise.resolve(FIXTURES[key] ?? null);
}

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
  assert.ok(no > us, `${label}: expected NO (${no}) > US (${us})`);
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

  it('memoizes repeated seed reads inside scoreAllDimensions', async () => {
    const hits = new Map<string, number>();
    const countingReader = async (key: string) => {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return FIXTURES[key] ?? null;
    };

    await scoreAllDimensions('US', countingReader);

    for (const [key, count] of hits.entries()) {
      assert.equal(count, 1, `expected ${key} to be read once, got ${count}`);
    }
  });
});
