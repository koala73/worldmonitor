import { isoDate } from '../food-prices.mjs';

const INDEX = 'https://simaniger.net/publications/bulletins-sima?category=hebdo_cereales';
const FR_MONTHS = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE'];
const COLUMNS = [['MIL', 'Millet', '100 kg bag'], ['SORGHO', 'Sorghum', '100 kg bag'], ['MAIS', 'Maize', '100 kg bag'], ['RIZ', 'Rice (imported)', '25 kg bag']];

const fold = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").toUpperCase();
const titleCase = text => text.toLowerCase().replace(/(^|[\s'/(-])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
const marketName = label => label === 'MOYENNE NATIONALE' ? 'National average' : titleCase(label.replace(/^NY\s+/, 'NIAMEY '));

export function simaWeekEnd(text) {
  const match = /SEMAINE\s*N\D{0,3}\d+\s+DU\s+[A-Z]+\s+\d{1,2}(?:\s+[A-Z]+)?(?:\s+\d{4})?\s+AU\s+[A-Z]+\s+(\d{1,2})\s+([A-Z]+)\s+(\d{4})/.exec(fold(text).replace(/\s+/g, ' '));
  return match ? isoDate(match[3], FR_MONTHS.indexOf(match[2]) + 1, match[1]) : '';
}

export function simaRows(items) {
  const rows = [];
  for (const item of [...items].filter(item => item.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    // Items arrive by descending y and rows sit more than 1.5 apart, so only the newest row can match.
    let row = rows.at(-1);
    if (!row || Math.abs(row.y - item.y) >= 1.5) rows.push(row = { y: item.y, items: [] });
    row.items.push(item);
  }
  return rows.map(row => ({ ...row, items: row.items.sort((a, b) => a.x - b.x) }));
}

export function parseSima(pages, expectedDate) {
  const text = fold(pages.flat().map(item => item.text).join(' ')).replace(/\s+/g, ' ');
  if (!text.includes('BULLETIN HEBDO DES CEREALES') || !text.includes('PRIX AU SAC DES CEREALES')) throw new Error('sima cereal bulletin format changed');
  if (!text.includes('SAC DE 100 KG') || !/SAC DE (?:RIZ DE )?25 KG/.test(text)) throw new Error('sima cereal bag units changed');
  const date = simaWeekEnd(pages[0]?.map(item => item.text).join(' ') ?? '');
  if (!date) throw new Error('sima report date missing');
  if (expectedDate && date !== expectedDate) throw new Error('sima report date mismatch');
  const start = pages.findIndex(items => items.some(item => fold(item.text) === 'LOCALITES'));
  if (start < 0) throw new Error('sima cereal table missing');
  const header = simaRows(pages[start]).find(row => fold(row.items[0].text) === 'LOCALITES');
  if (!header) throw new Error('sima cereal table header missing');
  if (header.items.slice(1).map(item => fold(item.text)).join() !== COLUMNS.map(([name]) => name).join()) throw new Error('sima cereal table columns changed');
  const columns = header.items.slice(1).map((item, i) => ({ x: item.x, item: COLUMNS[i][1], unit: COLUMNS[i][2] }));
  const result = [];
  for (const [page, items] of pages.slice(start).entries()) {
    for (const row of simaRows(items).filter(row => page > 0 || row.y < header.y - 1)) {
      const label = fold(row.items.filter(item => item.x < 150).map(item => item.text).join(' ')).replace(/\s+/g, ' ').trim();
      const values = row.items.filter(item => item.x >= 150);
      if (!label || !values.length || values.some(value => !/^(?:\d{1,3}(?: \d{3})*|-)$/.test(value.text.trim()))) continue;
      if (values.length !== columns.length) throw new Error('sima cereal table row format changed');
      if (/\bMOYENNE$/.test(label)) continue;
      for (const value of values) {
        const column = columns.reduce((best, column) => Math.abs(column.x - value.x) < Math.abs(best.x - value.x) ? column : best);
        if (Math.abs(column.x - value.x) > 30) throw new Error('sima cereal table columns changed');
        const price = Number(value.text.replace(/\s/g, ''));
        if (value.text.trim() !== '-' && price > 0) result.push({ item: column.item, market: marketName(label), marketType: 'wholesale', unit: column.unit, currency: 'XOF', date, price, origin: '' });
      }
      if (label === 'MOYENNE NATIONALE') return result;
    }
  }
  throw new Error('sima national average row missing');
}

export function simaBulletins(links) {
  return links.flatMap(link => {
    const url = new URL(link.url);
    if (!/^\/_api\/publications\/bulletins\/\d+\/download$/.test(url.pathname)) return [];
    const title = url.searchParams.get('titre') ?? '';
    const date = /BULLETIN HEBDO DES CEREALES/.test(fold(title)) ? simaWeekEnd(title) : '';
    return date ? [{ date, url: `${url.origin}${url.pathname}`, title }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export async function collect(ctx) {
  const latest = simaBulletins(ctx.links(await ctx.get(INDEX), INDEX)).find(report => report.date <= ctx.dated(ctx.now, 0));
  if (!latest) throw new Error('sima weekly cereal bulletin link missing');
  // SIMA asks to be contacted before mass extraction: one bulletin per run; the seed history keeps last week's baseline.
  const observations = parseSima(await ctx.pdfPages(await ctx.get(latest.url, { binary: true })), latest.date);
  return { observations, refreshedReports: [{ date: latest.date }], reportUrl: latest.url };
}
