import { htmlElements, isoDate } from '../food-prices.mjs';

const BASE = 'https://www.nabc.go.th/commodity/';
const DAY = 86400000;
const UNITS = { 'บาท/ตัน': 'tonne', 'บาท/กก.': 'kg', 'บาท/ร้อยฟอง': '100 eggs' };
// OAE weekly farm-gate national averages, one NABC commodity page per entry.
export const NABC_BASKET = {
  'ข้าว': {
    'ข้าวเปลือกเจ้า ความชื้น 15%': 'Paddy rice, white (15% moisture)',
    'ข้าวเปลือกเจ้า ความชื้น 24-25%': 'Paddy rice, white (24-25% moisture)',
    'ข้าวเปลือกเจ้าหอมมะลิ ความชื้น 15%': 'Paddy rice, Hom Mali (15% moisture)',
    'ข้าวเปลือกเหนียวเมล็ดยาว ความชื้น 15%': 'Paddy rice, glutinous long-grain (15% moisture)',
  },
  'ข้าวโพดเลี้ยงสัตว์': { 'ข้าวโพดเลี้ยงสัตว์เมล็ด ความชื้น 14.5%': 'Feed maize grain (14.5% moisture)' },
  'มันสำปะหลัง': {
    'มันสำปะหลังสด คละ': 'Fresh cassava (mixed)',
    'มันสำปะหลังสดเชื้อแป้ง 25%': 'Fresh cassava (25% starch)',
  },
  'ไข่ไก่': {
    'ไข่ไก่สด คละ': 'Chicken eggs (mixed sizes)',
    'ไข่ไก่สด เบอร์ 3': 'Chicken eggs (size 3)',
  },
  'สุกร': { 'สุกรมีชีวิต น้ำหนักเกิน 100 กก.': 'Live hogs (over 100 kg)' },
  'ปาล์มน้ำมัน': { 'ผลปาล์มน้ำมันทั้งทะลาย คละ': 'Oil palm fresh fruit bunches (mixed)' },
  'ไก่เนื้อ': {
    'ไก่รุ่นพันธุ์เนื้อ ฟาร์มอิสระ': 'Live broilers (independent farms)',
    'ไก่รุ่นพันธุ์เนื้อ ฟาร์มประกัน': 'Live broilers (contract farms)',
  },
};

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

export function parseNabcCommodity(html, th) {
  const variants = NABC_BASKET[th];
  if (!variants) throw new Error('unknown nabc commodity');
  const commodity = nuxtData(html, `commodity-${th}`);
  const date = commodity?.weeklyLast;
  if (commodity?.th !== th || !Array.isArray(commodity.weekly) || !validDate(date)) throw new Error('nabc commodity format changed');
  const dates = [date, shiftDate(date, -7)];
  const rows = [];
  const missing = [];
  for (const [name, item] of Object.entries(variants)) {
    const series = commodity.weekly.find(series => series?.name === name);
    if (!series) { missing.push(name); continue; }
    const unit = UNITS[series.unit];
    if (!unit || !Array.isArray(series.national)) throw new Error(`nabc ${name} format changed`);
    for (const week of series.national) {
      const span = (Date.parse(week?.we) - Date.parse(week?.ws)) / DAY;
      if (!validDate(week?.ws) || !validDate(week.we) || !(span >= 0 && span <= 6)) throw new Error(`nabc ${name} week format changed`);
      if (!dates.includes(week.ws) || !(typeof week.price === 'number' && week.price > 0)) continue;
      rows.push({ item, market: 'National average', marketType: 'farmgate', unit, currency: 'THB', date: week.ws, price: week.price, origin: '' });
    }
    if (!rows.some(row => row.item === item && row.date === date)) missing.push(name);
  }
  if (!rows.some(row => row.date === date)) throw new Error(`nabc ${th} has no latest-week national prices`);
  return { date, rows, missing };
}

export async function collect(ctx) {
  const observations = [];
  for (const th of Object.keys(NABC_BASKET)) {
    const { date, rows, missing } = parseNabcCommodity(await ctx.get(`${BASE}${encodeURIComponent(th)}`), th);
    if (missing.length) ctx.warn(`latest week ${date} lacks ${missing.join(', ')}`);
    if (!rows.some(row => row.date !== date)) ctx.warn(`${th} has no national prices for the week of ${shiftDate(date, -7)}`);
    observations.push(...rows);
  }
  const refreshedReports = [...new Set(observations.map(row => row.date))].map(date => ({ date }));
  return { observations, contexts: [], refreshedReports, reportUrl: BASE.replace(/\/$/, '') };
}
