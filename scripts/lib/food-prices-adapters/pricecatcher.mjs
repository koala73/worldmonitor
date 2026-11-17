import { brotliDecompressSync } from 'node:zlib';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { csvRows, positive, priceReport } from './monthly.mjs';

const BASE = 'https://storage.data.gov.my/pricecatcher/';
const KG = '1kg';
const EGGS = '30 biji';
// item_code: [display name, exact publisher lookup name, publisher unit]. Only items KPDN collects every day
// at hundreds of premises are listed; packaged rice, oil, sugar, flour, meat and most fruit are surveyed on
// irregular basket days and cannot share one latest date and exact-week baseline with the daily staples.
const ITEMS = {
  '1': ['Chicken (standard, cleaned)', 'AYAM BERSIH - STANDARD', KG],
  '2': ['Chicken (super, cleaned)', 'AYAM BERSIH - SUPER', KG],
  '1109': ['Eggs (grade A)', 'TELUR AYAM GRED A', EGGS],
  '1110': ['Eggs (grade B)', 'TELUR AYAM GRED B', EGGS],
  '1111': ['Eggs (grade C)', 'TELUR AYAM GRED C', EGGS],
  '2045': ['Round scad / sardine (selayang, 8-12 per kg)', 'IKAN SELAYANG/SARDIN (ANTARA 8-12 EKOR SEKILOGRAM)', KG],
  '2047': ['Little tuna (tongkol/aya, 1-2 per kg)', 'IKAN TONGKOL/AYA/KAYU HITAM/PUTIH (ANTARA 1 HINGGA 2 EKOR SEKILOGRAM)', KG],
  '47': ['Torpedo scad (cencaru, 4-6 per kg)', 'IKAN CENCARU (ANTARA 4 HINGGA 6 EKOR SEKILOGRAM)', KG],
  '1436': ['Threadfin bream (kerisi, 5-10 per kg)', 'IKAN KERISI (ANTARA 5 HINGGA 10 EKOR SEKILOGRAM)', KG],
  '70': ['Scad (selar/pelata, up to 7 per kg)', 'IKAN SELAR/PELATA (≤ 7 EKOR SEKILOGRAM)', KG],
  '1476': ['Indian mackerel (kembung, 8-12 per kg)', 'IKAN KEMBUNG (ANTARA 8 HINGGA 12 EKOR SEKILOGRAM)', KG],
  '1477': ['Mabung fish (6-10 per kg)', 'IKAN MABUNG (ANTARA 6 HINGGA 10 EKOR SEKILOGRAM)', KG],
  '1555': ['Whiteleg shrimp, farmed (41-60 per kg)', 'UDANG PUTIH/VANNAMEI (TERNAK) (ANTARA 41 HINGGA 60 EKOR SEKILOGRAM)', KG],
  '845': ['Squid (11-17 per kg)', 'SOTONG (ANTARA 11 HINGGA17 EKOR SEKILOGRAM)', KG],
  '88': ['Catfish (keli, 2-5 per kg)', 'IKAN KELI (ANTARA 2 HINGGA 5 EKOR SEKILOGRAM)', KG],
  '1921': ['Red tilapia (2-5 per kg)', 'IKAN TILAPIA MERAH (ANTARA 2 HINGGA 5 EKOR SEKILOGRAM)', KG],
  '114': ['Tomatoes', 'TOMATO', KG],
  '113': ['Cucumber', 'TIMUN', KG],
  '109': ['Carrots', 'LOBAK MERAH', KG],
  '1481': ['Cauliflower', 'KUBIS BUNGA (CAULIFLOWER)', KG],
  '1458': ['Cabbage, imported (Beijing)', 'KUBIS BULAT IMPORT (BEIJING)', KG],
  '105': ['Cabbage, local', 'KUBIS BULAT (TEMPATAN)', KG],
  '96': ['Okra', 'KACANG BENDI', KG],
  '98': ['Long beans', 'KACANG PANJANG', KG],
  '97': ['French beans', 'KACANG BUNCIS', KG],
  '1558': ['Choy sum (sawi hijau)', 'SAWI HIJAU', KG],
  '1559': ['Water spinach (kangkung)', 'KANGKUNG', KG],
  '1556': ['Green amaranth (bayam hijau)', 'BAYAM HIJAU', KG],
  '1560': ['Kai lan', 'KAILAN', KG],
  '92': ['Green chilli', 'CILI HIJAU', KG],
  '94': ['Red chilli (minyak)', 'CILI MERAH - MINYAK', KG],
  '95': ['Ginger (mature)', 'HALIA BASAH (TUA)', KG],
  '129': ['Yellow onion (Holland)', 'BAWANG BESAR KUNING/HOLLAND', KG],
  '1440': ['Onion, imported (India)', 'BAWANG BESAR IMPORT (INDIA)', KG],
  '131': ['Shallots, rose, imported (India)', 'BAWANG KECIL MERAH ROSE IMPORT (INDIA)', KG],
  '1564': ['Garlic, imported (China)', 'BAWANG PUTIH IMPORT (CHINA)', KG],
  '1131': ['Potatoes, imported (China)', 'UBI KENTANG IMPORT (CHINA)', KG],
  '1132': ['Lime (limau nipis)', 'LIMAU NIPIS', KG],
  '1928': ['Calamansi (limau kasturi)', 'LIMAU KASTURI', KG],
};
export const PRICECATCHER_ITEM_CODES = Object.keys(ITEMS);
// One distinct premise quote per date and item inside the read window. Normal days hold about 30,000
// selected quotes and the window spans at most 16 days, so this bounds memory without rejecting real files.
const QUOTE_LIMIT = 1_000_000;

/** Start a per-date, per-item accumulator of unique premise quotes inside [since, before). */
export function priceAccumulator({ before, since, limit = QUOTE_LIMIT }) {
  return { before, since, limit, groups: new Map(), quotes: 0 };
}

/** Fold decoded rows into the accumulator, keeping one quote per premise and rejecting conflicting duplicates. */
export function addPriceRows(acc, rows) {
  for (const row of rows) {
    const code = String(row.item_code);
    if (!ITEMS[code]) continue;
    const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= acc.before || date < acc.since || !positive(row.price)) continue;
    const premise = String(row.premise_code);
    if (!/^\d+$/.test(premise)) throw new Error('PriceCatcher premise code changed');
    const key = `${date}|${code}`;
    let shops = acc.groups.get(key);
    if (!shops) acc.groups.set(key, shops = new Map());
    const price = Number(row.price);
    if (shops.has(premise)) {
      if (shops.get(premise) !== price) throw new Error('PriceCatcher conflicting shop quotes');
      continue;
    }
    shops.set(premise, price);
    if (++acc.quotes > acc.limit) throw new Error('PriceCatcher selected quotes exceed limit');
  }
  return acc;
}

/** Compute staple medians for dates with at least ten distinct premises per item. */
export function summarizePrices(acc, lookup) {
  const checked = new Set();
  return [...acc.groups].flatMap(([key, shops]) => {
    const [date, code] = key.split('|');
    const [name, expected, unit] = ITEMS[code];
    if (!checked.has(code)) {
      const item = lookup.get(code);
      if (!item || item.unit !== unit || item.item !== expected) throw new Error('PriceCatcher staple lookup unit or product changed');
      checked.add(code);
    }
    if (shops.size < 10) return [];
    const sorted = [...shops.values()].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return [{ item: name, market: 'Median of reporting premises (Malaysia)', marketType: 'retail',
      unit: unit === EGGS ? '30 pieces' : 'kg', currency: 'MYR', date,
      price: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, origin: '' }];
  });
}

/** Aggregate already-decoded rows; used for small inputs and tests. */
export function aggregatePrices(rows, lookup, window) {
  return summarizePrices(addPriceRows(priceAccumulator(window), rows), lookup);
}

/** Decode selected Parquet columns one row group at a time into the accumulator, with row, expansion and Brotli limits. */
export async function readPricecatcher(bytes, acc) {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const meta = parquetMetadata(file);
  if (Number(meta.num_rows) > 4_000_000 || meta.row_groups.length > 100
    || meta.row_groups.some(group => Number(group.total_byte_size) > 100_000_000)) throw new Error('PriceCatcher parquet size limit exceeded');
  let rowStart = 0;
  for (const group of meta.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    addPriceRows(acc, await parquetReadObjects({ file, rowStart, rowEnd, columns: ['date', 'premise_code', 'item_code', 'price'],
      compressors: { BROTLI: data => brotliDecompressSync(data, { maxOutputLength: 32_000_000 }) } }));
    rowStart = rowEnd;
  }
  return acc;
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
  const acc = priceAccumulator({ before, since });
  try { await readPricecatcher(await ctx.get(`${BASE}pricecatcher_${current}.parquet`, { binary: true }), acc); }
  catch (error) { if (!/HTTP 404\b/.test(error.message)) throw error; ctx.warn('current-month file not yet published'); }
  if (since.slice(0, 7) !== current) {
    // A prior-month failure must not leave a partly folded file behind, so read it into its own bounded
    // accumulator and merge only on success. Monthly files hold disjoint dates.
    const prior = priceAccumulator({ before, since });
    try {
      await readPricecatcher(await ctx.get(`${BASE}pricecatcher_${previous}.parquet`, { binary: true }), prior);
      for (const [key, shops] of prior.groups) acc.groups.set(key, shops);
    } catch (error) { ctx.warn(`prior-month prices unavailable: ${error.message}`); }
  }
  const all = summarizePrices(acc, lookup);
  const dates = [...new Set(all.map(row => row.date))].sort().reverse();
  const latest = dates.find(date => all.filter(row => row.date === date).length === PRICECATCHER_ITEM_CODES.length);
  const prior = latest ? ctx.dated(new Date(`${latest}T00:00:00Z`), -7) : '';
  return priceReport(all.filter(row => row.date === latest || row.date === prior), 'https://data.gov.my/data-catalogue/pricecatcher', ctx.now);
}
