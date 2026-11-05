import { brotliDecompressSync } from 'node:zlib';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { csvRows, positive, priceReport } from './monthly.mjs';

const BASE = 'https://storage.data.gov.my/pricecatcher/';
const ITEMS = { '1': ['Chicken (standard, cleaned)', '1kg'], '114': ['Tomatoes', '1kg'], '1109': ['Eggs (grade A)', '30 biji'] };
const EXPECTED_NAMES = { '1': /^AYAM BERSIH - STANDARD$/, '114': /^TOMATO$/, '1109': /^TELUR AYAM GRED A$/ };

/** Compute staple medians for complete dates with at least ten distinct premises per item. */
export function aggregatePrices(rows, lookup, { before, since }) {
  const groups = new Map();
  for (const row of rows) {
    const code = String(row.item_code);
    if (!ITEMS[code]) continue;
    const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= before || date < since || !positive(row.price)) continue;
    const item = lookup.get(code);
    if (!item || item.unit !== ITEMS[code][1] || !EXPECTED_NAMES[code].test(item.item)) throw new Error('PriceCatcher staple lookup unit or product changed');
    const key = `${date}|${code}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const shops = groups.get(key);
    const premise = String(row.premise_code);
    if (!/^\d+$/.test(premise)) throw new Error('PriceCatcher premise code changed');
    if (shops.has(premise) && shops.get(premise) !== Number(row.price)) throw new Error('PriceCatcher conflicting shop quotes');
    shops.set(premise, Number(row.price));
  }
  return [...groups].flatMap(([key, shops]) => {
    if (shops.size < 10) return [];
    const [date, code] = key.split('|');
    const sorted = [...shops.values()].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return [{ item: ITEMS[code][0], market: 'Median of reporting premises (Malaysia)', marketType: 'retail',
      unit: code === '1109' ? '30 pieces' : 'kg', currency: 'MYR', date,
      price: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, origin: '' }];
  });
}

/** Decode selected Parquet columns with row, expansion and Brotli output limits. */
export async function readPricecatcher(bytes) {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const meta = parquetMetadata(file);
  if (Number(meta.num_rows) > 4_000_000 || meta.row_groups.length > 100
    || meta.row_groups.some(group => Number(group.total_byte_size) > 100_000_000)) throw new Error('PriceCatcher parquet size limit exceeded');
  const rows = [];
  let rowStart = 0;
  for (const group of meta.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const batch = await parquetReadObjects({ file, rowStart, rowEnd, columns: ['date', 'premise_code', 'item_code', 'price'],
      compressors: { BROTLI: data => brotliDecompressSync(data, { maxOutputLength: 32_000_000 }) } });
    rows.push(...batch.filter(row => ITEMS[String(row.item_code)]));
    if (rows.length > 300_000) throw new Error('PriceCatcher selected rows exceed limit');
    rowStart = rowEnd;
  }
  return rows;
}

/** Select the latest completed Malaysian day with all staples and its exact-week baseline. */
export async function collect(ctx) {
  const lookup = new Map(csvRows(await ctx.get(`${BASE}lookup_item.csv`), ['item_code', 'item', 'unit']).map(row => [row.item_code, row]));
  // Today's collection can be partial. Report the latest completed local calendar day available.
  const before = new Date(ctx.now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const since = ctx.dated(ctx.now, -15);
  const current = before.slice(0, 7);
  const [year, month] = current.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 15)).toISOString().slice(0, 7);
  let rows = [];
  try { rows = await readPricecatcher(await ctx.get(`${BASE}pricecatcher_${current}.parquet`, { binary: true })); }
  catch (error) { if (!/HTTP 404\b/.test(error.message)) throw error; ctx.warn('current-month file not yet published'); }
  if (since.slice(0, 7) !== current) {
    try { rows.push(...await readPricecatcher(await ctx.get(`${BASE}pricecatcher_${previous}.parquet`, { binary: true }))); }
    catch (error) { ctx.warn(`prior-month prices unavailable: ${error.message}`); }
  }
  const all = aggregatePrices(rows, lookup, { before, since });
  const dates = [...new Set(all.map(row => row.date))].sort().reverse();
  const latest = dates.find(date => all.filter(row => row.date === date).length === Object.keys(ITEMS).length);
  const prior = latest ? ctx.dated(new Date(`${latest}T00:00:00Z`), -7) : '';
  return priceReport(all.filter(row => row.date === latest || row.date === prior), 'https://data.gov.my/data-catalogue/pricecatcher', ctx.now);
}
