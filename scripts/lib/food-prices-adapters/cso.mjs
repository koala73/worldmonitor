import { csvRows, monthDate, positive, priceReport } from './monthly.mjs';

export const DATA_URL = 'https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/CPM12/CSV/1.0/en';
export function parseCso(text) {
  const rows = csvRows(text, ['STATISTIC', 'TLIST(M1)', 'C02363V03422', 'Consumer Item', 'UNIT', 'VALUE']);
  const food = rows.filter(row => row.STATISTIC === 'CPM12' && row.UNIT === 'Euro' && /^1\d{4}$/.test(row.C02363V03422)
    && Number(row.C02363V03422) <= 11640 && positive(row.VALUE));
  const latest = food.map(row => monthDate(row['TLIST(M1)'])).sort().at(-1);
  return food.filter(row => monthDate(row['TLIST(M1)']) === latest).map(row => {
    const name = row['Consumer Item'];
    const unit = /\bper (.+)$/.exec(name)?.[1] ?? /\(([^)]+)\)$/.exec(name)?.[1] ?? /\b(\d+(?:\.\d+)?\s*kg)$/.exec(name)?.[1];
    if (!unit) throw new Error(`CSO food unit changed: ${name}`);
    return { item: name, market: 'National average', marketType: 'retail', unit, currency: 'EUR', date: latest, price: Number(row.VALUE), origin: '' };
  });
}
export async function collect(ctx) {
  return priceReport(parseCso(await ctx.get(DATA_URL)), DATA_URL, ctx.now);
}
