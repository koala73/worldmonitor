import { positive, priceReport } from './monthly.mjs';
import { isoDate } from '../food-prices.mjs';

export const DATA_URL = 'https://lustat.statec.lu/rest/data/LU1,DSD_PRIX_PRODUIT@DF_E5300,1.0/all?startPeriod=2024';
const FOOD = new Set(['EGGS', 'POT', 'PORC', 'BAN', 'FAR', 'COF', 'WAT', 'BUTT', 'CROI', 'SUG', 'PAIN', 'MILK', 'APP']);
/** Decode the latest annual June food benchmark while retaining published product units. */
export function parseStatec(payload) {
  const dimensions = payload?.structure?.dimensions;
  const series = dimensions?.series;
  const time = dimensions?.observation?.find(dim => dim.id === 'TIME_PERIOD');
  if (!/prices.*June/i.test(payload?.structure?.name) || !Array.isArray(series) || !time || !payload.dataSets?.[0]?.series) throw new Error('STATEC June price format changed');
  const results = [];
  for (const [key, entry] of Object.entries(payload.dataSets[0].series)) {
    const codes = key.split(':').map(Number);
    if (codes.length !== series.length) throw new Error('STATEC series dimensions changed');
    const dimension = id => { const i = series.findIndex(dim => dim.id === id); return series[i]?.values[codes[i]]; };
    const product = dimension('COMMON_PRODUCT');
    if (!FOOD.has(product?.id) || dimension('UNIT_MEASURE')?.id !== 'EUR' || dimension('FREQ')?.id !== 'A') continue;
    const unit = /\(([^)]+)\)$/.exec(product.name)?.[1];
    if (!unit) throw new Error('STATEC product unit changed');
    for (const [index, values] of Object.entries(entry.observations ?? {})) {
      const year = time.values[Number(index)]?.id;
      const date = /^\d{4}$/.test(year) ? isoDate(year, 6, 1) : '';
      if (date && positive(values[0])) results.push({ item: product.name, market: 'National average (June survey)', marketType: 'retail', unit,
        currency: 'EUR', date, price: Number(values[0]), origin: '' });
    }
  }
  const latest = results.map(row => row.date).sort().at(-1);
  return results.filter(row => row.date === latest);
}
/** Request the Luxembourg benchmark with the publisher-required English language header. */
export async function collect(ctx) {
  // Node fetch sends Accept-Language: * by default; this publisher returns HTTP 500 (languageTag1) for it.
  return priceReport(parseStatec(JSON.parse(await ctx.get(DATA_URL, { headers: { Accept: 'application/json', 'Accept-Language': 'en' } }))), DATA_URL, ctx.now);
}
