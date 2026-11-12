import { isoDate } from '../food-prices.mjs';
import { positive, priceReport } from './monthly.mjs';

export const FEWS_COUNTRIES = { fewssd: 'SD', fewsss: 'SS', fewsye: 'YE', fewsht: 'HT' };
const URL_BASE = 'https://fdw.fews.net/api/marketpricefacts/';
const FOOD = /\b(?:rice|wheat|flour|maize|corn|sorghum|millet|bean|beans|oil|sugar|salt|cassava|groundnut|lentil|cowpea)\b/i;

/** Select the latest public monthly food prices for one country, retaining local currency and market identity. */
export function parseFews(payload, country) {
  if (!Array.isArray(payload) || payload.length > 20_000) throw new Error('FEWS NET response shape changed');
  const result = payload.flatMap(row => {
    if (row.country_code !== country || row.data_usage_policy !== 'Public' || row.collection_status !== 'Published'
      || row.collection_schedule !== 'Monthly' || !FOOD.test(row.product) || !['Retail', 'Wholesale'].includes(row.price_type)) return [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(row.period_date) ? isoDate(...row.period_date.split('-')) : '';
    // common_unit_price retains local currency and normalises local pack sizes; common_currency_price is USD.
    if (!date || !positive(row.common_unit_price) || !['kg', 'L'].includes(row.common_unit)
      || !/^[A-Z]{3}$/.test(row.currency) || !row.market || !row.product_source || !row.source_organization) return [];
    return [{ item: row.product, market: `${row.market} (${row.source_organization})`, marketType: row.price_type.toLowerCase(),
      unit: row.common_unit === 'L' ? 'litre' : 'kg', currency: row.currency, date, price: Number(row.common_unit_price), origin: row.product_source }];
  });
  if (!result.length) throw new Error('FEWS NET has no public monthly food prices');
  const latest = result.map(row => row.date).sort().at(-1);
  return result.filter(row => row.date === latest);
}

/** Collect a bounded recent window of monthly prices for the configured FEWS country. The Data Warehouse answers
 * Railway's egress with HTTP 403 on every run (200 elsewhere), so requests take the shared proxy route. */
export const fewsAdapter = country => ({ proxy: true, collect: async ctx => {
  const start = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
  const url = `${URL_BASE}?${new URLSearchParams({ country_code: country, format: 'json', start_date: start })}`;
  return priceReport(parseFews(JSON.parse(await ctx.get(url)), country), url, ctx.now);
} });
