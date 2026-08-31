export interface EnergyImportDependencySourceHint {
  providerName: string;
  sourceUrl: string;
}

export function getEnergyImportDependencyObservedSources(
  source: unknown,
): readonly EnergyImportDependencySourceHint[] {
  if (typeof source !== 'string') return [];

  const normalized = source.toLowerCase();
  if (normalized.includes('eurostat')) {
    return [{
      providerName: 'Eurostat',
      sourceUrl: 'https://ec.europa.eu/eurostat/databrowser/view/nrg_ind_id/default/table?lang=en',
    }];
  }
  if (normalized.includes('world bank') || normalized.includes('worldbank')) {
    return [{
      providerName: 'World Bank Open Data',
      sourceUrl: 'https://api.worldbank.org/v2/country/all/indicator/EG.IMP.CONS.ZS',
    }];
  }
  return [];
}
