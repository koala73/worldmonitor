import { isoDate, pdfRows } from '../food-prices.mjs';

// The media list is the publisher's own upload index; file names carry suffixes such as -MCIRMN when
// the commerce ministry co-signs, and some titles drop the underscore before the year (prix_30_Sept2026),
// so dates come from the title rather than a guessed URL.
const MEDIA_URL = 'https://madr.gov.dz/wp-json/wp/v2/media?search=prix&mime_type=application/pdf&per_page=30&orderby=date&order=desc&_fields=id,date,title,mime_type,source_url';
const MONTHS = [/^jan/, /^f[eé][vb]/, /^mar/, /^a[vp]r/, /^ma[iy]/, /^juin|^jun/, /^juil|^jul/, /^ao[uû]|^aug/, /^sep/, /^oct/, /^nov/, /^d[eé]c/];
const PRODUCTS = {
  'Pomme de terre': 'Potatoes', Tomate: 'Tomatoes', 'Oignon sec': 'Onions (dry)', 'Ail sec': 'Garlic (dry)', Carotte: 'Carrots',
  Navet: 'Turnips', Poivron: 'Sweet peppers', Piment: 'Chili peppers', Courgette: 'Courgettes', 'Haricot vert': 'Green beans',
  Laitue: 'Lettuce', 'Pomme locale': 'Apples (local)', Datte: 'Dates', Raisin: 'Grapes', Grenade: 'Pomegranates',
  'Viande bovine locale': 'Beef (local)', 'Poulet de chair': 'Chicken (broiler)', 'Œufs': 'Eggs', 'Lait de vache': 'Cow milk',
};
const UNITS = { unité: 'piece', litre: 'litre' };
const MAX_LABEL = 120;

const monthIndex = name => MONTHS.findIndex(pattern => pattern.test(name.toLowerCase())) + 1;
const textDate = (day, month, year) => (monthIndex(month) ? isoDate(year, monthIndex(month), day) : '');
const amount = text => (/^\d{1,3}(?:[  ]?\d{3})*$/.test(text) && Number(text.replace(/\D/g, '')) > 0 ? Number(text.replace(/\D/g, '')) : null);

export function discoverMadrReports(media) {
  const seen = new Set();
  return (Array.isArray(media) ? media : []).flatMap(entry => {
    if (entry?.mime_type !== 'application/pdf' || typeof entry.source_url !== 'string') return [];
    let url;
    try { url = new URL(entry.source_url); } catch { return []; }
    if (url.protocol !== 'https:' || url.hostname !== 'madr.gov.dz' || !/^\/wp-content\/uploads\/.+\.pdf$/i.test(url.pathname)) return [];
    const match = /^prix_(\d{1,2})_([A-Za-zéûÉ]{3,9})_?(\d{4})_MADRP\b/i.exec(String(entry.title?.rendered ?? '').trim());
    const date = match ? textDate(match[1], match[2], match[3]) : '';
    if (!date || seen.has(date)) return [];
    seen.add(date);
    return [{ date, url: url.href }];
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export function parseMadr(page, expectedDate) {
  const title = page.find(item => /^Mercuriale des prix des produits agricoles/i.test(item.text.trim()))?.text;
  const match = title ? /date:\s*(\d{1,2})\s+(\S+)\s+(\d{4})\s*$/i.exec(title) : null;
  if (!match) throw new Error('madr price PDF format changed');
  const date = textDate(match[1], match[2], match[3]);
  if (!date || date !== expectedDate) throw new Error(`madr report date mismatch: ${date || 'missing'} vs ${expectedDate}`);
  const header = name => {
    const found = page.filter(item => item.text.trim() === name);
    if (found.length !== 1) throw new Error(`madr ${name} column format changed`);
    return found[0];
  };
  const [products, mean, max, min] = ['Produits', 'Moyenne', 'Maximum', 'Minimum'].map(header);
  if (!page.some(item => /^DA\s*\/\s*Kg$/i.test(item.text.trim()))) throw new Error('madr unit line format changed');
  if (!(products.x < mean.x && mean.x < max.x && max.x < min.x) || Math.abs(mean.y - max.y) > 2 || Math.abs(mean.y - min.y) > 2) {
    throw new Error('madr price columns format changed');
  }
  const columns = [mean, max, min];
  const result = [];
  for (const row of pdfRows(page.filter(item => item.y < mean.y - 2))) {
    // Numbers are right-aligned under their header, so a cell belongs to the last header at or left of it.
    const cells = row.items.filter(item => item.x >= mean.x - 10 && item.x < min.x + 80 && /^[\d  ]+$/.test(item.text.trim()));
    if (!cells.length) continue;
    const label = row.items.filter(item => item.x >= products.x - 5 && item.x < mean.x - 10).map(item => item.text.trim()).join(' ');
    const values = new Map();
    for (const cell of cells) {
      const column = columns.findLastIndex(header => header.x <= cell.x + 3);
      if (column < 0 || values.has(column)) throw new Error('madr price cell layout changed');
      values.set(column, amount(cell.text.trim()));
    }
    if (!label || values.size !== 3 || [...values.values()].some(value => value === null)) throw new Error('madr product row format changed');
    const [average, high, low] = [0, 1, 2].map(column => values.get(column));
    if (average < low || average > high) throw new Error(`madr ${label} mean outside its range`);
    // Labels are publisher text; real ones are under 30 characters. Split the trailing "(unit)" with index
    // lookups rather than a backtracking pattern (CWE-1333).
    if (label.length > MAX_LABEL) throw new Error('madr product label format changed');
    const open = label.endsWith(')') ? label.lastIndexOf('(') : -1;
    const name = open > 0 ? label.slice(0, open).trim() : label;
    const unitLabel = open > 0 ? label.slice(open + 1, -1).trim() : '';
    const unit = unitLabel ? UNITS[unitLabel.toLowerCase()] : 'kg';
    if (!unit) throw new Error(`madr ${label} unit format changed`);
    result.push({ item: PRODUCTS[name] ?? name, market: 'National average', marketType: 'retail', unit, currency: 'DZD', date, price: average, origin: '' });
  }
  if (result.filter(row => Object.values(PRODUCTS).includes(row.item)).length < 12) throw new Error('madr product list format changed');
  return result;
}

export async function collect(ctx) {
  const reports = discoverMadrReports(JSON.parse(await ctx.get(MEDIA_URL))).filter(report => report.date <= ctx.dated(ctx.now, 0));
  const latest = reports[0];
  if (!latest) throw new Error('madr has no price PDFs in the media list');
  const priorDate = ctx.dated(new Date(`${latest.date}T00:00:00Z`), -7);
  const prior = reports.find(report => report.date === priorDate);
  const observations = [];
  const refreshedReports = [];
  for (const report of [latest, prior].filter(Boolean)) {
    try {
      const pages = await ctx.pdfPages(await ctx.get(report.url, { binary: true }));
      observations.push(...parseMadr(pages[0] ?? [], report.date));
      refreshedReports.push({ date: report.date });
    } catch (error) {
      if (report === latest) throw error;
      ctx.warn(`prior-week report unavailable: ${error.message}`);
    }
  }
  // Algeria publishes on working days only, so the same weekday a week earlier can be a holiday.
  if (!prior) ctx.warn(`no report dated ${priorDate} in the media list`);
  return { observations, contexts: [], refreshedReports, reportUrl: latest.url };
}
