import { isoDate } from '../food-prices.mjs';

const UCDA_HOME_URL = 'https://ugandacoffee.go.ug/';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FARMGATE = [['FAQ', 'Robusta FAQ'], ['Kiboko', 'Robusta Kiboko'], ['Arabica Parchment', 'Arabica parchment'], ['Drugar', 'Arabica Drugar (clean)']];
const EXPORT = [
  ['SCREEN 18', 'Robusta Screen 18'], ['SCREEN 15', 'Robusta Screen 15'], ['SCREEN 12', 'Robusta Screen 12'],
  ['BUGISU AA', 'Arabica Bugisu AA'], ['BUGISU A', 'Arabica Bugisu A'], ['BUGISU PB', 'Arabica Bugisu PB'], ['BUGISU B', 'Arabica Bugisu B'],
  ['WUGAR', 'Arabica Wugar'], ['DRUGAR', 'Arabica Drugar'],
];
const amount = text => /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(text) && Number(text.replace(/,/g, '')) > 0 ? Number(text.replace(/,/g, '')) : null;
const line = (items, y) => items.filter(item => Math.abs(item.y - y) < 4).sort((a, b) => a.x - b.x).map(item => item.text.trim()).join(' ');
const suffix = day => (day % 100 >= 11 && day % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');

export function ucdaReportUrl(date, folder = date.slice(0, 7)) {
  const [year, month, day] = date.split('-').map(Number);
  const name = `Daily Coffee Market Report (${MONTHS[month - 1][0].toUpperCase()}${MONTHS[month - 1].slice(1)} ${day}${suffix(day)} ${year}).pdf`;
  return `https://ugandacoffee.go.ug/sites/default/files/${folder}/${encodeURIComponent(name)}`;
}

export function discoverUcdaReport(links) {
  for (const link of links) {
    const url = new URL(link.url);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { continue; } // A malformed escape in another link.
    const match = /\/Daily Coffee Market Report \(([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\)[^/]*\.pdf$/i.exec(path);
    const month = match ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : 0;
    const date = month ? isoDate(match[3], month, match[2]) : '';
    if (url.hostname === 'ugandacoffee.go.ug' && date) return { date, url: url.href };
  }
  return null;
}

function parseDate(items) {
  const heading = items.find(item => item.text.startsWith('INDICATIVE FOR/T PRICES'));
  const match = heading && /^INDICATIVE FOR\/T PRICES\s+([A-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/i.exec(line(items.filter(item => !/^(?:st|nd|rd|th)$/.test(item.text.trim()) && item.x < 400), heading.y));
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : 0;
  return month ? isoDate(match[3], month, match[2]) : '';
}

export function parseUcda(page, expectedDate) {
  const text = page.map(item => item.text).join(' ');
  if (!text.includes('DAILY COFFEE MARKET ANALYSIS REPORT')) throw new Error('ucda daily report format changed');
  const date = parseDate(page);
  if (!date || (expectedDate && date !== expectedDate)) throw new Error('ucda report date mismatch');
  const observations = [];
  const farmTitle = page.find(item => /^WEEK.S FARMGATE PRICE RANGE IN UGX\/KILO$/.test(item.text.trim()));
  const farmHeader = farmTitle && page.find(item => item.text.trim() === 'Category of coffee' && item.y < farmTitle.y);
  if (!farmHeader) throw new Error('ucda farmgate table format changed');
  const columns = FARMGATE.map(([label, item]) => {
    const header = page.find(cell => cell.text.trim() === label && Math.abs(cell.y - farmHeader.y) < 12 && cell.x > farmHeader.x);
    if (!header) throw new Error('ucda farmgate columns format changed');
    return { x: header.x, item, tokens: [] };
  });
  const below = page.filter(item => item.y < farmHeader.y - 12 && /^[\d,\-–]+$/.test(item.text.trim()));
  // Spreading a publisher-sized list into Math.max overflows the stack.
  const rowY = below.reduce((max, item) => (item.y > max ? item.y : max), -Infinity);
  const values = below.filter(item => Math.abs(item.y - rowY) < 2);
  for (const token of values) columns.reduce((best, column) => (Math.abs(column.x - token.x) < Math.abs(best.x - token.x) ? column : best)).tokens.push(token);
  for (const column of columns) {
    const range = column.tokens.sort((a, b) => a.x - b.x).map(token => token.text.trim()).join('').replace(/–/g, '-');
    const match = /^([\d,]+)-([\d,]+)$/.exec(range);
    if (!match && range) throw new Error('ucda farmgate range format changed');
    for (const [suffixText, value] of match ? [['low', match[1]], ['high', match[2]]] : []) {
      const price = amount(value);
      if (price !== null) observations.push({ item: `${column.item} (${suffixText})`, market: 'National', marketType: 'farmgate', unit: 'kg', currency: 'UGX', date, price, origin: '' });
    }
  }
  const usHeader = page.find(item => item.text.trim() === 'Price (US');
  const cents = page.find(item => item.text.trim() === 'cts/' && usHeader && Math.abs(item.x - usHeader.x) < 15 && item.y < usHeader.y);
  const ugx = page.find(item => item.text.trim() === 'Price (' && usHeader && item.x > usHeader.x);
  if (!cents || !ugx || !text.includes('Grade')) throw new Error('ucda indicative export table format changed');
  const priceCells = page.filter(item => item.x >= usHeader.x - 5 && item.x < ugx.x - 20 && item.y > farmTitle.y && item.y < cents.y && /^[\d.,]+$/.test(item.text.trim()));
  for (const [label, item] of EXPORT) {
    const grade = page.find(cell => cell.text.trim() === label && cell.y > farmTitle.y && cell.y < cents.y);
    if (!grade) throw new Error('ucda indicative export grades changed');
    const cell = priceCells.filter(cell => Math.abs(cell.y - grade.y) <= 8).sort((a, b) => Math.abs(a.y - grade.y) - Math.abs(b.y - grade.y))[0];
    const price = amount(cell?.text.trim());
    if (price !== null) observations.push({ item, market: 'Kampala (FOT)', marketType: 'export', unit: 'lb', currency: 'USD', date, price: Math.round(price * 100) / 10000, origin: '' });
  }
  if (!observations.some(row => row.marketType === 'farmgate')) throw new Error('ucda report has no farmgate prices');
  return observations;
}

export async function collect(ctx) {
  const latest = discoverUcdaReport(ctx.links(await ctx.get(UCDA_HOME_URL), UCDA_HOME_URL));
  if (!latest || latest.date > ctx.dated(ctx.now, 0)) throw new Error('ucda has no daily report link');
  const priorDate = ctx.dated(new Date(`${latest.date}T00:00:00Z`), -7);
  const candidates = [...new Set([ucdaReportUrl(priorDate), ucdaReportUrl(priorDate, latest.date.slice(0, 7))])];
  const observations = [];
  const refreshedReports = [];
  for (const [date, urls] of [[latest.date, [latest.url]], [priorDate, candidates]]) {
    let failure;
    for (const url of urls) {
      try {
        const pages = await ctx.pdfPages(await ctx.get(url, { binary: true }));
        observations.push(...parseUcda(pages[0] ?? [], date));
        refreshedReports.push({ date });
        failure = null;
        break;
      } catch (error) { failure = error; }
    }
    if (failure && date === latest.date) throw failure;
    if (failure) ctx.warn(`prior-week report unavailable: ${failure.message}`);
  }
  return { observations, contexts: [], refreshedReports, reportUrl: latest.url };
}
