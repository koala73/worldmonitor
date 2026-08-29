import { SCORECARD_INPUT_REGISTRY } from './_input-registry.mts';
import type {
  AvailableScorecardEvidence,
  CountryScorecardEvidence,
  ScorecardEvidence,
  ScorecardInputId,
  SourceObservation,
} from './_types.mts';

export const SCORECARD_COMMODITY_KCAL_PER_KG = {
  wheat: 3340,
  corn: 3650,
  rice: 3600,
  soybeans: 1470,
  barley: 3320,
  palmOil: 8840,
} as const;

type JsonRecord = Record<string, unknown>;

export type ScorecardSourceSnapshots = {
  population: unknown;
  foodStocks: unknown;
  demographics: unknown;
  defense: unknown;
  energyMix: unknown;
  staticByCountry: Record<string, unknown> | null;
  lowCarbon: unknown;
  powerLosses: unknown;
  importHhi: unknown;
  techByIso2: Record<string, unknown> | null;
};

const asRecord = (value: unknown): JsonRecord | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

const finite = (value: unknown): number | null => {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const year = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200 ? numeric : null;
};

function sourceUnavailable(inputId: ScorecardInputId, source: string): ScorecardEvidence {
  return {
    availability: 'unavailable',
    inputId,
    reason: 'source-unavailable',
    source,
    sourceKey: SCORECARD_INPUT_REGISTRY[inputId].sourceKey,
  };
}

function countryUnavailable(inputId: ScorecardInputId, source: string): ScorecardEvidence {
  return {
    availability: 'unavailable',
    inputId,
    reason: 'country-unavailable',
    source,
    sourceKey: SCORECARD_INPUT_REGISTRY[inputId].sourceKey,
  };
}

function available(
  inputId: ScorecardInputId,
  value: unknown,
  observationYear: unknown,
  source: string,
  observations: SourceObservation[],
  options: Pick<AvailableScorecardEvidence, 'aggregation' | 'quality'> = {},
): ScorecardEvidence {
  const numeric = finite(value);
  const validYear = year(observationYear);
  if (numeric == null || validYear == null) {
    return {
      availability: 'unavailable',
      inputId,
      reason: 'invalid-value',
      source,
      sourceKey: SCORECARD_INPUT_REGISTRY[inputId].sourceKey,
    };
  }
  return {
    availability: 'available',
    inputId,
    value: numeric,
    year: validYear,
    unit: SCORECARD_INPUT_REGISTRY[inputId].unit,
    source,
    sourceKey: SCORECARD_INPUT_REGISTRY[inputId].sourceKey,
    observations,
    ...options,
  };
}

function oneObservation(
  inputId: ScorecardInputId,
  metric: unknown,
  name: string,
  fallbackSource: string,
  indicatorCode?: string,
): ScorecardEvidence {
  const row = asRecord(metric);
  if (!row) return countryUnavailable(inputId, fallbackSource);
  const numeric = finite(row.value);
  const observationYear = year(row.year);
  const source = String(row.source || fallbackSource);
  if (numeric == null || observationYear == null) return available(inputId, row.value, row.year, source, []);
  return available(inputId, numeric, observationYear, source, [{
    name,
    value: numeric,
    year: observationYear,
    unit: String(row.unit || SCORECARD_INPUT_REGISTRY[inputId].unit),
    source,
    ...(row.indicatorCode || indicatorCode ? { indicatorCode: String(row.indicatorCode || indicatorCode) } : {}),
  }]);
}

function readCountry(source: unknown, countryCode: string): JsonRecord | null {
  const sourceRecord = asRecord(source);
  const countries = asRecord(sourceRecord?.countries);
  return asRecord(countries?.[countryCode] ?? sourceRecord?.[countryCode]);
}

function parseMarketingYear(value: unknown): number | null {
  const match = /^(\d{4})/.exec(String(value || ''));
  return match ? year(match[1]) : null;
}

function foodEvidence(countryCode: string, source: unknown): Pick<CountryScorecardEvidence['inputs'], 'food.productionBalance' | 'food.stocksToUse'> {
  if (!source) {
    return {
      'food.productionBalance': sourceUnavailable('food.productionBalance', 'USDA PSD / FAOSTAT'),
      'food.stocksToUse': sourceUnavailable('food.stocksToUse', 'USDA PSD / FAOSTAT'),
    };
  }
  const country = readCountry(source, countryCode);
  if (!country) {
    return {
      'food.productionBalance': countryUnavailable('food.productionBalance', 'USDA PSD / FAOSTAT'),
      'food.stocksToUse': countryUnavailable('food.stocksToUse', 'USDA PSD / FAOSTAT'),
    };
  }
  let production = 0;
  let consumption = 0;
  let endingStocks = 0;
  let totalUse = 0;
  let productionYear = 0;
  let stocksYear = 0;
  let observed = 0;
  for (const [commodity, rawRecord] of Object.entries(asRecord(country.commodities) ?? {})) {
    const record = asRecord(rawRecord);
    const kcal = SCORECARD_COMMODITY_KCAL_PER_KG[commodity as keyof typeof SCORECARD_COMMODITY_KCAL_PER_KG];
    if (!kcal || !record) continue;
    const commodityYear = parseMarketingYear(record.marketingYear);
    const commodityProduction = finite(record.production);
    const commodityConsumption = finite(record.consumption);
    const commodityExports = finite(record.exports) ?? 0;
    const commodityStocks = finite(record.endingStocks);
    if (commodityYear != null && commodityProduction != null && commodityConsumption != null) {
      production += commodityProduction * kcal / 1000;
      consumption += commodityConsumption * kcal / 1000;
      observed += 1;
      productionYear = Math.max(productionYear, commodityYear);
    }
    if (commodityYear != null && commodityStocks != null && commodityConsumption != null) {
      endingStocks += commodityStocks * kcal / 1000;
      totalUse += (commodityConsumption + commodityExports) * kcal / 1000;
      stocksYear = Math.max(stocksYear, commodityYear);
    }
  }
  if (observed === 0 || consumption <= 0 || productionYear === 0) {
    return {
      'food.productionBalance': countryUnavailable('food.productionBalance', 'USDA PSD / FAOSTAT'),
      'food.stocksToUse': countryUnavailable('food.stocksToUse', 'USDA PSD / FAOSTAT'),
    };
  }
  const productionObservations: SourceObservation[] = [
    { name: 'calorieProduction', value: production, year: productionYear, unit: 'trillion kcal', source: 'USDA PSD / FAOSTAT' },
    { name: 'calorieConsumption', value: consumption, year: productionYear, unit: 'trillion kcal', source: 'USDA PSD / FAOSTAT' },
  ];
  return {
    'food.productionBalance': available(
      'food.productionBalance',
      production / consumption,
      productionYear,
      'USDA PSD / FAOSTAT',
      productionObservations,
      { aggregation: { numerator: production, denominator: consumption, unit: 'trillion kcal' } },
    ),
    'food.stocksToUse': totalUse > 0 && stocksYear > 0
      ? available(
        'food.stocksToUse',
        endingStocks / totalUse,
        stocksYear,
        'USDA PSD / FAOSTAT',
        [
          { name: 'calorieEndingStocks', value: endingStocks, year: stocksYear, unit: 'trillion kcal', source: 'USDA PSD / FAOSTAT' },
          { name: 'calorieTotalUse', value: totalUse, year: stocksYear, unit: 'trillion kcal', source: 'USDA PSD / FAOSTAT' },
        ],
        { aggregation: { numerator: endingStocks, denominator: totalUse, unit: 'trillion kcal' } },
      )
      : countryUnavailable('food.stocksToUse', 'USDA PSD / FAOSTAT'),
  };
}

function energyBalance(countryCode: string, source: unknown): ScorecardEvidence {
  if (!source) return sourceUnavailable('energy.productionBalance', 'OWID and World Bank');
  const entry = readCountry(source, countryCode);
  if (!entry) return countryUnavailable('energy.productionBalance', 'OWID and World Bank');
  const consumption = finite(entry.primaryEnergyConsumptionTwh);
  const netImports = finite(entry.importShare);
  const observationYear = year(entry.year);
  if (consumption == null || !(consumption > 0) || netImports == null || observationYear == null) {
    return countryUnavailable('energy.productionBalance', 'OWID and World Bank');
  }
  const production = consumption * (1 - netImports / 100);
  if (!(production >= 0)) return available('energy.productionBalance', Number.NaN, observationYear, 'OWID and World Bank', []);
  return available(
    'energy.productionBalance',
    production / consumption,
    observationYear,
    'OWID and World Bank',
    [
      { name: 'primaryEnergyConsumptionTwh', value: consumption, year: observationYear, unit: 'TWh', source: 'Our World in Data', indicatorCode: 'primary_energy_consumption' },
      { name: 'netEnergyImportsPercent', value: netImports, year: observationYear, unit: 'percent of energy use', source: 'World Bank via Our World in Data', indicatorCode: 'EG.IMP.CONS.ZS' },
      { name: 'primaryEnergyProductionTwh', value: production, year: observationYear, unit: 'TWh', source: 'Derived from OWID and World Bank' },
    ],
    { quality: 'derived', aggregation: { numerator: production, denominator: consumption, unit: 'TWh' } },
  );
}

function demographicsEvidence(countryCode: string, source: unknown): Partial<Record<ScorecardInputId, ScorecardEvidence>> {
  const ids: ScorecardInputId[] = [
    'demographics.totalDependency', 'demographics.oldAgeDependency', 'demographics.workingAgeProjection',
    'demographics.tertiaryEnrollment', 'demographics.researchersPerMillion', 'demographics.stemGraduateShare',
    'demographics.trainedIndustrialShare', 'demographics.manufacturingEmploymentShare',
    'technology.researchersPerMillion', 'technology.stemGraduateShare',
  ];
  if (!source) return Object.fromEntries(ids.map((id) => [id, sourceUnavailable(id, 'UN / World Bank / ILOSTAT')]));
  const sourceRecord = asRecord(source);
  const country = readCountry(source, countryCode);
  if (!country) return Object.fromEntries(ids.map((id) => [id, countryUnavailable(id, 'UN / World Bank / ILOSTAT')]));
  const age = asRecord(country.ageStructure) ?? {};
  const education = asRecord(country.education) ?? {};
  const workforce = asRecord(country.industrialWorkforce) ?? {};
  const workingCurrentMetric = asRecord(age.workingAgePopulationPeople);
  const workingProjectedMetric = asRecord(age.workingAgePopulationProjected10yPeople);
  const trainedMetric = asRecord(workforce.trainedIndustrialWorkforcePeople);
  const workingCurrent = finite(workingCurrentMetric?.value);
  const workingProjected = finite(workingProjectedMetric?.value);
  const projectionYear = workingProjectedMetric?.year;
  const trained = finite(trainedMetric?.value);
  const result: Partial<Record<ScorecardInputId, ScorecardEvidence>> = {
    'demographics.totalDependency': oneObservation('demographics.totalDependency', age.totalDependencyRatioPercent, 'totalDependencyRatioPercent', 'UN WPP'),
    'demographics.oldAgeDependency': oneObservation('demographics.oldAgeDependency', age.oldAgeDependencyRatioPercent, 'oldAgeDependencyRatioPercent', 'UN WPP'),
    'demographics.workingAgeProjection': workingCurrent != null && workingCurrent > 0 && workingProjected != null
      ? available('demographics.workingAgeProjection', workingProjected / workingCurrent, projectionYear, 'UN WPP', [
        { name: 'workingAgePopulationPeople', value: workingCurrent, year: Number(workingCurrentMetric?.year), unit: 'people', source: String(workingCurrentMetric?.source || 'UN WPP') },
        { name: 'workingAgePopulationProjected10yPeople', value: workingProjected, year: Number(projectionYear), unit: 'people', source: String(workingProjectedMetric?.source || 'UN WPP') },
      ], { quality: 'derived' })
      : countryUnavailable('demographics.workingAgeProjection', 'UN WPP'),
    'demographics.tertiaryEnrollment': oneObservation('demographics.tertiaryEnrollment', education.tertiaryEnrollmentGrossPercent, 'tertiaryEnrollmentGrossPercent', 'World Bank', 'SE.TER.ENRR'),
    'demographics.researchersPerMillion': oneObservation('demographics.researchersPerMillion', education.researchersPerMillion, 'researchersPerMillion', 'World Bank', 'SP.POP.SCIE.RD.P6'),
    'demographics.stemGraduateShare': oneObservation('demographics.stemGraduateShare', education.stemGraduatesSharePercent, 'stemGraduatesSharePercent', 'World Bank'),
    'demographics.trainedIndustrialShare': trained != null && workingCurrent != null && workingCurrent > 0
      ? available('demographics.trainedIndustrialShare', (trained / workingCurrent) * 100, trainedMetric?.year, 'ILOSTAT / UN WPP', [
        { name: 'trainedIndustrialWorkforcePeople', value: trained, year: Number(trainedMetric?.year), unit: 'people', source: String(trainedMetric?.source || 'ILOSTAT') },
        { name: 'workingAgePopulationPeople', value: workingCurrent, year: Number(workingCurrentMetric?.year), unit: 'people', source: String(workingCurrentMetric?.source || 'UN WPP') },
      ], { quality: 'derived' })
      : countryUnavailable('demographics.trainedIndustrialShare', 'ILOSTAT / UN WPP'),
    'demographics.manufacturingEmploymentShare': oneObservation('demographics.manufacturingEmploymentShare', workforce.manufacturingEmploymentSharePercent, 'manufacturingEmploymentSharePercent', 'ILOSTAT'),
    'technology.researchersPerMillion': oneObservation('technology.researchersPerMillion', education.researchersPerMillion, 'researchersPerMillion', 'World Bank', 'SP.POP.SCIE.RD.P6'),
    'technology.stemGraduateShare': oneObservation('technology.stemGraduateShare', education.stemGraduatesSharePercent, 'stemGraduatesSharePercent', 'World Bank'),
  };
  const stages = asRecord(sourceRecord?.stages);
  const stageByInput: Partial<Record<ScorecardInputId, 'wpp' | 'education' | 'ilostat'>> = {
    'demographics.totalDependency': 'wpp',
    'demographics.oldAgeDependency': 'wpp',
    'demographics.workingAgeProjection': 'wpp',
    'demographics.tertiaryEnrollment': 'education',
    'demographics.researchersPerMillion': 'education',
    'demographics.stemGraduateShare': 'education',
    'technology.researchersPerMillion': 'education',
    'technology.stemGraduateShare': 'education',
    'demographics.trainedIndustrialShare': 'ilostat',
    'demographics.manufacturingEmploymentShare': 'ilostat',
  };
  for (const [inputId, stageName] of Object.entries(stageByInput) as Array<[ScorecardInputId, 'wpp' | 'education' | 'ilostat']>) {
    const status = String(asRecord(stages?.[stageName])?.status || '');
    if (status === 'unavailable') {
      result[inputId] = sourceUnavailable(inputId, stageName === 'wpp' ? 'UN WPP' : stageName === 'education' ? 'World Bank' : 'ILOSTAT');
    } else if (status === 'retained' && result[inputId]?.availability === 'available') {
      result[inputId] = { ...result[inputId], quality: 'retained' };
    }
  }
  return result;
}

function techEvidence(countryCode: string, source: ScorecardSourceSnapshots['techByIso2']): Partial<Record<ScorecardInputId, ScorecardEvidence>> {
  const mapping = {
    'technology.internetUse': 'internet',
    'technology.mobileSubscriptions': 'mobile',
    'technology.fixedBroadband': 'broadband',
    'technology.rdSpend': 'rdSpend',
  } as const;
  if (!source) return Object.fromEntries(Object.keys(mapping).map((id) => [id, sourceUnavailable(id as ScorecardInputId, 'World Bank')]));
  const country = asRecord(source[countryCode]);
  if (!country) return Object.fromEntries(Object.keys(mapping).map((id) => [id, countryUnavailable(id as ScorecardInputId, 'World Bank')]));
  const observations = asRecord(country.observations);
  return Object.fromEntries(Object.entries(mapping).map(([inputId, field]) => [
    inputId,
    oneObservation(inputId as ScorecardInputId, observations?.[field], field, 'World Bank'),
  ]));
}

function staticIndicator(record: unknown, indicatorCode: string): unknown {
  const values = asRecord(record)?.infrastructure;
  if (Array.isArray(values)) {
    return values.find((entry) => {
      const row = asRecord(entry);
      return row?.indicator === indicatorCode || row?.indicatorCode === indicatorCode;
    });
  }
  const infrastructure = asRecord(values);
  const indicators = asRecord(infrastructure?.indicators);
  return indicators?.[indicatorCode] ?? infrastructure?.[indicatorCode] ?? null;
}

function defenseEvidence(countryCode: string, source: unknown): Partial<Record<ScorecardInputId, ScorecardEvidence>> {
  const ids: ScorecardInputId[] = ['defense.expenditureUsd', 'defense.expenditurePctGdp', 'defense.personnel', 'defense.industrialBalance'];
  if (!source) return Object.fromEntries(ids.map((id) => [id, sourceUnavailable(id, 'World Bank')]));
  const country = readCountry(source, countryCode);
  if (!country) return Object.fromEntries(ids.map((id) => [id, countryUnavailable(id, 'World Bank')]));
  const exportsMetric = asRecord(country.armsExportsTiv);
  const importsMetric = asRecord(country.armsImportsTiv);
  const exportsValue = finite(exportsMetric?.value);
  const importsValue = finite(importsMetric?.value);
  const totalTransfers = (exportsValue ?? 0) + (importsValue ?? 0);
  const transferYear = Math.max(year(exportsMetric?.year) ?? 0, year(importsMetric?.year) ?? 0);
  return {
    'defense.expenditureUsd': oneObservation('defense.expenditureUsd', country.expenditureUsd, 'expenditureUsd', 'World Bank', 'MS.MIL.XPND.CD'),
    'defense.expenditurePctGdp': oneObservation('defense.expenditurePctGdp', country.expenditurePctGdp, 'expenditurePctGdp', 'World Bank', 'MS.MIL.XPND.GD.ZS'),
    'defense.personnel': oneObservation('defense.personnel', country.personnel, 'personnel', 'World Bank', 'MS.MIL.TOTL.P1'),
    'defense.industrialBalance': totalTransfers > 0 && transferYear > 0
      ? available('defense.industrialBalance', (exportsValue ?? 0) / totalTransfers, transferYear, 'World Bank', [
        { name: 'armsExportsTiv', value: exportsValue ?? 0, year: year(exportsMetric?.year) ?? transferYear, unit: 'SIPRI trend-indicator value', source: 'World Bank', indicatorCode: 'MS.MIL.XPRT.KD' },
        { name: 'armsImportsTiv', value: importsValue ?? 0, year: year(importsMetric?.year) ?? transferYear, unit: 'SIPRI trend-indicator value', source: 'World Bank', indicatorCode: 'MS.MIL.MPRT.KD' },
      ], { quality: 'derived' })
      : countryUnavailable('defense.industrialBalance', 'World Bank'),
  };
}

export function adaptCountryEvidence(countryCode: string, sources: ScorecardSourceSnapshots): CountryScorecardEvidence {
  const inputs = Object.fromEntries(
    Object.keys(SCORECARD_INPUT_REGISTRY).map((inputId) => [
      inputId,
      countryUnavailable(inputId as ScorecardInputId, 'Scorecard source'),
    ]),
  ) as CountryScorecardEvidence['inputs'];
  const populationEntry = readCountry(sources.population, countryCode);
  const population = sources.population
    ? oneObservation('population', populationEntry && { value: populationEntry.populationMillions, year: populationEntry.year, source: 'IMF' }, 'populationMillions', 'IMF')
    : sourceUnavailable('population', 'IMF');
  inputs.population = population;

  Object.assign(inputs, foodEvidence(countryCode, sources.foodStocks));
  Object.assign(inputs, demographicsEvidence(countryCode, sources.demographics));
  Object.assign(inputs, techEvidence(countryCode, sources.techByIso2));
  Object.assign(inputs, defenseEvidence(countryCode, sources.defense));
  inputs['energy.productionBalance'] = energyBalance(countryCode, sources.energyMix);

  const staticRecord = asRecord(sources.staticByCountry?.[countryCode]);
  inputs['food.waterSecurity'] = sources.staticByCountry
    ? oneObservation('food.waterSecurity', staticRecord?.aquastat, 'waterStressPercent', 'World Bank AQUASTAT', 'ER.H2O.FWST.ZS')
    : sourceUnavailable('food.waterSecurity', 'World Bank AQUASTAT');
  inputs['technology.electricityAccess'] = sources.staticByCountry
    ? oneObservation('technology.electricityAccess', staticIndicator(staticRecord, 'EG.ELC.ACCS.ZS'), 'electricityAccessPercent', 'World Bank', 'EG.ELC.ACCS.ZS')
    : sourceUnavailable('technology.electricityAccess', 'World Bank');

  const importHhi = readCountry(sources.importHhi, countryCode);
  inputs['food.importDiversity'] = sources.importHhi
    ? oneObservation('food.importDiversity', importHhi && { value: importHhi.hhi, year: importHhi.year, source: 'UN Comtrade' }, 'importPartnerHhi', 'UN Comtrade')
    : sourceUnavailable('food.importDiversity', 'UN Comtrade');
  inputs['energy.lowCarbonShare'] = sources.lowCarbon
    ? oneObservation('energy.lowCarbonShare', readCountry(sources.lowCarbon, countryCode), 'lowCarbonGenerationShare', 'Our World in Data')
    : sourceUnavailable('energy.lowCarbonShare', 'Our World in Data');
  inputs['energy.gridEfficiency'] = sources.powerLosses
    ? oneObservation('energy.gridEfficiency', readCountry(sources.powerLosses, countryCode), 'powerLossesPercent', 'World Bank')
    : sourceUnavailable('energy.gridEfficiency', 'World Bank');

  inputs['defense.supplierDiversity'] = {
    availability: 'unavailable',
    inputId: 'defense.supplierDiversity',
    reason: 'redistribution-blocked',
    source: 'SIPRI Arms Transfers Database',
    sourceKey: 'military:arms-suppliers:v1',
    detail: 'Partner-facing redistribution is not approved for v1.',
  };

  return { countryCode, population, inputs };
}
