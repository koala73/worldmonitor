// Malaysia's refined-product demand from the Department of Statistics
// Malaysia (DOSM) open data API: annual final energy consumption by
// commodity (energy_consumption_commodity), in ktoe, from the Energy
// Commission's National Energy Balance. JODI carries Malaysia's product
// trade but no demand, so this is the energy shock's only demand for it.
//
// Final consumption excludes fuel burned for power generation and refinery
// own use. Values are converted to kb/d at IEA default net calorific values
// and standard barrels per tonne; the year's calendar days divide.

export const DOSM_ENERGY_CONSUMPTION_URL = 'https://api.data.gov.my/data-catalogue/?id=energy_consumption_commodity&limit=5000';

/** Energy shock product key → DOSM commodity. DOSM has no naphtha row. */
export const DOSM_PRODUCT_COMMODITIES = {
  gasoline: 'petrol',
  diesel: 'diesel',
  jet: 'jet_fuel',
  lpg: 'lpg',
};

const GJ_PER_TOE = 41.868;

// IEA default net calorific values (GJ/t) and barrels per tonne.
export const PRODUCT_CONVERSION = {
  gasoline: { ncvGjPerT: 44.3, bblPerT: 8.53 },
  diesel: { ncvGjPerT: 43.0, bblPerT: 7.46 },
  jet: { ncvGjPerT: 44.1, bblPerT: 7.88 },
  lpg: { ncvGjPerT: 46.0, bblPerT: 11.6 },
};

const daysInYear = (year) => ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365);

/** Annual ktoe of one product to kb/d over that calendar year. */
export function ktoeToKbd(ktoe, product, year) {
  const { ncvGjPerT, bblPerT } = PRODUCT_CONVERSION[product];
  const kt = (ktoe * GJ_PER_TOE) / ncvGjPerT;
  return (kt * bblPerT) / daysInYear(year);
}

/**
 * The latest year in which DOSM has every modeled product, as kb/d (one
 * decimal) and the ktoe it came from; null when no year is complete.
 *
 * @param {Array<{date?: string, commodity?: string, consumption?: unknown}>} rows
 */
export function dosmProductDemand(rows) {
  const byYear = new Map();
  for (const r of rows ?? []) {
    const year = Number(String(r?.date ?? '').slice(0, 4));
    const value = r?.consumption;
    if (!Number.isInteger(year) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (!byYear.has(year)) byYear.set(year, new Map());
    byYear.get(year).set(String(r.commodity), value);
  }
  const entries = Object.entries(DOSM_PRODUCT_COMMODITIES);
  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    const values = byYear.get(year);
    if (!entries.every(([, commodity]) => values.get(commodity) > 0)) continue;
    const ktoe = Object.fromEntries(entries.map(([key, commodity]) => [key, values.get(commodity)]));
    const products = Object.fromEntries(entries.map(([key]) => [key, Math.round(ktoeToKbd(ktoe[key], key, year) * 10) / 10]));
    return { year, ktoe, products };
  }
  return null;
}
