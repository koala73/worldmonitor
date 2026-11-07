import { cubeCells, monthDate, positive } from './monthly.mjs';

// Railway cannot resolve makstat.stat.gov.mk (ENOTFOUND, then connect timeouts); the proxy resolves it remotely.
export const proxy = true;
export const DATA_URL = 'https://makstat.stat.gov.mk/PXWeb/api/v1/en/MakStat/Ceni/IndeksTrosZivot/TrosociZivot/131_CeniTr_Mk_DetalnoTroZi_ecoicop_ml.px';
/** Describe the latest food CPI monthly and annual changes as context rather than prices. */
export function parseMakstat(payload) {
  const cells = cubeCells(payload, ['Година', 'Продукти', 'Индекс']).filter(cell => cell['Продукти'].code === '0002' && positive(cell.value));
  const latest = cells.map(cell => monthDate(cell['Година'].code)).sort().at(-1);
  const values = cells.filter(cell => monthDate(cell['Година'].code) === latest);
  const mom = values.find(cell => cell['Индекс'].code === '02');
  const yoy = values.find(cell => cell['Индекс'].code === '03');
  if (!latest || !mom || !yoy || !/previous month/i.test(mom['Индекс'].label) || !/same month.*previous year/i.test(yoy['Индекс'].label)
    || !/FOOD AND NON-ALCOHOLIC BEVERAGES/i.test(mom['Продукти'].label)) throw new Error('MakStat food CPI format changed');
  return { country: 'North Macedonia', countryCode: 'MK', referenceDate: latest, url: DATA_URL,
    title: `Food and non-alcoholic beverages CPI: ${(Number(mom.value) - 100).toFixed(1)}% month-on-month; ${(Number(yoy.value) - 100).toFixed(1)}% year-on-year (indices, not prices)` };
}
/** Select the latest valid metadata month and request both CPI comparison indices. */
export async function collect(ctx) {
  const metadata = JSON.parse(await ctx.get(DATA_URL));
  const months = metadata.variables?.find(variable => variable.code === 'Година')?.values;
  const latest = Array.isArray(months) ? months.filter(value => monthDate(value)).sort().at(-1) : '';
  if (!latest) throw new Error('MakStat month metadata changed');
  const body = { query: [
    { code: 'Година', selection: { filter: 'item', values: [latest] } },
    { code: 'Продукти', selection: { filter: 'item', values: ['0002'] } },
    { code: 'Индекс', selection: { filter: 'item', values: ['02', '03'] } },
  ], response: { format: 'json-stat2' } };
  const context = parseMakstat(JSON.parse(await ctx.get(DATA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
  if (context.referenceDate > ctx.dated(ctx.now, 0)) throw new Error('MakStat future month');
  return { observations: [], contexts: [context], reportUrl: DATA_URL };
}
