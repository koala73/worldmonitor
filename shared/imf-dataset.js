// Keep shared/imf-dataset.js and api/_imf-dataset.js identical; parity is tested.
export const IMF_DATASETS = {
  imfMacro: { fields: ['inflationPct', 'currentAccountPct', 'govRevenuePct', 'cpiIndex', 'cpiEopPct', 'govExpenditurePct', 'primaryBalancePct', 'year'] },
  imfGrowth: { fields: ['realGdpGrowthPct', 'gdpPerCapitaUsd', 'realGdpLcuB', 'realGdp', 'gdpPerCapitaPpp', 'gdpPpp', 'investmentPct', 'savingsPct', 'savingsInvestmentGap', 'year'] },
  imfLabor: { fields: ['unemploymentPct', 'populationMillions', 'year'] },
  imfExternal: { fields: ['exportsUsd', 'importsUsd', 'tradeBalanceUsd', 'currentAccountUsd', 'importVolumePctChg', 'exportVolumePctChg', 'year'] },
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseImfDataset(key, value) {
  if (!Object.hasOwn(IMF_DATASETS, key)) return undefined;
  if (!isRecord(value) || !isRecord(value.countries) || value.error || value.fallback || value.dataAvailable === false) return undefined;
  const countries = {};
  for (const [code, raw] of Object.entries(value.countries)) {
    if (!/^[A-Z]{2}$/.test(code) || !isRecord(raw)) return undefined;
    const entry = {};
    for (const field of IMF_DATASETS[key].fields) {
      const v = raw[field];
      if (v != null && (typeof v !== 'number' || !Number.isFinite(v))) return undefined;
      if (field === 'year' && v != null && (!Number.isInteger(v) || v < 1900 || v > 2200)) return undefined;
      entry[field] = typeof v === 'number' ? v : null;
    }
    if (!Object.entries(entry).some(([field, v]) => field !== 'year' && v !== null)) return undefined;
    countries[code] = entry;
  }
  // WEO themes are global datasets: an empty map is not a confirmed global all-clear.
  if (Object.keys(countries).length === 0) return undefined;
  const seededAt = typeof value.seededAt === 'string' ? Date.parse(value.seededAt) : NaN;
  return { countries, seededAt: Number.isFinite(seededAt) && seededAt > 0 ? seededAt : 0 };
}

