// IMF WEO bootstrap datasets and the numeric fields each country row carries.
export const IMF_DATASETS = {
  imfMacro: { fields: ['inflationPct', 'currentAccountPct', 'govRevenuePct', 'cpiIndex', 'cpiEopPct', 'govExpenditurePct', 'primaryBalancePct', 'year'] },
  imfGrowth: { fields: ['realGdpGrowthPct', 'gdpPerCapitaUsd', 'realGdpLcuB', 'realGdp', 'gdpPerCapitaPpp', 'gdpPpp', 'investmentPct', 'savingsPct', 'savingsInvestmentGap', 'year'] },
  imfLabor: { fields: ['unemploymentPct', 'populationMillions', 'year'] },
  imfExternal: { fields: ['exportsUsd', 'importsUsd', 'tradeBalanceUsd', 'currentAccountUsd', 'importVolumePctChg', 'exportVolumePctChg', 'year'] },
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidCountryRow(fields, code, row) {
  if (!/^[A-Z]{2}$/.test(code) || !isRecord(row)) return false;
  let hasValue = false;
  for (const field of fields) {
    const v = row[field];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (field === 'year') {
      if (!Number.isInteger(v) || v < 1900 || v > 2200) return false;
    } else {
      hasValue = true;
    }
  }
  return hasValue;
}

/**
 * Validate a seeded IMF dataset before bootstrap serves it. Returns undefined
 * for a structurally malformed dataset (the caller reports it `missing`, which
 * is no-store), otherwise the dataset with malformed country rows dropped.
 * Valid rows are passed through as seeded, never rebuilt, and a dataset with
 * nothing to drop comes back as the same object.
 */
export function validateImfDataset(key, value) {
  if (!Object.hasOwn(IMF_DATASETS, key)) return value;
  if (!isRecord(value) || !isRecord(value.countries) || value.error || value.fallback || value.dataAvailable === false) return undefined;
  const { fields } = IMF_DATASETS[key];
  const countries = {};
  let dropped = false;
  for (const [code, row] of Object.entries(value.countries)) {
    if (isValidCountryRow(fields, code, row)) countries[code] = row;
    else dropped = true;
  }
  // WEO themes are global datasets: an empty map is not a confirmed all-clear.
  if (Object.keys(countries).length === 0) return undefined;
  return dropped ? { ...value, countries } : value;
}
