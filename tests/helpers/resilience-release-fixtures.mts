import countryNames from '../../shared/country-names.json';
import iso2ToIso3 from '../../shared/iso2-to-iso3.json';

export const G20_COUNTRIES = [
  'AR', 'AU', 'BR', 'CA', 'CN', 'DE', 'FR', 'GB', 'ID', 'IN',
  'IT', 'JP', 'KR', 'MX', 'RU', 'SA', 'TR', 'US', 'ZA',
] as const;

export const EU27_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const;

export const RELEASE_GATE_COUNTRIES = [
  ...new Set([
    ...G20_COUNTRIES,
    ...EU27_COUNTRIES,
    'CH',
    'ER',
    'HT',
    'LB',
    'NG',
    'NO',
    'SO',
    'SS',
    'YE',
  ]),
] as const;

type CountryProfile = 'elite' | 'strong' | 'stressed' | 'fragile' | 'sparse_fragile';

interface CountryDescriptor {
  code: string;
  name: string;
  iso3: string;
  profile: CountryProfile;
}

interface ReleaseGateFixtureMap {
  [key: string]: unknown;
}

const ISO2_TO_NAME = new Map<string, string>();
for (const [name, code] of Object.entries(countryNames as Record<string, string>)) {
  const iso2 = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2) || ISO2_TO_NAME.has(iso2)) continue;
  ISO2_TO_NAME.set(iso2, name);
}

const NAME_OVERRIDES: Record<string, string> = {
  GB: 'United Kingdom',
  KR: 'South Korea',
  RU: 'Russia',
  US: 'United States',
};

const PROFILE_BY_COUNTRY: Record<string, CountryProfile> = {
  NO: 'elite',
  CH: 'elite',
  DK: 'elite',
  AU: 'strong',
  AT: 'strong',
  BE: 'strong',
  BG: 'strong',
  CA: 'strong',
  CY: 'strong',
  CZ: 'strong',
  DE: 'strong',
  EE: 'strong',
  ES: 'strong',
  FI: 'elite',
  FR: 'strong',
  GB: 'strong',
  GR: 'strong',
  HR: 'strong',
  HU: 'strong',
  IE: 'elite',
  IT: 'strong',
  JP: 'strong',
  KR: 'strong',
  LT: 'strong',
  LU: 'elite',
  LV: 'strong',
  MT: 'strong',
  NL: 'elite',
  PL: 'strong',
  PT: 'strong',
  RO: 'strong',
  SE: 'elite',
  SI: 'strong',
  SK: 'strong',
  US: 'strong',
  AR: 'stressed',
  BR: 'stressed',
  CN: 'stressed',
  ID: 'stressed',
  IN: 'stressed',
  MX: 'stressed',
  NG: 'stressed',
  SA: 'stressed',
  TR: 'stressed',
  ZA: 'stressed',
  LB: 'fragile',
  RU: 'fragile',
  YE: 'fragile',
  SO: 'fragile',
  HT: 'fragile',
  SS: 'sparse_fragile',
  ER: 'sparse_fragile',
};

function qualityFor(profile: CountryProfile): number {
  switch (profile) {
    case 'elite':
      return 90;
    case 'strong':
      return 76;
    case 'stressed':
      return 52;
    case 'fragile':
      return 18;
    case 'sparse_fragile':
      return 16;
  }
}

function round(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function descriptorFor(code: string): CountryDescriptor {
  const upper = code.toUpperCase();
  const iso3 = (iso2ToIso3 as Record<string, string>)[upper];
  if (!iso3) {
    throw new Error(`Missing ISO3 mapping for ${upper}`);
  }

  const name = NAME_OVERRIDES[upper] ?? ISO2_TO_NAME.get(upper);
  if (!name) {
    throw new Error(`Missing country name for ${upper}`);
  }

  const profile = PROFILE_BY_COUNTRY[upper];
  if (!profile) {
    throw new Error(`Missing release-gate profile for ${upper}`);
  }

  return { code: upper, iso3, name, profile };
}

function buildStaticRecord(descriptor: CountryDescriptor) {
  const quality = qualityFor(descriptor.profile);
  const stressed = 100 - quality;

  if (descriptor.profile === 'sparse_fragile') {
    return {
      wgi: null,
      infrastructure: null,
      gpi: null,
      rsf: null,
      who: null,
      fao: null,
      aquastat: null,
      iea: null,
      coverage: { availableDatasets: 0, totalDatasets: 8, ratio: 0 },
      seedYear: 2025,
      seededAt: '2026-04-04T00:00:00.000Z',
    };
  }

  return {
    wgi: {
      indicators: {
        'VA.EST': { value: round(-2.2 + quality * 0.045, 2), year: 2025 },
        'PV.EST': { value: round(-2.4 + quality * 0.045, 2), year: 2025 },
        'GE.EST': { value: round(-2.1 + quality * 0.044, 2), year: 2025 },
        'RQ.EST': { value: round(-2.0 + quality * 0.043, 2), year: 2025 },
        'RL.EST': { value: round(-2.2 + quality * 0.044, 2), year: 2025 },
        'CC.EST': { value: round(-2.3 + quality * 0.045, 2), year: 2025 },
      },
    },
    infrastructure: {
      indicators: {
        'EG.ELC.ACCS.ZS': { value: round(clamp(30 + quality * 0.78, 35, 100)), year: 2025 },
        'IS.ROD.PAVE.ZS': { value: round(clamp(10 + quality * 0.88, 8, 100)), year: 2025 },
        // Exponential scale: fragile (~600 kWh) → stressed (~2200) → strong (~8000) → elite (~9500)
        // Reflects that energy consumption per capita collapses in conflict/crisis states.
        'EG.USE.ELEC.KH.PC': { value: Math.round(300 * 10 ** (quality / 60)), year: 2025 },
      },
    },
    gpi: { score: round(clamp(4.1 - quality * 0.03, 1.2, 4.2), 2), rank: Math.round(190 - quality * 1.5), year: 2025 },
    rsf: { score: round(clamp(8 + quality * 0.92, 10, 95), 1), rank: Math.round(180 - quality * 1.6), year: 2025 },
    who: {
      indicators: {
        hospitalBeds: { value: round(clamp(0.2 + quality * 0.045, 0.3, 8), 1), year: 2024 },
        uhcIndex: { value: round(clamp(25 + quality * 0.7, 25, 90)), year: 2024 },
        measlesCoverage: { value: round(clamp(35 + quality * 0.67, 35, 99)), year: 2024 },
      },
    },
    fao: {
      peopleInCrisis: Math.round(10 ** clamp(7 - quality / 20, 1.7, 6.6)),
      phase: `IPC Phase ${Math.round(clamp(5 - quality / 25, 1, 5))}`,
      year: 2025,
    },
    aquastat: descriptor.profile === 'fragile'
      ? { indicator: 'Water stress', value: round(clamp(100 - quality * 0.5, 45, 98)), year: 2024 }
      : { indicator: 'Renewable water availability', value: round(clamp(300 + quality * 42, 300, 5000)), year: 2024 },
    iea: {
      energyImportDependency: {
        value: round(clamp(100 - quality * 0.9, -20, 98), 1),
        year: 2024,
        source: 'release-gate-fixture',
      },
    },
    coverage: { availableDatasets: 8, totalDatasets: 8, ratio: 1 },
    seedYear: 2025,
    seededAt: '2026-04-04T00:00:00.000Z',
  };
}

function buildReleaseGateCountries(): CountryDescriptor[] {
  return [...RELEASE_GATE_COUNTRIES].map((code) => descriptorFor(code));
}

export function buildReleaseGateFixtures(): ReleaseGateFixtureMap {
  const descriptors = buildReleaseGateCountries();
  const fixtures: ReleaseGateFixtureMap = {
    'resilience:static:index:v1': {
      countries: descriptors.map(({ code }) => code).sort(),
      recordCount: descriptors.length,
      failedDatasets: [],
      seedYear: 2025,
      seededAt: '2026-04-04T00:00:00.000Z',
      sourceVersion: 'resilience-static-v2',
    },
    'supply_chain:shipping_stress:v1': { stressScore: 18 },
    'supply_chain:transit-summaries:v1': {
      summaries: {
        suez: { disruptionPct: 2, incidentCount7d: 1 },
        panama: { disruptionPct: 1, incidentCount7d: 0 },
      },
    },
    'economic:energy:v1:all': {
      prices: [{ change: 2 }, { change: -3 }, { change: 1.5 }, { change: -2.5 }],
    },
  };

  const debtEntries: Array<Record<string, unknown>> = [];
  const bisCreditEntries: Array<Record<string, unknown>> = [];
  const bisExchangeRates: Array<Record<string, unknown>> = [];
  const sanctionsCountries: Array<Record<string, unknown>> = [];
  const tradeRestrictions: Array<Record<string, unknown>> = [];
  const tradeBarriers: Array<Record<string, unknown>> = [];
  const cyberThreats: Array<Record<string, unknown>> = [];
  const outages: Array<Record<string, unknown>> = [];
  const gpsHexes: Array<Record<string, unknown>> = [];
  const unrestEvents: Array<Record<string, unknown>> = [];
  const ucdpEvents: Array<Record<string, unknown>> = [];
  const displacementCountries: Array<Record<string, unknown>> = [];
  const socialPosts: Array<Record<string, unknown>> = [];
  const threatSummary: Record<string, Record<string, number>> = {};

  for (const descriptor of descriptors) {
    const quality = qualityFor(descriptor.profile);
    const stressed = 100 - quality;

    fixtures[`resilience:static:${descriptor.code}`] = buildStaticRecord(descriptor);

    debtEntries.push({
      iso3: descriptor.iso3,
      debtToGdp: round(clamp(230 - quality * 1.9, 25, 220), 1),
      annualGrowth: round(clamp(14 - quality * 0.13, 0.5, 16), 1),
    });

    bisCreditEntries.push({
      countryCode: descriptor.code,
      creditGdpRatio: round(clamp(260 - quality * 1.8, 55, 245), 1),
    });

    const exchangeBase = 100 + round((quality - 60) * 0.12, 1);
    const amplitude = round(clamp((100 - quality) / 12 + 0.7, 0.8, 8.5), 1);
    bisExchangeRates.push(
      { countryCode: descriptor.code, realChange: amplitude * 0.7, realEer: exchangeBase, date: '2025-08' },
      { countryCode: descriptor.code, realChange: -amplitude, realEer: exchangeBase + amplitude, date: '2025-09' },
      { countryCode: descriptor.code, realChange: amplitude * 0.6, realEer: exchangeBase - amplitude * 0.5, date: '2025-10' },
      { countryCode: descriptor.code, realChange: -amplitude * 0.8, realEer: exchangeBase + amplitude * 0.4, date: '2025-11' },
    );

    sanctionsCountries.push({
      countryCode: descriptor.code,
      countryName: descriptor.name,
      entryCount: Math.round(clamp(stressed * 1.1, 0, 170)),
      newEntryCount: Math.round(clamp(stressed / 18, 0, 8)),
      vesselCount: Math.round(clamp(stressed / 15, 0, 10)),
      aircraftCount: Math.round(clamp(stressed / 20, 0, 6)),
    });

    const inForceCount = Math.max(0, Math.round(stressed / 18));
    const plannedCount = Math.max(0, Math.round(stressed / 28));
    for (let index = 0; index < inForceCount; index += 1) {
      tradeRestrictions.push({ reportingCountry: descriptor.name, status: 'IN_FORCE' });
    }
    for (let index = 0; index < plannedCount; index += 1) {
      tradeRestrictions.push({ affectedCountry: descriptor.name, status: 'PLANNED' });
    }
    for (let index = 0; index < Math.max(0, Math.round(stressed / 14)); index += 1) {
      tradeBarriers.push({ notifyingCountry: descriptor.name });
    }

    const criticalThreats = Math.max(0, Math.round(stressed / 20));
    const highThreats = Math.max(0, Math.round(stressed / 18));
    const mediumThreats = Math.max(1, Math.round(stressed / 14));
    for (let index = 0; index < criticalThreats; index += 1) {
      cyberThreats.push({ country: descriptor.name, severity: 'CRITICALITY_LEVEL_CRITICAL' });
    }
    for (let index = 0; index < highThreats; index += 1) {
      cyberThreats.push({ country: descriptor.name, severity: 'CRITICALITY_LEVEL_HIGH' });
    }
    for (let index = 0; index < mediumThreats; index += 1) {
      cyberThreats.push({ country: descriptor.name, severity: 'CRITICALITY_LEVEL_MEDIUM' });
    }

    const totalOutages = Math.max(0, Math.round(stressed / 28));
    const majorOutages = Math.max(0, Math.round(stressed / 18));
    const partialOutages = Math.max(0, Math.round(stressed / 12));
    for (let index = 0; index < totalOutages; index += 1) {
      outages.push({ countryCode: descriptor.code, severity: 'OUTAGE_SEVERITY_TOTAL' });
    }
    for (let index = 0; index < majorOutages; index += 1) {
      outages.push({ countryCode: descriptor.code, severity: 'OUTAGE_SEVERITY_MAJOR' });
    }
    for (let index = 0; index < partialOutages; index += 1) {
      outages.push({ countryCode: descriptor.code, severity: 'OUTAGE_SEVERITY_PARTIAL' });
    }

    const gpsHigh = Math.max(0, Math.round(stressed / 22));
    const gpsMedium = Math.max(0, Math.round(stressed / 12));
    for (let index = 0; index < gpsHigh; index += 1) {
      gpsHexes.push({ countryCode: descriptor.code, level: 'high' });
    }
    for (let index = 0; index < gpsMedium; index += 1) {
      gpsHexes.push({ countryCode: descriptor.code, level: 'medium' });
    }

    const unrestCount = Math.max(0, Math.round(stressed / 16));
    if (unrestCount === 0) {
      unrestEvents.push({ country: descriptor.name, severity: 'EVENT_SEVERITY_LOW', fatalities: 0 });
    } else {
      for (let index = 0; index < unrestCount; index += 1) {
        unrestEvents.push({
          country: descriptor.name,
          severity: index === 0 && stressed > 45 ? 'EVENT_SEVERITY_HIGH' : 'EVENT_SEVERITY_MEDIUM',
          fatalities: Math.round(clamp(stressed / 8, 0, 25)),
        });
      }
    }

    const conflictEvents = Math.max(0, Math.round(stressed / 16));
    for (let index = 0; index < conflictEvents; index += 1) {
      ucdpEvents.push({
        country: descriptor.name,
        deathsBest: Math.round(clamp(stressed * 2.3, 5, 220)),
        violenceType: index % 2 === 0 ? 'UCDP_VIOLENCE_TYPE_STATE_BASED' : 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
      });
    }

    displacementCountries.push({
      code: descriptor.code,
      totalDisplaced: Math.round(10 ** clamp(7 - quality / 20, 2, 6.5)),
      hostTotal: Math.round(10 ** clamp(6.3 - quality / 22, 1.8, 5.8)),
    });

    socialPosts.push(
      { title: `${descriptor.name} resilience watch`, velocityScore: round(clamp(stressed / 2.5, 1, 80), 1) },
      { title: `${descriptor.name} infrastructure stability update`, velocityScore: round(clamp(stressed / 3.2, 1, 65), 1) },
    );

    threatSummary[descriptor.code] = {
      critical: Math.max(0, Math.round(stressed / 24)),
      high: Math.max(0, Math.round(stressed / 16)),
      medium: Math.max(1, Math.round(stressed / 12)),
      low: Math.max(1, Math.round((100 - stressed) / 30)),
    };
  }

  fixtures['economic:national-debt:v1'] = { entries: debtEntries };
  fixtures['economic:bis:credit:v1'] = { entries: bisCreditEntries };
  fixtures['economic:bis:eer:v1'] = { rates: bisExchangeRates };
  fixtures['sanctions:pressure:v1'] = { countries: sanctionsCountries };
  fixtures['trade:restrictions:v1:tariff-overview:50'] = { restrictions: tradeRestrictions };
  fixtures['trade:barriers:v1:tariff-gap:50'] = { barriers: tradeBarriers };
  fixtures['cyber:threats:v2'] = { threats: cyberThreats };
  fixtures['infra:outages:v1'] = { outages };
  fixtures['intelligence:gpsjam:v2'] = { hexes: gpsHexes };
  fixtures['unrest:events:v1'] = { events: unrestEvents };
  fixtures['conflict:ucdp-events:v1'] = { events: ucdpEvents };
  fixtures[`displacement:summary:v1:${new Date().getFullYear()}`] = { summary: { countries: displacementCountries } };
  fixtures['intelligence:social:reddit:v1'] = { posts: socialPosts };
  fixtures['news:threat:summary:v1'] = threatSummary;

  return fixtures;
}
