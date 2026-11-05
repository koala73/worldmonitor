import { cubeCells, monthDate, positive, priceReport } from './monthly.mjs';

export const DATA_URL = 'https://data.stat.gov.lv/api/v1/en/OSP_PUB/VEK/PC/PCC/PCC010m';
/** Decode food and beverage retail prices, rejecting changed measures, units or dates. */
export function parseLatvia(payload) {
  return cubeCells(payload, ['GOODS_SERVICES', 'ContentsCode', 'TIME']).flatMap(cell => {
    if (!/^01\.[12]\./.test(cell.GOODS_SERVICES.code) || !positive(cell.value)) return [];
    if (!['PCC010m', 'EliminatedValue'].includes(cell.ContentsCode.code) || !/Average retail price/i.test(cell.ContentsCode.label)) throw new Error('Latvia price measure changed');
    const match = /^(.+),\s*((?:\d+(?:\.\d+)?\s*)?(?:kg|g|l|ml|pcs|piece))\s*$/.exec(cell.GOODS_SERVICES.label);
    if (!match) throw new Error('Latvia food unit format changed');
    const date = monthDate(cell.TIME.code);
    if (!date) throw new Error('Latvia month format changed');
    return [{ item: match[1], market: 'National average', marketType: 'retail', unit: match[2], currency: 'EUR', date, price: Number(cell.value), origin: '' }];
  });
}
/** Query the latest Latvian food-price month using publisher dimension metadata. */
export async function collect(ctx) {
  const meta = JSON.parse(await ctx.get(DATA_URL));
  if (!/euro per 1 kg/i.test(meta.title)) throw new Error('Latvia price table units changed');
  const query = meta.variables.map(variable => ({ code: variable.code, selection: { filter: 'item', values:
    variable.code === 'TIME' ? variable.values.slice(-1) : variable.code === 'GOODS_SERVICES' ? variable.values.filter(code => /^01\.[12]\./.test(code)) : variable.values } }));
  const observations = parseLatvia(JSON.parse(await ctx.get(DATA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, response: { format: 'json-stat2' } }) })));
  return priceReport(observations, DATA_URL, ctx.now);
}
