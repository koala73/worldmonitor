import { htmlElements, isoDate } from '../food-prices.mjs';

export const NABC_FARM_PRICES_URL = 'https://www.nabc.go.th/dashboard/farm-prices';
const DAY = 86400000;
// OAE daily prices that major buying markets (rice mills, rice ports, buying
// yards, central markets) paid farmers, keyed by the dashboard's product key.
// The dashboard also lists rubber sheet, which is not a food price.
export const NABC_BASKET = {
  rice_hommali: { item: 'Paddy rice, Hom Mali 105', unit: 'tonne', unitEn: 'THB/tonne' },
  maize145: { item: 'Feed maize grain (14.5% moisture)', unit: 'kg', unitEn: 'THB/kg' },
  cassava25: { item: 'Fresh cassava (25% starch)', unit: 'kg', unitEn: 'THB/kg' },
  palm_ffb15: { item: 'Oil palm fresh fruit bunches (over 15 kg)', unit: 'kg', unitEn: 'THB/kg' },
  swine: { item: 'Live hogs (over 100 kg)', unit: 'kg', unitEn: 'THB/kg' },
  broiler: { item: 'Live broilers', unit: 'kg', unitEn: 'THB/kg' },
  egg: { item: 'Chicken eggs', unit: '100 eggs', unitEn: 'THB/100 eggs' },
};
// The dashboard shows each day's low-high range across reporting markets; its
// payload also carries the median, which is the one figure comparable week on week.
const MARKET = 'Major buying markets (median)';

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const validDate = value => typeof value === 'string' && isoDate(...value.split('-')) === value;

const MAX_NUXT_DEPTH = 64;

export function nuxtData(html, key) {
  const raw = htmlElements(html, ['script']).find(([open]) => /\bid=["']__NUXT_DATA__["']/i.test(open))?.[1];
  if (!raw) throw new Error('nabc page payload format changed');
  const nodes = JSON.parse(raw);
  const memo = new Map();
  // One stack frame per reference link, so a crafted chain could overflow the stack. Real pages
  // nest about nine deep (CWE-674).
  const revive = (index, depth = 0) => {
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) return undefined;
    if (memo.has(index)) return memo.get(index);
    if (depth > MAX_NUXT_DEPTH) throw new Error('nabc page payload nested too deeply');
    const node = nodes[index];
    let value = node;
    memo.set(index, undefined);
    const child = next => revive(next, depth + 1);
    if (Array.isArray(node)) value = typeof node[0] === 'string' && /^(?:Shallow)?(?:Reactive|Ref)$/.test(node[0]) ? child(node[1]) : node.map(next => child(next));
    else if (node && typeof node === 'object') value = Object.fromEntries(Object.entries(node).map(([name, next]) => [name, child(next)]));
    memo.set(index, value);
    return value;
  };
  const root = nodes[0];
  const app = Array.isArray(root) ? nodes[root[1]] : root;
  const data = nodes[app?.data];
  const entries = Array.isArray(data) ? nodes[data[1]] : data;
  if (!entries || !Number.isInteger(entries[key])) throw new Error(`nabc page payload format changed: ${key} missing`);
  return revive(entries[key]);
}

export function parseNabcFarmPrices(html) {
  const products = nuxtData(html, 'farm-prices-detail')?.products;
  if (!Array.isArray(products)) throw new Error('nabc page payload format changed');
  const series = new Map();
  for (const [key, spec] of Object.entries(NABC_BASKET)) {
    const product = products.find(p => p?.key === key);
    if (!product) continue;
    if (product.unit_en !== spec.unitEn || !Array.isArray(product.series)
      || !product.series.every(point => validDate(point?.d))) throw new Error(`nabc ${key} format changed`);
    series.set(key, new Map(product.series.map(point => [point.d, point.med])));
  }
  const date = [...series.values()].flatMap(points => [...points.keys()]).sort().at(-1);
  if (!date) throw new Error('nabc has no food prices');
  const dates = [shiftDate(date, -7), date];
  const rows = [];
  const missing = [];
  for (const [key, { item, unit }] of Object.entries(NABC_BASKET)) {
    const points = series.get(key);
    const priced = day => typeof points?.get(day) === 'number' && points.get(day) > 0;
    if (!priced(date)) { missing.push(item); continue; }
    for (const day of dates.filter(priced)) {
      rows.push({ item, market: MARKET, marketType: 'farmgate', unit, currency: 'THB', date: day, price: points.get(day), origin: '' });
    }
  }
  return { date, rows, missing };
}

export async function collect(ctx) {
  const { date, rows, missing } = parseNabcFarmPrices(await ctx.get(NABC_FARM_PRICES_URL));
  if (missing.length) ctx.warn(`${date} lacks ${missing.join(', ')}`);
  if (!rows.some(row => row.date !== date)) ctx.warn(`no prices for ${shiftDate(date, -7)}`);
  const refreshedReports = [...new Set(rows.map(row => row.date))].map(day => ({ date: day }));
  return { observations: rows, contexts: [], refreshedReports, reportUrl: NABC_FARM_PRICES_URL };
}
