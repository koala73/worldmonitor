import { brotliDecompressSync } from 'node:zlib';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { csvRows, positive, priceReport } from './monthly.mjs';

const BASE = 'https://storage.data.gov.my/pricecatcher/';
const KG = '1kg';
const EGGS = '30 biji';
const BAG10 = '10 kg';
const BOTTLE5 = '5 kg';
const EACH = '1 biji';
const UNITS = { [KG]: 'kg', [EGGS]: '30 pieces', [BAG10]: '10 kg', [BOTTLE5]: '5 kg', [EACH]: 'piece' };
// item_code: [display name, exact publisher lookup name, publisher unit, collection]. Daily items are quoted every
// day at hundreds of premises and share one latest day and exact-week baseline. Basket items (packaged rice, oil,
// sugar, flour, coconut, meat and fruit) are quoted only on irregular basket-survey days, so each reports its own
// latest survey day against the most recent survey at least seven days earlier.
const ITEMS = {
  '1': ['Chicken (standard, cleaned)', 'AYAM BERSIH - STANDARD', KG, 'daily'],
  '2': ['Chicken (super, cleaned)', 'AYAM BERSIH - SUPER', KG, 'daily'],
  '1109': ['Eggs (grade A)', 'TELUR AYAM GRED A', EGGS, 'daily'],
  '1110': ['Eggs (grade B)', 'TELUR AYAM GRED B', EGGS, 'daily'],
  '1111': ['Eggs (grade C)', 'TELUR AYAM GRED C', EGGS, 'daily'],
  '2045': ['Round scad / sardine (selayang, 8-12 per kg)', 'IKAN SELAYANG/SARDIN (ANTARA 8-12 EKOR SEKILOGRAM)', KG, 'daily'],
  '2047': ['Little tuna (tongkol/aya, 1-2 per kg)', 'IKAN TONGKOL/AYA/KAYU HITAM/PUTIH (ANTARA 1 HINGGA 2 EKOR SEKILOGRAM)', KG, 'daily'],
  '47': ['Torpedo scad (cencaru, 4-6 per kg)', 'IKAN CENCARU (ANTARA 4 HINGGA 6 EKOR SEKILOGRAM)', KG, 'daily'],
  '1436': ['Threadfin bream (kerisi, 5-10 per kg)', 'IKAN KERISI (ANTARA 5 HINGGA 10 EKOR SEKILOGRAM)', KG, 'daily'],
  '70': ['Scad (selar/pelata, up to 7 per kg)', 'IKAN SELAR/PELATA (≤ 7 EKOR SEKILOGRAM)', KG, 'daily'],
  '1476': ['Indian mackerel (kembung, 8-12 per kg)', 'IKAN KEMBUNG (ANTARA 8 HINGGA 12 EKOR SEKILOGRAM)', KG, 'daily'],
  '1477': ['Mabung fish (6-10 per kg)', 'IKAN MABUNG (ANTARA 6 HINGGA 10 EKOR SEKILOGRAM)', KG, 'daily'],
  '1555': ['Whiteleg shrimp, farmed (41-60 per kg)', 'UDANG PUTIH/VANNAMEI (TERNAK) (ANTARA 41 HINGGA 60 EKOR SEKILOGRAM)', KG, 'daily'],
  '845': ['Squid (11-17 per kg)', 'SOTONG (ANTARA 11 HINGGA17 EKOR SEKILOGRAM)', KG, 'daily'],
  '88': ['Catfish (keli, 2-5 per kg)', 'IKAN KELI (ANTARA 2 HINGGA 5 EKOR SEKILOGRAM)', KG, 'daily'],
  '1921': ['Red tilapia (2-5 per kg)', 'IKAN TILAPIA MERAH (ANTARA 2 HINGGA 5 EKOR SEKILOGRAM)', KG, 'daily'],
  '114': ['Tomatoes', 'TOMATO', KG, 'daily'],
  '113': ['Cucumber', 'TIMUN', KG, 'daily'],
  '109': ['Carrots', 'LOBAK MERAH', KG, 'daily'],
  '1481': ['Cauliflower', 'KUBIS BUNGA (CAULIFLOWER)', KG, 'daily'],
  '1458': ['Cabbage, imported (Beijing)', 'KUBIS BULAT IMPORT (BEIJING)', KG, 'daily'],
  '105': ['Cabbage, local', 'KUBIS BULAT (TEMPATAN)', KG, 'daily'],
  '96': ['Okra', 'KACANG BENDI', KG, 'daily'],
  '98': ['Long beans', 'KACANG PANJANG', KG, 'daily'],
  '97': ['French beans', 'KACANG BUNCIS', KG, 'daily'],
  '1558': ['Choy sum (sawi hijau)', 'SAWI HIJAU', KG, 'daily'],
  '1559': ['Water spinach (kangkung)', 'KANGKUNG', KG, 'daily'],
  '1556': ['Green amaranth (bayam hijau)', 'BAYAM HIJAU', KG, 'daily'],
  '1560': ['Kai lan', 'KAILAN', KG, 'daily'],
  '92': ['Green chilli', 'CILI HIJAU', KG, 'daily'],
  '94': ['Red chilli (minyak)', 'CILI MERAH - MINYAK', KG, 'daily'],
  '95': ['Ginger (mature)', 'HALIA BASAH (TUA)', KG, 'daily'],
  '129': ['Yellow onion (Holland)', 'BAWANG BESAR KUNING/HOLLAND', KG, 'daily'],
  '1440': ['Onion, imported (India)', 'BAWANG BESAR IMPORT (INDIA)', KG, 'daily'],
  '131': ['Shallots, rose, imported (India)', 'BAWANG KECIL MERAH ROSE IMPORT (INDIA)', KG, 'daily'],
  '1564': ['Garlic, imported (China)', 'BAWANG PUTIH IMPORT (CHINA)', KG, 'daily'],
  '1131': ['Potatoes, imported (China)', 'UBI KENTANG IMPORT (CHINA)', KG, 'daily'],
  '1132': ['Lime (limau nipis)', 'LIMAU NIPIS', KG, 'daily'],
  '1928': ['Calamansi (limau kasturi)', 'LIMAU KASTURI', KG, 'daily'],
  '2066': ['Rice, imported white (Faiza Emas)', 'BERAS PUTIH CAP FAIZA EMAS (IMPORT)', BAG10, 'basket'],
  '2068': ['Rice, imported (Jasmine Super 5 Special)', 'BERAS CAP JASMINE SUPER 5 SPECIAL (IMPORT)', BAG10, 'basket'],
  '904': ['Rice, imported super 5% (Rambutan)', 'BERAS SUPER CAP RAMBUTAN 5% (IMPORT)', BAG10, 'basket'],
  '918': ['Cooking oil, subsidised packet', 'MINYAK MASAK PAKET (PELBAGAI JENAMA)', KG, 'basket'],
  '266': ['Cooking oil, pure palm (Seri Murni)', 'MINYAK MASAK TULEN CAP SERI MURNI', BOTTLE5, 'basket'],
  '1094': ['Cooking oil, pure palm (Buruh)', 'MINYAK MASAK TULEN CAP BURUH', KG, 'basket'],
  '1589': ['White sugar, coarse', 'GULA PUTIH BERTAPIS KASAR (PELBAGAI JENAMA)', KG, 'basket'],
  '1590': ['White sugar, fine', 'GULA PUTIH BERTAPIS HALUS (PELBAGAI JENAMA)', KG, 'basket'],
  '917': ['Wheat flour (Sauh)', 'TEPUNG GANDUM NGP (BERBUNGKUS, CAP SAUH)', KG, 'basket'],
  '1870': ['Wheat flour (Faiza)', 'TEPUNG GANDUM NGP (BERBUNGKUS, CAP  FAIZA)', KG, 'basket'],
  '101': ['Coconut, whole', 'KELAPA BIJI', EACH, 'basket'],
  '102': ['Coconut, grated', 'KELAPA PARUT (BIASA)', KG, 'basket'],
  '14': ['Buffalo meat, imported India (topside)', 'DAGING KERBAU IMPORT (INDIA) * (TOP SIDE)', KG, 'basket'],
  '1914': ['Buffalo meat, imported India (block)', 'DAGING KERBAU IMPORT (INDIA) (BLOCK)', KG, 'basket'],
  '1431': ['Beef, local (thigh)', 'DAGING LEMBU TEMPATAN (BAHAGIAN 1 DAGING PAHA (KECUALI BATANG PINANG - TENDERLOIN)', KG, 'basket'],
  '18': ['Banana (pisang berangan)', 'PISANG BERANGAN', KG, 'basket'],
  '16': ['Papaya', 'BETIK BIASA', KG, 'basket'],
  '25': ['Pineapple', 'NENAS BIASA (JOSAPINE/MORRIS/SARAWAK)', EACH, 'basket'],
  '21': ['Watermelon, seedless', 'TEMBIKAI MERAH TANPA BIJI', KG, 'basket'],
};
export const PRICECATCHER_ITEM_CODES = Object.keys(ITEMS);
export const PRICECATCHER_DAILY_CODES = PRICECATCHER_ITEM_CODES.filter(code => ITEMS[code][3] === 'daily');
export const PRICECATCHER_BASKET_CODES = PRICECATCHER_ITEM_CODES.filter(code => ITEMS[code][3] === 'basket');
/** Display names of basket items; the source registry's `surveyItems` must list exactly these. */
export const PRICECATCHER_BASKET_NAMES = PRICECATCHER_BASKET_CODES.map(code => ITEMS[code][0]);
// Off-survey days still carry a few stray basket quotes (at most ~50 premises per item in November 2026, against
// hundreds to ~1,800 on survey days). A survey day needs at least this many basket quotes in total and half the
// window's busiest basket day, so a window without a survey cannot promote stray quotes to a latest price.
const BASKET_SURVEY_MIN_QUOTES = 1_000;
// Cap on distinct in-window premise quotes per monthly file (the current and prior month each get their own).
// Normal days hold about 30,000 selected quotes and the window spans at most 16 days (~462k measured), so
// this bounds memory without rejecting real files or dropping the prior month's week baseline.
const QUOTE_LIMIT = 1_000_000;

/** Start a per-date, per-item accumulator of unique premise quotes inside [since, before). */
export function priceAccumulator({ before, since, basketSince = since, limit = QUOTE_LIMIT }) {
  return { before, since, basketSince, limit, groups: new Map(), quotes: 0 };
}

/** Fold decoded rows into the accumulator, keeping one quote per premise and rejecting conflicting duplicates. */
export function addPriceRows(acc, rows) {
  for (const row of rows) {
    const code = String(row.item_code);
    if (!ITEMS[code]) continue;
    const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
    const from = ITEMS[code][3] === 'basket' ? acc.basketSince : acc.since;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= acc.before || date < from || !positive(row.price)) continue;
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
      unit: UNITS[unit], currency: 'MYR', date,
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

/**
 * Select the latest completed Malaysian day with every daily staple and its exact-week baseline, plus each basket
 * item's latest survey day and its most recent survey at least seven days earlier.
 */
export async function collect(ctx) {
  const lookup = new Map(csvRows(await ctx.get(`${BASE}lookup_item.csv`), ['item_code', 'item', 'unit']).map(row => [row.item_code, row]));
  // Today's collection can be partial. Report the latest completed local calendar day available.
  const before = new Date(ctx.now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const since = ctx.dated(ctx.now, -15);
  // Basket items need their previous survey, at least a week before a latest survey that can itself be days old.
  // 28 days always stays inside the current and previous monthly files.
  const basketSince = ctx.dated(ctx.now, -28);
  const current = before.slice(0, 7);
  const [year, month] = current.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 15)).toISOString().slice(0, 7);
  const acc = priceAccumulator({ before, since, basketSince });
  const loaded = new Set();
  try { await readPricecatcher(await ctx.get(`${BASE}pricecatcher_${current}.parquet`, { binary: true }), acc); loaded.add(current); }
  catch (error) { if (!/HTTP 404\b/.test(error.message)) throw error; ctx.warn('current-month file not yet published'); }
  if (basketSince.slice(0, 7) !== current) {
    // A prior-month failure must not leave a partly folded file behind, so read it into its own accumulator,
    // capped per file like the current month, and merge only on success. Monthly files hold disjoint dates.
    const prior = priceAccumulator({ before, since, basketSince });
    try {
      await readPricecatcher(await ctx.get(`${BASE}pricecatcher_${previous}.parquet`, { binary: true }), prior);
      for (const [key, shops] of prior.groups) acc.groups.set(key, shops);
      loaded.add(previous);
    } catch (error) { ctx.warn(`prior-month prices unavailable: ${error.message}`); }
  }
  const all = summarizePrices(acc, lookup);
  const daily = all.filter(row => DAILY_NAMES.has(row.item));
  const dates = [...new Set(daily.map(row => row.date))].sort().reverse();
  const latest = dates.find(date => daily.filter(row => row.date === date).length === PRICECATCHER_DAILY_CODES.length);
  const prior = latest ? ctx.dated(new Date(`${latest}T00:00:00Z`), -7) : '';
  const surveys = basketSurveyDates(acc);
  const basket = basketObservations(all, surveys);
  const observations = [...daily.filter(row => row.date === latest || row.date === prior), ...basket];
  const report = priceReport(observations, 'https://data.gov.my/data-catalogue/pricecatcher', ctx.now);
  // Daily and basket items report different dates, so history is refreshed per item and date: a basket survey on a
  // daily item's baseline day must not erase that day's daily rows, and vice versa. Markers cover every item and
  // date this run checked, not only the prices that passed, so a quote the publisher withdrew (or that fell below
  // ten premises) is dropped from history instead of surviving as a stale baseline. A daily date is only marked when
  // it lies in the daily window and its monthly file loaded, so a failed read cannot erase a stored baseline.
  const checked = [
    ...[latest, prior].filter(date => date && date >= since && loaded.has(date.slice(0, 7)))
      .flatMap(date => [...DAILY_NAMES].map(item => ({ date, item }))),
    // Every loaded date in the basket window, not only today's survey days, so a survey day the publisher withdraws
    // (or that no longer qualifies) cannot keep serving its old basket prices.
    ...windowDates(basketSince, before).filter(date => loaded.has(date.slice(0, 7)))
      .flatMap(date => PRICECATCHER_BASKET_NAMES.map(item => ({ date, item }))),
  ];
  return { ...report, refreshedReports: checked };
}

/** ISO dates from `since` (inclusive) to `before` (exclusive). */
function windowDates(since, before) {
  const dates = [];
  for (let ms = Date.parse(`${since}T00:00:00Z`); ms < Date.parse(`${before}T00:00:00Z`); ms += 86_400_000) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}

const DAILY_NAMES = new Set(PRICECATCHER_DAILY_CODES.map(code => ITEMS[code][0]));

/** Each basket item's latest survey-day median and its most recent survey-day median at least seven days earlier. */
export function basketObservations(rows, surveys) {
  return PRICECATCHER_BASKET_CODES.flatMap(code => {
    const series = rows.filter(row => row.item === ITEMS[code][0] && surveys.has(row.date)).sort((a, b) => b.date.localeCompare(a.date));
    if (!series.length) return [];
    const cutoff = new Date(Date.parse(`${series[0].date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    return [series[0], ...series.filter(row => row.date <= cutoff).slice(0, 1)];
  });
}

/** Dates in the accumulator that are basket-survey days, judged by total basket quotes rather than per item. */
export function basketSurveyDates(acc) {
  const totals = new Map();
  for (const [key, shops] of acc.groups) {
    const [date, code] = key.split('|');
    if (ITEMS[code][3] === 'basket') totals.set(date, (totals.get(date) ?? 0) + shops.size);
  }
  const busiest = Math.max(0, ...totals.values());
  return new Set([...totals].filter(([, total]) => total >= Math.max(BASKET_SURVEY_MIN_QUOTES, busiest / 2)).map(([date]) => date));
}
