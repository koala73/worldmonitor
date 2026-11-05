import { isoDate } from '../food-prices.mjs';
import { positive, priceReport } from './monthly.mjs';

export const DATA_URL = 'https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx?IsTransData=1&UnitId=037';
/** Convert ROC transaction dates and retain traded staple crop quotes in TWD per kg. */
export function parseTaiwan(payload) {
  if (!Array.isArray(payload) || payload.length > 25_000) throw new Error('Taiwan transaction format changed');
  return payload.flatMap(row => {
    // The card covers these staple groups; the full endpoint also contains thousands of unrelated crops.
    if (!/^(?:甘藍|番茄|香蕉)/.test(row['作物名稱'] ?? '')) return [];
    const match = /^(\d{3})\.(\d{2})\.(\d{2})$/.exec(row['交易日期']);
    const date = match ? isoDate(Number(match[1]) + 1911, match[2], match[3]) : '';
    if (!date || !row['作物名稱'] || !row['市場名稱'] || !positive(row['平均價']) || !positive(row['交易量'])) return [];
    return [{ item: `${row['作物名稱']} (${row['作物代號']})`, market: `${row['市場名稱']} (${row['市場代號']})`, marketType: 'wholesale',
      unit: 'kg', currency: 'TWD', date, price: Number(row['平均價']), origin: '' }];
  });
}
/** Collect current Taiwan crop transactions and validate their report dates. */
export async function collect(ctx) {
  return priceReport(parseTaiwan(JSON.parse(await ctx.get(DATA_URL))), DATA_URL, ctx.now);
}
