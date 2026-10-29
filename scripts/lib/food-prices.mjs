import { decodeHtmlEntities } from '../_html-entities.mjs';

export const plainText = value => decodeHtmlEntities(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const pad = value => String(value).padStart(2, '0');

export function isoDate(year, month, day) {
  const result = `${year}-${pad(month)}-${pad(day)}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result ? result : '';
}

const dmy = value => {
  const match = /^(\d{2})[/.\-](\d{2})[/.\-](\d{4})$/.exec(value);
  return match ? isoDate(match[3], match[2], match[1]) : '';
};
const price = value => {
  const text = String(value ?? '').trim().replace(/,/g, '');
  return /^\d+(?:\.\d+)?$/.test(text) && Number(text) > 0 ? Number(text) : null;
};
const observation = (item, market, marketType, unit, currency, date, value, origin = '') => {
  const amount = price(value);
  return amount !== null && date && item && market && unit
    ? { item, market, marketType, unit, currency, date, price: amount, origin }
    : null;
};

export function parsePihps(payload, commodity) {
  return (payload?.data ?? []).filter(row => row.level === 0).flatMap(row =>
    Object.entries(row).flatMap(([key, value]) => {
      const result = observation(commodity.name, row.name, 'retail', commodity.denomination, 'IDR', dmy(key), value);
      return result ? [result] : [];
    }));
}

export function parsePbs(sheets) {
  const result = [];
  for (const rows of sheets) {
    const headers = rows.flatMap((row, i) => row.includes('DESCRIPTION') && row.includes('UNIT') ? [i] : []);
    for (const [block, header] of headers.entries()) {
      const dateText = rows[header + 2]?.find(value => /PRICES ON \d{2}-\d{2}-\d{4}/.test(String(value)));
      const date = dmy(String(dateText).match(/\d{2}-\d{2}-\d{4}/)?.[0] ?? '');
      if (!date) throw new Error('PBS report date missing');
      const cities = rows[header - 1];
      for (const row of rows.slice(header + 3, headers[block + 1] === undefined ? undefined : headers[block + 1] - 1)) {
        if (typeof row[0] !== 'number' || typeof row[1] !== 'string' || typeof row[2] !== 'string') continue;
        // SPI also contains fuel, tobacco and services. Keep the food part of the published basket.
        if (!/\b(?:rice|wheat|bread|beef|mutton|chicken|milk|curd|eggs?|oil|ghee|sugar|gur|pulse|potatoes|onions|tomatoes|chilies|salt|garlic|bananas|tea|daal)\b/i.test(row[1])) continue;
        for (let i = 3; i < cities.length - 1; i += 3) {
          if (rows[header][i + 1] !== 'AVG') continue;
          const value = observation(row[1], cities[i], 'retail', row[2], 'PKR', date, row[i + 1]);
          if (value) result.push(value);
        }
      }
    }
  }
  if (!result.length) throw new Error('PBS workbook has no dated food prices');
  return result;
}

function pdfRows(items) {
  const rows = [];
  for (const item of [...items].filter(item => item.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find(row => Math.abs(row.y - item.y) < 1.5);
    if (!row) rows.push(row = { y: item.y, items: [] });
    row.items.push(item);
  }
  return rows.map(row => ({ ...row, items: row.items.sort((a, b) => a.x - b.x) }));
}

const DA_COLUMNS = [
  ['Premium Rice (Imported)', 'Well-milled Rice (Imported)', 'Premium Rice (Local)', 'Well-milled Rice (Local)', 'Regular Milled (Local)', 'Bangus', 'Tilapia', 'Galunggong (Local)', 'Egg (Medium)', 'Ampalaya'],
  ['Eggplant', 'Tomato', 'Cabbage', 'Carrots (Local)', 'Chayote', 'Pechay Baguio', 'White Potato (Local)', 'Red Onion (Local)', 'White Onion (Local)'],
  ['Chili (Green)', 'Red Chili (Local)', 'Calamansi', 'Sugar (Refined)', 'Fresh Pork (Kasim, Local)', 'Fresh Pork (Kasim, Imported)', 'Fresh Pork Liempo (Local)', 'Fresh Pork Liempo (Imported)', 'Fresh Whole Chicken'],
];
const DA_HEADER_X = [
  [189.9, 245.4, 308.9, 364.7, 421.6, 485.9, 545.1, 588.1, 656.3, 723.6],
  [228.1, 289, 345.8, 397.7, 468.2, 517.9, 572.6, 636, 702.6],
  [220.7, 274.9, 342.5, 392, 446.2, 507.7, 569.1, 629.5, 698.4],
];

export function parseDa(pages, date) {
  const result = [];
  const [year, month, day] = date.split('-');
  const printedDates = [`${EN_MONTHS[Number(month) - 1]} ${Number(day)},${year}`, `${Number(day)} ${EN_MONTHS[Number(month) - 1]} ${year}`];
  for (const [page, columns] of DA_COLUMNS.entries()) {
    const items = pages[page];
    const text = items?.map(item => item.text).join(' ') ?? '';
    if (!printedDates.some(printed => text.toLowerCase().replace(/\s*,\s*/g, ',').includes(printed))) throw new Error('DA report date mismatch');
    if (!text.includes('COMMODITY (PHP/KG)') || !text.includes(columns[0]) || !text.includes('MARKET')) throw new Error('DA food PDF format changed');
    const headerY = items.find(item => item.text === 'COMMODITY (PHP/KG)').y;
    const normalize = text => text.toLowerCase().replace(/[^a-z]/g, '');
    for (const [index, column] of columns.entries()) {
      const parts = items.filter(item => item.y >= headerY - 25 && item.y < headerY - 5
        && item.x >= DA_HEADER_X[page][index] - 5 && item.x < (DA_HEADER_X[page][index + 1] ?? 800) - 5)
        .sort((a, b) => b.y - a.y || a.x - b.x);
      if (normalize(parts.map(item => item.text).join('')) !== normalize(column)) throw new Error('DA food PDF column layout changed');
    }
    for (const row of pdfRows(items)) {
      const cells = row.items.filter(item => item.x > 180 && /^(?:\d+(?:\.\d+)?|NOT AVAILABLE)$/.test(item.text));
      const market = row.items.filter(item => item.x < 180).map(item => item.text).join('').trim();
      if (cells.length !== columns.length || !market) continue;
      for (const [i, item] of columns.entries()) {
        const value = observation(item, market, 'retail', item === 'Egg (Medium)' ? 'piece' : 'kg', 'PHP', date, cells[i].text);
        if (value) result.push(value);
      }
    }
  }
  return result;
}

export function parseCbsl(pages, date) {
  const items = pages.flat();
  const text = items.map(item => item.text).join(' ');
  if (!text.includes('Wholesale and Retail Prices') || !text.includes('Narahenpita') || !text.includes('Today')) throw new Error('CBSL food PDF format changed');
  const [year, month, day] = date.split('-');
  if (!text.toLowerCase().includes(`${Number(day)} ${EN_MONTHS[Number(month) - 1]} ${year}`)) throw new Error('CBSL report date mismatch');
  const columns = [
    ['Pettah', 'wholesale', 200, 240], ['Dambulla', 'wholesale', 280, 325],
    ['Pettah', 'retail', 365, 405], ['Dambulla', 'retail', 450, 490], ['Narahenpita', 'retail', 532, 575],
  ];
  for (const [market, , left, right] of columns) {
    const today = items.find(item => item.text === 'Today' && item.x >= left && item.x < right);
    const marketHeader = items.find(item => item.text === market && item.x >= left - 32 && item.x < right && item.y > (today?.y ?? Infinity));
    if (!today || !marketHeader || marketHeader.y - today.y > 25) throw new Error('CBSL food PDF column layout changed');
  }
  for (const [text, left, right] of [['Wholesale Prices', 185, 215], ['Retail Prices', 405, 435]]) {
    if (!items.some(item => item.text === text && item.x >= left && item.x < right)) throw new Error('CBSL food PDF market layout changed');
  }
  return pdfRows(items).flatMap(row => {
    const item = row.items.filter(item => item.x < 110).map(item => item.text).join(' ').trim();
    const unit = row.items.find(item => item.x >= 110 && item.x < 150 && /^Rs\.\//.test(item.text))?.text.replace(/^Rs\.\//, '');
    if (!unit || !item) return [];
    return columns.flatMap(([market, kind, left, right]) => {
      const cell = row.items.find(item => item.x >= left && item.x < right && /^(?:[\d,.]+|[-–])$/.test(item.text));
      const value = observation(item, market, kind, unit, 'LKR', date, cell?.text);
      return value ? [value] : [];
    });
  });
}

function tableRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
    [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => plainText(cell[1])));
}

export function parseSniim(html, item, expectedDate) {
  const pages = /P[aá]gina\s*\d+\s*de\s*(\d+)/i.exec(plainText(html));
  if (pages && Number(pages[1]) > 1) throw new Error('SNIIM result is paginated');
  const range = /Registros del\s+(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/.exec(plainText(html));
  const singleDate = range && range[1] === range[2] ? dmy(range[1]) : '';
  if (expectedDate && singleDate !== expectedDate) throw new Error('SNIIM report date mismatch');
  return tableRows(html).flatMap(row => {
    const cells = row[0] === 'Kilogramo' && singleDate ? [range[1], ...row] : row;
    if (cells.length < 7 || cells[1] !== 'Kilogramo') return [];
    const value = observation(item, cells[3], 'wholesale', 'kg', 'MXN', dmy(cells[0]), cells[6], cells[2]);
    return value ? [value] : [];
  });
}

export function parseOnagri(html, month) {
  const text = plainText(html);
  const year = month.slice(0, 4);
  if (!text.includes(year) || !text.includes(String(Number(year) - 1))) throw new Error('ONAGRI report year mismatch');
  if (!text.includes('مليم/كلغ')) throw new Error('ONAGRI price unit missing');
  return tableRows(html).flatMap(row => {
    const cells = row.filter(Boolean);
    if (cells.length !== 8 || !/^\d+$/.test(cells[0]) || !/[\u0600-\u06ff]/.test(cells[7])) return [];
    const millimes = price(cells[3].replace(/\s/g, ''));
    const value = observation(cells[7], 'Bir El Kassaa', 'wholesale', 'kg', 'TND', month, millimes === null ? null : millimes / 1000);
    return value ? [value] : [];
  });
}

export function parseGiews(html, country) {
  const text = plainText(html);
  const match = /Reference Date:\s*(\d{1,2})-([A-Za-z]+)-(\d{4})/.exec(text);
  const referenceDate = match ? isoDate(match[3], EN_MONTHS.indexOf(match[2].toLowerCase()) + 1, match[1]) : '';
  if (!referenceDate || !text.includes('FOOD SECURITY SNAPSHOT')) throw new Error('GIEWS reference date missing');
  return { countryCode: country.code, country: country.name, referenceDate, title: `GIEWS country brief: ${country.name}`, url: `https://www.fao.org/giews/countrybrief/country.jsp?code=${country.code}&lang=en` };
}

export function giewsCountries(html) {
  const countries = new Map();
  for (const match of html.matchAll(/<option\b[^>]*value=["']country\.jsp\?[^"']*code=([A-Z]{3})[^"']*["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    countries.set(match[1], { code: match[1], name: plainText(match[2]) });
  }
  return [...countries.values()];
}

const REPORT_BASES = {
  da: 'https://www.da.gov.ph/price-monitoring/',
  cbsl: 'https://www.cbsl.gov.lk/en/statistics/economic-indicators/price-report',
  pbs: 'https://www.pbs.gov.pk/price-statistics/',
  onagri: 'https://www.onagri.nat.tn/Marche-de-gros-bir-el-kasaa/fr/62',
};
export function discoverReports(html, source) {
  const base = REPORT_BASES[source];
  if (!base) throw new Error('unknown food report source');
  const reports = new Map();
  if (source === 'pbs') {
    for (const match of html.matchAll(/annexureExcel\s*:\s*["']([^"']+)["']/gi)) {
      const url = new URL(decodeHtmlEntities(match[1]), new URL('/', base));
      const parts = /\/Annex_(\d{2})\.(\d{2})\.(\d{4})\.xlsx$/i.exec(url.pathname);
      const date = parts ? isoDate(parts[3], parts[2], parts[1]) : '';
      if (date && url.hostname === new URL(base).hostname && url.protocol === 'https:') reports.set(date, { date, url: url.href });
    }
  }
  const hasAnnexReports = reports.size > 0;
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(decodeHtmlEntities(match[1]), base); } catch { continue; }
    if (url.hostname !== new URL(base).hostname || url.protocol !== 'https:') continue;
    let date = '';
    if (source === 'da') {
      const parts = /^Price-Monitoring-([A-Za-z]+)-(\d{1,2})-(\d{4})\.pdf$/i.exec(url.pathname.split('/').at(-1));
      if (parts) date = isoDate(parts[3], EN_MONTHS.indexOf(parts[1].toLowerCase()) + 1, parts[2]);
    } else if (source === 'cbsl') {
      const parts = /price_report_(\d{4})(\d{2})(\d{2})_e\.pdf$/i.exec(url.pathname);
      if (parts) date = isoDate(parts[1], parts[2], parts[3]);
    } else if (source === 'pbs' && !hasAnnexReports) {
      const parts = /weekly-sensitive-price-indicator.*?(\d{2})-(\d{2})-(\d{4})\/?$/i.exec(url.pathname);
      if (parts) date = isoDate(parts[3], parts[2], parts[1]);
    } else {
      const parts = /Mercuriale Bir El Kassaa\s+([^\s]+)\s+(\d{4})/i.exec(plainText(match[2]));
      if (parts && /\/uploads\/[^/]+\.html$/.test(url.pathname)) date = isoDate(parts[2], FR_MONTHS.indexOf(parts[1].toLowerCase()) + 1, 1);
    }
    if (date) reports.set(date, { date, url: url.href });
  }
  return [...reports.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export function seriesKey(row) {
  return JSON.stringify([row.market, row.marketType, row.item, row.unit, row.currency, row.origin ?? '']);
}

export function mergeHistory(previous, incoming, refreshedReports = [...new Set(incoming.map(row => row.date))].map(date => ({ date }))) {
  const rows = new Map();
  const newest = incoming.map(row => row.date).sort().at(-1);
  if (!newest) throw new Error('no dated food prices');
  const cutoff = new Date(Date.parse(newest) - 14 * 86400000).toISOString().slice(0, 10);
  const retained = previous.filter(row => !refreshedReports.some(report => report.date === row.date && (!report.item || report.item === row.item)));
  for (const row of [...retained, ...incoming]) {
    if (row.date >= cutoff && row.date <= newest && Number.isFinite(row.price) && row.price > 0) rows.set(`${seriesKey(row)}|${row.date}`, row);
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || seriesKey(a).localeCompare(seriesKey(b)));
}
