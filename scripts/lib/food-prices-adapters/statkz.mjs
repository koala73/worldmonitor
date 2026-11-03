import { isoDate } from '../food-prices.mjs';

const INDEX = 'https://stat.gov.kz/en/industries/economy/prices/spreadsheets/';
const SERIES = 'price index and average prices for socially important food products in the republic of kazakhstan';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ITEMS = {
  'Rice, polished': 'Rice (polished)',
  'Buckwheat': 'Buckwheat',
  'First grade wheat flour': 'Wheat flour (first grade)',
  'Wheat bread made from first grade flour': 'Bread (first-grade wheat flour)',
  'Horns': 'Pasta (horns)',
  'Beef with bones': 'Beef (bone-in)',
  'Beef boneless': 'Beef (boneless)',
  'Horse meat, including boneless': 'Horse meat',
  'Lamb, including boneless': 'Lamb',
  'Chickens': 'Chicken (whole)',
  'Chicken meat (thigh, drumstick, chicken leg)': 'Chicken (legs)',
  'Chopped meat': 'Minced meat',
  'Fish fresh, chilled, frozen (crucian carp, pikeperch, carp, common carp)': 'Fish (fresh/frozen carp, pikeperch)',
  'Milk (pasteurized, ultra-pasteurized, sterilized, with fat content from 2.2% to 6%)': 'Milk (pasteurized, 2.2-6% fat)',
  'Hard, semi-hard cheese': 'Cheese (hard, semi-hard)',
  'Cottage cheese 5-9% fat': 'Cottage cheese (5-9% fat)',
  'Sour cream': 'Sour cream',
  'Kefir 2-3% fat': 'Kefir (2-3% fat)',
  'Eggs, category 1': 'Eggs (category 1)',
  'Sunflower oil': 'Sunflower oil',
  'Butter': 'Butter',
  'Apples': 'Apples',
  'White cabbage': 'Cabbage (white)',
  'Cucumbers': 'Cucumbers',
  'Tomatoes': 'Tomatoes',
  'Bulb onions': 'Onions',
  'Carrot': 'Carrots',
  'Potato': 'Potatoes',
  'Granulated sugar': 'Sugar (granulated)',
  'Salt, except extra': 'Salt (except extra)',
  'Black tea': 'Black tea',
};
const CITIES = { 'By surveyed cities': 'National average', 'Pertopavlovsk': 'Petropavlovsk' };
const UNITS = { liter: 'litre', dozen: 'dozen' };
const text = value => String(value?.richText ? value.richText.map(run => run.text).join('') : value ?? '').replace(/\s+/g, ' ').trim();
const longDate = value => {
  const match = /([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(value);
  return match ? isoDate(match[3], MONTHS.indexOf(match[1].toLowerCase()) + 1, match[2]) : '';
};

export function discoverStatkz(html, links) {
  const seen = new Set();
  return links(html, INDEX).flatMap(link => {
    const match = link.text.toLowerCase().startsWith(`${SERIES} (`) ? /\(\s*as(?: of)? (\d{1,2}) ([A-Za-z]+) (\d{4})\s*\)$/i.exec(link.text) : null;
    const date = match ? isoDate(match[3], MONTHS.indexOf(match[2].toLowerCase()) + 1, match[1]) : '';
    return date && /^\/api\/iblock\/element\/\d+\/file\/en\/$/.test(new URL(link.url).pathname) && new URL(link.url).hostname === 'stat.gov.kz' ? [{ date, url: link.url }] : [];
  }).filter(report => !seen.has(report.url) && seen.add(report.url)).sort((a, b) => b.date.localeCompare(a.date));
}

export function parseStatkz(sheets, expectedDate) {
  const rows = sheets.find(rows => /^5\. Average prices for socially important food products as of/i.test(text(rows[0]?.[0])));
  if (!rows) throw new Error('statkz average price sheet missing (format changed)');
  const date = longDate(text(rows[0][0]));
  if (!date || date !== expectedDate) throw new Error(`statkz sheet date ${date || 'missing'} does not match report ${expectedDate}`);
  if (!rows[1]?.some(value => /^in tenge per kg$/i.test(text(value)))) throw new Error('statkz unit line changed (format changed)');
  const header = rows[2] ?? [];
  if (text(header[1]) !== 'By surveyed cities' || header.filter(value => text(value)).length < 15) throw new Error('statkz city header changed (format changed)');
  const result = [];
  for (const row of rows.slice(3)) {
    const label = text(row?.[0]);
    if (!label) break;
    const [, name, suffix] = /^(.*?)(?:, (liter|dozen))?$/i.exec(label);
    const unit = UNITS[suffix?.toLowerCase()] ?? 'kg';
    for (let column = 1; column < header.length; column++) {
      const city = text(header[column]);
      const value = row[column];
      if (!city || typeof value !== 'number' || !(value > 0)) continue;
      result.push({ item: ITEMS[name] ?? name, market: CITIES[city] ?? city, marketType: 'retail', unit, currency: 'KZT', date, price: value, origin: '' });
    }
  }
  if (!result.length) throw new Error('statkz workbook has no dated food prices');
  return result;
}

export async function collect(ctx) {
  const index = await ctx.get(INDEX);
  const series = ctx.selectOptions(index, 'name').find(option => option.name.toLowerCase() === SERIES);
  let html = index;
  if (series && /^\d+$/.test(series.id)) html += await ctx.get(`${INDEX}?year=&name=${series.id}&period=&type=`);
  else ctx.warn('series filter missing; using the unfiltered index');
  const reports = discoverStatkz(html, ctx.links).filter(report => report.date <= ctx.dated(ctx.now, 0));
  const latest = reports[0];
  if (!latest) throw new Error('statkz has no weekly food price reports');
  const prior = reports.find(report => report.date === ctx.dated(new Date(`${latest.date}T00:00:00Z`), -7));
  const observations = [];
  const refreshedReports = [];
  for (const report of [latest, prior].filter(Boolean)) {
    try {
      observations.push(...parseStatkz(await ctx.readWorkbook(await ctx.get(report.url, { binary: true })), report.date));
      refreshedReports.push({ date: report.date });
    } catch (error) {
      if (report === latest) throw error;
      ctx.warn(`prior-week report unavailable: ${error.message}`);
    }
  }
  if (!prior) ctx.warn(`no report dated 7 days before ${latest.date}`);
  return { observations, refreshedReports, reportUrl: latest.url };
}
