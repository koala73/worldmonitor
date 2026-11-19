import { firstIndex, isoDate } from '../food-prices.mjs';

const MIT_INDEX_URL = 'https://www.viwanda.go.tz/documents/product-prices-domestic';

const MONTHS = [/^jan/, /^feb/, /^ma[rc]/, /^apr/, /^m(?:ay|ei)/, /^jun/, /^jul/, /^a(?:ug|go)/, /^sep/, /^o[ck]t/, /^nov/, /^de[cs]/];
const CROPS = [
  ['Maize (Mahindi)', 'Maize'], ['Rice (Mchele)', 'Rice'], ['Sorghum (Mtama)', 'Sorghum'], ['Bulrush Millet (Uwele)', 'Bulrush millet'],
  ['Finger Millet (Ulezi)', 'Finger millet'], ['Wheat Grain (Ngano)', 'Wheat grain'], ['Beans (Maharage)', 'Beans'], ['Irish Potatoes (Viazi', 'Irish potatoes'],
];

const monthIndex = name => MONTHS.findIndex(pattern => pattern.test(name.toLowerCase())) + 1;
const textDate = (day, month, year) => (monthIndex(month) ? isoDate(year, monthIndex(month), day) : '');
const amount = text => /^\d{1,3}(?:,\d{3})*$/.test(text) && Number(text.replace(/,/g, '')) > 0 ? Number(text.replace(/,/g, '')) : null;
const region = name => /^dar es sa+la+m$/i.test(name) ? 'Dar es Salaam' : name;

export function discoverMitReports(links) {
  const seen = new Set();
  return links.flatMap(link => {
    const url = new URL(link.url);
    if (url.hostname !== 'www.viwanda.go.tz' || !/^\/uploads\/documents\/.+\.pdf$/i.test(url.pathname)) return [];
    const match = /Wholesale Price (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+),? (\d{4})/i.exec(decodeURIComponent(url.pathname));
    const date = match ? textDate(match[1], match[2], match[3]) : '';
    if (!date || seen.has(date)) return [];
    seen.add(date);
    return [{ date, url: url.href }];
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export function mitRows(items) {
  const result = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    // Items arrive by descending y and rows sit more than 1.5 apart, so only the newest row can match.
    let row = result.at(-1);
    if (!row || Math.abs(row.y - item.y) >= 1.5) result.push(row = { y: item.y, items: [] });
    row.items.push(item);
  }
  return result.map(row => ({ ...row, items: row.items.sort((a, b) => a.x - b.x) }));
}

export function parseMit(page, expectedDate) {
  const title = page.find(item => /^BEI ZA JUMLA MAZAO MAKUU YA CHAKULA NCHINI \(TZS \/ KILO 100\)/.test(item.text))?.text;
  if (!title) throw new Error('mit wholesale PDF format changed');
  const match = /(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\.?\s*$/.exec(title);
  const date = match ? textDate(match[1], match[2], match[3]) : '';
  if (!date || (expectedDate && date !== expectedDate)) throw new Error('mit report date mismatch');
  const headers = page.filter(item => /^(?:Min|Max) Price$/.test(item.text)).sort((a, b) => a.x - b.x);
  if (headers.length !== CROPS.length * 2 || headers.some((header, i) => header.text !== (i % 2 ? 'Max Price' : 'Min Price'))) throw new Error('mit price columns format changed');
  for (const [i, [label]] of CROPS.entries()) {
    const crop = page.find(item => item.text.trim() === label);
    if (!crop || crop.x < headers[i * 2].x - 5 || crop.x >= headers[i * 2 + 1].x) throw new Error('mit crop columns format changed');
  }
  const top = headers[0].y;
  // Sorted once by height so each market row takes its band of cells without rescanning the page.
  const values = page.filter(item => item.x >= 110 && item.y < top && /^(?:[\d,]+|NA)$/.test(item.text.trim())).sort((a, b) => a.y - b.y);
  const result = [];
  for (const row of mitRows(page.filter(item => item.x < 110 && item.y < top))) {
    const regionName = row.items.filter(item => item.x < 60).map(item => item.text.trim()).join(' ');
    const district = row.items.filter(item => item.x >= 60).map(item => item.text.trim()).join(' ');
    if (/^(?:CHANZO:|IDARA\b)/.test(regionName) || (!regionName && !district)) continue;
    if (!regionName || !district) throw new Error('mit market row format changed');
    const columns = new Map();
    for (let i = firstIndex(values, item => item.y >= row.y - 1); i < values.length && values[i].y <= row.y + 4; i++) {
      const cell = values[i];
      const column = headers.findLastIndex(header => header.x <= cell.x + 3);
      if (column < 0 || columns.has(column)) throw new Error('mit price cell layout changed');
      columns.set(column, cell.text.trim());
    }
    if (columns.size !== headers.length) throw new Error('mit price row format changed');
    const regionLabel = region(regionName);
    const market = district.toLowerCase() === regionLabel.toLowerCase() ? district : `${district}, ${regionLabel}`;
    for (const [i, [, item]] of CROPS.entries()) {
      for (const [offset, suffix] of [[0, 'low'], [1, 'high']]) {
        const price = amount(columns.get(i * 2 + offset));
        if (price !== null) result.push({ item: `${item} (${suffix})`, market, marketType: 'wholesale', unit: '100 kg', currency: 'TZS', date, price, origin: '' });
      }
    }
  }
  if (!result.length) throw new Error('mit report has no prices');
  return result;
}

export async function collect(ctx) {
  const reports = discoverMitReports(ctx.links(await ctx.get(MIT_INDEX_URL), MIT_INDEX_URL)).filter(report => report.date <= ctx.dated(ctx.now, 0));
  const latest = reports[0];
  if (!latest) throw new Error('mit has no report links');
  const prior = reports.find(report => report.date === ctx.dated(new Date(`${latest.date}T00:00:00Z`), -7));
  const observations = [];
  const refreshedReports = [];
  for (const report of [latest, prior].filter(Boolean)) {
    try {
      const pages = await ctx.pdfPages(await ctx.get(report.url, { binary: true }));
      observations.push(...parseMit(pages[0] ?? [], report.date));
      refreshedReports.push({ date: report.date });
    } catch (error) {
      if (report === latest) throw error;
      ctx.warn(`prior-week report unavailable: ${error.message}`);
    }
  }
  if (!prior) ctx.warn(`no report dated ${ctx.dated(new Date(`${latest.date}T00:00:00Z`), -7)} on the index`);
  return { observations, contexts: [], refreshedReports, reportUrl: latest.url };
}
