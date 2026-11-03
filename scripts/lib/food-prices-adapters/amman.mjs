import { isoDate, plainText } from '../food-prices.mjs';

export const AMMAN_URL = 'https://ammancity.gov.jo/ar/market/prices.aspx';
const MARKET = 'Amman Central Market';
const UNITS = { 'كيلو': 'kg' };
const LABELS = { date: 'تاريخ السعر', high: 'السعر الأعلى', mode: 'السعر الأغلب', low: 'السعر الأدنى', pack: 'العبوة' };
export const AMMAN_ITEMS = {
  'ابو صرة': 'Orange (navel)', 'شموطي': 'Orange (Shamouti)', 'ماوردي/دم زغلول': 'Orange (blood)', 'فرنساوي': 'Faransawi',
  'كلمنتينا/ميرندا': 'Clementine/Mandarin', 'كريفوت': 'Grapefruit', 'بوملي': 'Pomelo', 'ليمون': 'Lemon', 'كيم كواك': 'Kumquat',
  'خشخاش/كبارينو/ميخال/بومليت': 'Citrus (Khashkhash/Michal/Pomelit)',
  'اسود بتيري': 'Eggplant (Battiri)', 'اسود رفيع': 'Eggplant (thin)', 'اسود عجمي': 'Eggplant (Ajami)', 'اسود كلاسيك': 'Eggplant (classic)',
  'مقدوس باذنجان': 'Eggplant (makdous)', 'أفوجادو': 'Avocado', 'إنجاص': 'Pear', 'باباي': 'Papaya', 'بازيلاء': 'Peas', 'باميا': 'Okra',
  'بروكلي': 'Broccoli', 'بصل اخضر': 'Onion (green)', 'بصل ناشف': 'Onion (dry)', 'بطاطا': 'Potato', 'بطيخ': 'Watermelon',
  'بقدونس': 'Parsley', 'بقلة': 'Purslane', 'بلح': 'Dates (fresh)', 'تمر': 'Dates (dried)', 'بندورة': 'Tomato',
  'بندوره كرز': 'Tomato (cherry)', 'بندوره معلقه': 'Tomato (trellised)', 'تفاح': 'Apple', 'توت': 'Mulberry', 'تين': 'Fig',
  'قطين': 'Fig (dried)', 'ثوم': 'Garlic', 'جرجير': 'Rocket', 'جزر بدون ورق': 'Carrot (without leaves)', 'جزر مع الورق': 'Carrot (with leaves)',
  'جوافة/فجيوه': 'Guava/Feijoa', 'حاره حمراء': 'Hot pepper (red)', 'فلفل حار': 'Hot pepper', 'حروش': 'Harroush',
  'حلوه/اخضر': 'Sweet pepper (green)', 'حلوه/حمراء': 'Sweet pepper (red)', 'حلوه/صفراء': 'Sweet pepper (yellow)',
  'حصالبان (اكليل الجبل)': 'Rosemary', 'حويرنة': 'Hweirneh (wild greens)', 'خبيزة': 'Mallow', 'خس': 'Lettuce',
  'خس أحمر': 'Lettuce (red)', 'خس صيني': 'Lettuce (Chinese)', 'خوخ': 'Plum', 'دراق': 'Peach', 'دراق كعكه': 'Peach (flat)',
  'نكترين': 'Nectarine', 'خيار': 'Cucumber', 'خيار بيبي': 'Cucumber (baby)', 'فقوس': 'Armenian cucumber', 'دبس': 'Grape molasses',
  'دراجون': 'Dragon fruit', 'دوالي': 'Vine leaves', 'ذره': 'Corn', 'رشاد': 'Garden cress', 'رمان': 'Pomegranate', 'ريحان': 'Basil',
  'زعتر': 'Thyme', 'زهرة': 'Cauliflower', 'زيتون': 'Olives', 'سبانخ': 'Spinach', 'سفرجل': 'Quince', 'سلق': 'Chard', 'شبث': 'Dill',
  'شمام': 'Melon', 'شمندر': 'Beetroot', 'شومر': 'Fennel', 'صبر': 'Prickly pear', 'عنب': 'Grapes', 'فاصوليا': 'Green beans',
  'فجل بدون ورق': 'Radish (without leaves)', 'فجل مع الورق': 'Radish (with leaves)', 'فراولة': 'Strawberry', 'فطر': 'Mushroom',
  'فول اخضر': 'Broad beans (green)', 'قرع': 'Squash', 'يقطين': 'Pumpkin', 'كاكا': 'Persimmon', 'كراث بدون ورق': 'Leek (without leaves)',
  'كراث مع ورق': 'Leek (with leaves)', 'كرفس (سلري)': 'Celery', 'كركم': 'Turmeric', 'كزبرة': 'Coriander', 'كوسا': 'Zucchini',
  'كيل ( كرنب اجعد )': 'Kale', 'لفت': 'Turnip', 'لوبيا': 'Cowpeas', 'ملفوف': 'Cabbage', 'ملفوف أحمر': 'Cabbage (red)',
  'ملوخية فرط': 'Jute mallow (loose leaves)', 'ملوخيه': 'Jute mallow', 'منجا': 'Mango', 'موز بلدي': 'Banana (local)',
  'ميرمية': 'Sage', 'نعنع': 'Mint', 'هندبة': 'Chicory',
};

const arabicKey = value => value.replace(/ـ/g, '').replace(/\s+/g, ' ').trim();
const number = value => (/^\d+(?:\.\d+)?$/.test(value ?? '') ? Number(value) : null);

export function ammanReportDate(html) {
  const match = /أسعار الخضار والفواكه\s+(\d{2})-(\d{2})-(\d{4})/.exec(plainText(html));
  const date = match ? isoDate(match[3], match[2], match[1]) : '';
  if (!date) throw new Error('amman report date missing; format changed');
  return date;
}

// Splits the page at each card header and searches only inside that slice, so every byte is scanned
// a bounded number of times and a header without a body cannot rescan the page (CWE-1333).
function ammanCards(html) {
  const HEADER = 'class="card-header bg-brown';
  return html.split(HEADER).slice(1).flatMap(card => {
    const headStart = card.indexOf('>', card.indexOf('"') + 1) + 1;
    const headEnd = headStart ? card.indexOf('</div>', headStart) : -1;
    const bodyAt = headEnd === -1 ? -1 : card.indexOf('class="card-body"', headEnd);
    const bodyStart = bodyAt === -1 ? 0 : card.indexOf('>', bodyAt) + 1;
    const bodyEnd = bodyStart ? card.indexOf('</div>', bodyStart) : -1;
    return bodyEnd === -1 ? [] : [[null, card.slice(headStart, headEnd), card.slice(bodyStart, bodyEnd)]];
  });
}

export function parseAmman(html, expectedDate, skipped = []) {
  const date = ammanReportDate(html);
  if (expectedDate && date !== expectedDate) throw new Error('amman report date mismatch');
  const cards = ammanCards(html);
  const disordered = [];
  const seen = new Set();
  const rows = cards.flatMap(([, header, body]) => {
    const name = arabicKey(plainText(header));
    const text = plainText(body);
    const field = (label, value = '(\\S*)') => new RegExp(`${label}:\\s*${value}`).exec(text);
    const prices = ['high', 'mode', 'low'].map(key => field(LABELS[key], '([\\d.]*)\\s*(\\S*)'));
    if (!name || prices.some(match => !match || match[2] !== 'قرش')) throw new Error('amman card layout or qirsh unit changed; format changed');
    const cardDate = field(LABELS.date, '(\\d{2})-(\\d{2})-(\\d{4})');
    if (!cardDate || isoDate(cardDate[3], cardDate[2], cardDate[1]) !== date) throw new Error('amman card date mismatch');
    const unit = UNITS[field(LABELS.pack)?.[1]];
    const [high, mode, low] = prices.map(match => number(match[1]));
    const item = AMMAN_ITEMS[name];
    if (!item) return skipped.push(`${name}: no English name`), [];
    if (!unit) return skipped.push(`${name}: unknown package`), [];
    if (!mode) return skipped.push(`${name}: no modal price`), [];
    if (high !== null && low !== null && !(high >= mode && mode >= low)) return disordered.push(name), skipped.push(`${name}: high/mode/low out of order`), [];
    if (seen.has(item)) return skipped.push(`${name}: duplicate item`), [];
    seen.add(item);
    return [{ item, market: MARKET, marketType: 'wholesale', unit, currency: 'JOD', date, price: Math.round(mode * 10) / 1000, origin: '' }];
  });
  if (disordered.length > Math.max(2, cards.length * 0.1)) throw new Error('amman high/mode/low price order changed; format changed');
  return rows;
}

// ASP.NET writes name then value a few characters apart; the bound keeps a page full of bare names
// from rescanning the body once per name (CWE-1333).
export const ammanFormState = html => {
  const field = name => new RegExp(`name="${name}"[^<>]{0,512}?value="([^"]*)"`).exec(html)?.[1];
  const state = { __VIEWSTATE: field('__VIEWSTATE'), __VIEWSTATEGENERATOR: field('__VIEWSTATEGENERATOR'), __EVENTVALIDATION: field('__EVENTVALIDATION') };
  return Object.values(state).every(Boolean) ? state : null;
};

export async function collect(ctx) {
  const first = await ctx.get(AMMAN_URL);
  let state = ammanFormState(first);
  if (!state) throw new Error('amman ASP.NET form state missing; format changed');
  const report = async date => {
    const html = date === ammanReportDate(first) ? first : await ctx.get(AMMAN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btnSearch', __EVENTARGUMENT: '', __LASTFOCUS: '', __VIEWSTATEENCRYPTED: '', ...state,
        'ctl00$ContentPlaceHolder1$txtfromdate': date.split('-').reverse().join('-'),
        'ctl00$ContentPlaceHolder1$txttodate': date.split('-').reverse().join('-'),
        'ctl00$ContentPlaceHolder1$FruitType': 'rbLocal',
      }).toString(),
    });
    state = ammanFormState(html) ?? state;
    const skipped = [];
    const rows = parseAmman(html, date, skipped);
    if (skipped.length) ctx.warn(`${date} skipped ${skipped.join('; ')}`);
    return rows;
  };
  const observations = [];
  const refreshedReports = [];
  let latest = '';
  for (let offset = 0; offset >= -4 && !latest; offset--) {
    const date = ctx.dated(ctx.now, offset);
    const rows = await report(date);
    if (rows.length) {
      latest = date;
      observations.push(...rows);
      refreshedReports.push({ date });
    }
  }
  if (!latest) throw new Error('amman has no report in the last five days');
  const prior = ctx.dated(new Date(`${latest}T00:00:00Z`), -7);
  try {
    const rows = await report(prior);
    if (rows.length) {
      observations.push(...rows);
      refreshedReports.push({ date: prior });
    } else ctx.warn(`prior-week report ${prior} has no prices`);
  } catch (error) {
    ctx.warn(`prior-week report unavailable: ${error.message}`);
  }
  return { observations, contexts: [], refreshedReports, reportUrl: AMMAN_URL };
}
