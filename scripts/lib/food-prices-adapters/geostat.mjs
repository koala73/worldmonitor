import { isoDate } from '../food-prices.mjs';
import { positive } from './monthly.mjs';

export const PAGE_URL = 'https://www.geostat.ge/en/modules/categories/26/cpi-inflation';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const cellText = cell => typeof cell === 'string' ? cell : cell?.richText?.map(part => part.text).join('') ?? '';
/** Read the latest food CPI with previous-month base 100 as dated context. */
export function parseGeostat(sheets) {
  const rows = sheets.find(sheet => sheet.some(row => row[2] === 'Groups'));
  if (!rows || !rows.some(row => row.some(cell => /Previous month=100/i.test(cellText(cell))))) throw new Error('Geostat monthly CPI format changed');
  const at = rows.findIndex(row => row[2] === 'Groups');
  const food = rows.find(row => row[2] === 'Food and non-alcoholic beverages');
  const years = rows[at];
  const months = rows[at + 1];
  if (!food || !months) throw new Error('Geostat food CPI missing');
  const values = years.flatMap((year, i) => {
    const date = isoDate(year, ROMAN.indexOf(months[i]) + 1, 1);
    return /^20\d{2}$/.test(String(year)) && date && positive(food[i]) ? [{ date, value: Number(food[i]) }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const latest = values.at(-1);
  if (!latest) throw new Error('Geostat has no dated food CPI');
  return { country: 'Georgia', countryCode: 'GE', referenceDate: latest.date, url: PAGE_URL,
    title: `Food and non-alcoholic beverages CPI: ${(Math.round((latest.value - 100) * 10) / 10 || 0).toFixed(1)}% month-on-month (previous month = 100; index, not a price)` };
}
/** Discover the monthly CPI workbook and reject future-dated context. */
export async function collect(ctx) {
  const links = ctx.links(await ctx.get(PAGE_URL), PAGE_URL);
  const report = links.find(link => /Consumer-Price-Indices-/i.test(link.url) && /Previous-month/i.test(link.url) && /\.xlsx$/i.test(link.url));
  if (!report) throw new Error('Geostat monthly CPI workbook link missing');
  const context = parseGeostat(await ctx.readWorkbook(await ctx.get(report.url, { binary: true })));
  if (context.referenceDate > ctx.dated(ctx.now, 0)) throw new Error('Geostat future month');
  return { observations: [], contexts: [context], reportUrl: report.url };
}
