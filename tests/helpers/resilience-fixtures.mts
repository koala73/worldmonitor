export type FixtureMap = Record<string, unknown>;

export const RESILIENCE_FIXTURES: FixtureMap = {
  'resilience:static:NO': {
    wgi: {
      indicators: {
        VA: { value: 1.9, year: 2025 },
        PV: { value: 1.7, year: 2025 },
        GE: { value: 1.8, year: 2025 },
        RQ: { value: 1.9, year: 2025 },
        RL: { value: 1.8, year: 2025 },
        CC: { value: 1.9, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 100, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 90, year: 2025 },
        'EG.USE.ELEC.KH.PC': { value: 23000, year: 2025 },
        'IT.NET.BBND.P2': { value: 42, year: 2025 },
      },
    },
    gpi: { score: 1.5, rank: 12, year: 2025 },
    rsf: { score: 92, rank: 4, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 3.5, year: 2024 },
        uhcIndex: { value: 88, year: 2024 },
        measlesCoverage: { value: 97, year: 2024 },
        physiciansPer1k: { value: 5.0, year: 2024 },
        healthExpPerCapitaUsd: { value: 8000, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 10, phase: 'IPC Phase 1', year: 2025 },
    aquastat: { indicator: 'Renewable water availability', value: 4000, year: 2024 },
    iea: { energyImportDependency: { value: 15, year: 2024, source: 'IEA' } },
    tradeToGdp: { source: 'worldbank', tradeToGdpPct: 70, year: 2023 },
  },
  'resilience:static:US': {
    wgi: {
      indicators: {
        VA: { value: 0.9, year: 2025 },
        PV: { value: 0.6, year: 2025 },
        GE: { value: 1.1, year: 2025 },
        RQ: { value: 1.2, year: 2025 },
        RL: { value: 1.0, year: 2025 },
        CC: { value: 1.1, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 100, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 74, year: 2025 },
        'EG.USE.ELEC.KH.PC': { value: 12000, year: 2025 },
        'IT.NET.BBND.P2': { value: 35, year: 2025 },
      },
    },
    gpi: { score: 2.4, rank: 132, year: 2025 },
    rsf: { score: 70, rank: 45, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 2.8, year: 2024 },
        uhcIndex: { value: 82, year: 2024 },
        measlesCoverage: { value: 91, year: 2024 },
        physiciansPer1k: { value: 2.6, year: 2024 },
        healthExpPerCapitaUsd: { value: 12000, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 5000, phase: 'IPC Phase 2', year: 2025 },
    aquastat: { indicator: 'Renewable water availability', value: 1500, year: 2024 },
    iea: { energyImportDependency: { value: 25, year: 2024, source: 'IEA' } },
    tradeToGdp: { source: 'worldbank', tradeToGdpPct: 25, year: 2023 },
  },
  'resilience:static:YE': {
    wgi: {
      indicators: {
        VA: { value: -1.9, year: 2025 },
        PV: { value: -2.3, year: 2025 },
        GE: { value: -1.8, year: 2025 },
        RQ: { value: -1.7, year: 2025 },
        RL: { value: -2.0, year: 2025 },
        CC: { value: -2.1, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 60, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 20, year: 2025 },
        'EG.USE.ELEC.KH.PC': { value: 300, year: 2025 },
        'IT.NET.BBND.P2': { value: 1, year: 2025 },
      },
    },
    gpi: { score: 3.8, rank: 160, year: 2025 },
    rsf: { score: 25, rank: 150, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 0.7, year: 2024 },
        uhcIndex: { value: 45, year: 2024 },
        measlesCoverage: { value: 58, year: 2024 },
        physiciansPer1k: { value: 0.5, year: 2024 },
        healthExpPerCapitaUsd: { value: 100, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 2_000_000, phase: 'IPC Phase 4', year: 2025 },
    aquastat: { indicator: 'Water stress', value: 85, year: 2024 },
    iea: { energyImportDependency: { value: 95, year: 2024, source: 'IEA' } },
    tradeToGdp: { source: 'worldbank', tradeToGdpPct: 30, year: 2023 },
  },
  'energy:mix:v1:NO': {
    iso2: 'NO',
    country: 'Norway',
    year: 2023,
    coalShare: 0,
    gasShare: 5,
    oilShare: 0,
    nuclearShare: 0,
    renewShare: 97,
    windShare: 12,
    solarShare: 1,
    hydroShare: 84,
    importShare: -500,
    seededAt: '2026-04-04T00:00:00.000Z',
  },
  'energy:mix:v1:US': {
    iso2: 'US',
    country: 'United States',
    year: 2023,
    coalShare: 16,
    gasShare: 42,
    oilShare: 1,
    nuclearShare: 18,
    renewShare: 22,
    windShare: 11,
    solarShare: 5,
    hydroShare: 6,
    importShare: 5,
    seededAt: '2026-04-04T00:00:00.000Z',
  },
  'energy:mix:v1:YE': {
    iso2: 'YE',
    country: 'Yemen',
    year: 2023,
    coalShare: 0,
    gasShare: 0,
    oilShare: 85,
    nuclearShare: 0,
    renewShare: 2,
    windShare: 0,
    solarShare: 2,
    hydroShare: 0,
    importShare: 95,
    seededAt: '2026-04-04T00:00:00.000Z',
  },
  'economic:national-debt:v1': {
    entries: [
      { iso3: 'NOR', debtToGdp: 40, annualGrowth: 1 },
      { iso3: 'USA', debtToGdp: 120, annualGrowth: 6 },
      { iso3: 'YEM', debtToGdp: 180, annualGrowth: 12 },
    ],
  },
  // IMF WEO indicators: CPI inflation (PCPIPCH) and current account balance % GDP (BCA_NGDPD).
  // Covers ~185 sovereign states — replaces BIS credit (~40 economies) in scoreMacroFiscal,
  // and provides tier-2 currency stability proxy for non-BIS countries in scoreCurrencyExternal.
  'economic:imf:macro:v2': {
    countries: {
      // govRevenuePct = General Government Revenue % GDP (IMF GGR_NGDP).
      // Replaces debtToGdp as primary fiscal metric in scoreMacroFiscal — raw debt/GDP
      // is gamed by HIPC relief (Somalia 5% debt ≠ prudence; it reflects credit exclusion).
      NO: { inflationPct: 3.2, currentAccountPct: 20.0, govRevenuePct: 57.0, year: 2024 },
      US: { inflationPct: 3.5, currentAccountPct: -3.3, govRevenuePct: 33.0, year: 2024 },
      YE: { inflationPct: 22.0, currentAccountPct: -6.0, govRevenuePct: 8.0, year: 2024 },
    },
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
  // Full ISO2→entryCount map from sanctions:country-counts:v1 (all countries, no top-N truncation).
  'sanctions:country-counts:v1': { NO: 2, US: 45, YE: 180, LB: 30 },
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
    _reporterCountries: ['US', 'CN', 'DE', 'JP', 'GB', 'IN', 'BR', 'RU', 'KR', 'AU', 'CA', 'MX', 'FR', 'IT', 'NL'],
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
    _reporterCountries: ['US', 'CN', 'DE', 'JP', 'GB', 'IN', 'BR', 'RU', 'KR', 'AU', 'CA', 'MX', 'FR', 'IT', 'NL'],
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
      { country: 'United States', deathsBest: 8, violenceType: 'UCDP_VIOLENCE_TYPE_NON_STATE' },
      { country: 'Yemen', deathsBest: 120, violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED' },
      { country: 'Yemen', deathsBest: 70, violenceType: 'UCDP_VIOLENCE_TYPE_ONE_SIDED' },
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
    byCountry: {
      NO: { critical: 0, high: 0, medium: 0, low: 1 },
      US: { critical: 0, high: 2, medium: 4, low: 2 },
      YE: { critical: 4, high: 6, medium: 5, low: 1 },
    },
    generatedAt: '2026-04-06T00:00:00.000Z',
  },
  // Lebanon: used to test that null IEA (Eurostat EU-only) + crisis-level electricity
  // consumption produces an energy score < 50, not artificially high (~89 pre-fix).
  'resilience:static:LB': {
    wgi: {
      indicators: {
        'VA.EST': { value: -0.9, year: 2025 },
        'PV.EST': { value: -1.8, year: 2025 },
        'GE.EST': { value: -1.2, year: 2025 },
        'RQ.EST': { value: -1.0, year: 2025 },
        'RL.EST': { value: -1.1, year: 2025 },
        'CC.EST': { value: -1.3, year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: 99, year: 2025 },
        'IS.ROD.PAVE.ZS': { value: 85, year: 2025 },
        'EG.USE.ELEC.KH.PC': { value: 1200, year: 2024 },
        'IT.NET.BBND.P2': { value: 8, year: 2024 },
      },
    },
    gpi: { score: 2.9, rank: 108, year: 2025 },
    rsf: { score: 48, rank: 130, year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: 2.8, year: 2024 },
        uhcIndex: { value: 68, year: 2024 },
        measlesCoverage: { value: 72, year: 2024 },
      },
    },
    fao: { peopleInCrisis: 1_500_000, phase: 'IPC Phase 3', year: 2025 },
    aquastat: { indicator: 'Water stress', value: 72, year: 2024 },
    iea: null, // Eurostat is EU-only — Lebanon absent → energy import dependency unknown
    tradeToGdp: { source: 'worldbank', tradeToGdpPct: 95, year: 2023 },
  },
  'energy:mix:v1:LB': {
    iso2: 'LB',
    country: 'Lebanon',
    year: 2023,
    coalShare: 2,
    gasShare: 15,
    oilShare: 58,
    nuclearShare: 0,
    renewShare: 25,
    windShare: 1,
    solarShare: 24,
    hydroShare: 0,
    seededAt: '2026-04-04T00:00:00.000Z',
  },
  'resilience:static:index:v1': {
    countries: ['NO', 'US', 'YE'],
    recordCount: 3,
    failedDatasets: [],
    seedYear: 2025,
    seededAt: '2026-04-03T00:00:00.000Z',
    sourceVersion: 'resilience-static-v5',
  },
};

export function fixtureReader(key: string): Promise<unknown | null> {
  return Promise.resolve(RESILIENCE_FIXTURES[key] ?? null);
}
