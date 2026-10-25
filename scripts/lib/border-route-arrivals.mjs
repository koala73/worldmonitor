import Papa from 'papaparse';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(Date.parse(value)) === value;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function count(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('invalid observation count');
  return Number(text);
}

export function dailyRoute(points) {
  const byDate = new Map(points.map(p => [p.date, p.count]));
  const asOf = [...byDate.keys()].sort().at(-1);
  if (!asOf || !validDate(asOf)) throw new Error('no dated observations');
  const end = Date.parse(asOf);
  function window(length, offset = 0) {
    const values = Array.from({ length }, (_, i) => byDate.get(iso(end - (offset + i) * DAY)));
    return values.every(v => Number.isSafeInteger(v) && v >= 0) ? values.reduce((a, b) => a + b, 0) : undefined;
  }
  const last7Days = window(7);
  const last30Days = window(30);
  const previous30Days = window(30, 30);
  const baseline = Array.from({ length: 12 }, (_, i) => window(7, (i + 1) * 7)).filter(v => v !== undefined);
  return {
    asOf, period: 'day', latestCount: byDate.get(asOf), last7Days, last30Days, previous30Days,
    changePct: previous30Days > 0 && last30Days !== undefined ? (last30Days / previous30Days - 1) * 100 : undefined,
    surge: last7Days > 10_000 || last7Days >= 1000 && baseline.length >= 3 && last7Days >= 2 * Math.max(1, median(baseline)),
  };
}

export function parseUkDaily(html) {
  const table = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error('missing Home Office arrivals table');
  // Accept plain cells only; stripping markup can turn invalid input into a count.
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
    [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell => cell[1].trim()));
  const header = rows.find(cells => cells.includes('Date') && cells.includes('Migrants arrived'));
  if (!header || header.filter(c => c === 'Date').length !== 1 || header.filter(c => c === 'Migrants arrived').length !== 1) throw new Error('missing Home Office arrivals headers');
  const dateColumn = header.indexOf('Date');
  const arrivalsColumn = header.indexOf('Migrants arrived');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const points = [];
  for (const cells of rows) {
    if (cells === header) continue;
    const parts = cells[dateColumn]?.match(/^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/);
    const month = months.indexOf(parts?.[2]);
    if (!parts || month < 0) throw new Error('invalid Home Office date');
    const date = `${parts[3]}-${String(month + 1).padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    if (!validDate(date)) throw new Error('invalid Home Office date');
    points.push({ date, count: count(cells[arrivalsColumn]) });
  }
  if (points.length !== 7 || new Set(points.map(p => p.date)).size !== 7) throw new Error('expected seven daily observations');
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseUkOds(bytes) {
  const files = unzipSync(new Uint8Array(bytes), { filter: file => file.name === 'content.xml' && file.originalSize <= 20_000_000 });
  if (!files['content.xml'] || files['content.xml'].length > 20_000_000) throw new Error('invalid UK ODS content');
  const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(strFromU8(files['content.xml']));
  const tables = xml?.['document-content']?.body?.spreadsheet?.table;
  const table = (Array.isArray(tables) ? tables : [tables]).find(t => t?.['@_name'] === 'SB_01');
  const rows = table?.['table-row'];
  if (!Array.isArray(rows)) throw new Error('missing SB_01 arrivals sheet');
  const points = [];
  for (const row of rows) {
    const cells = row['table-cell'];
    if (!Array.isArray(cells)) continue;
    const rawDate = cells[0]?.['@_date-value'];
    if (!rawDate) continue;
    const date = String(rawDate).slice(0, 10);
    if (!validDate(date)) throw new Error('invalid UK ODS date');
    points.push({ date, count: count(cells[1]?.['@_value']) });
  }
  if (points.length < 90) throw new Error('incomplete UK arrivals history');
  return points;
}

export function parseCbp(csv) {
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const columns = ['Fiscal Year', 'Month (abbv)', 'Land Border Region', 'Encounter Count'];
  if (parsed.errors.length || columns.some(k => !parsed.meta.fields?.includes(k))) throw new Error('invalid CBP columns or CSV');
  const totals = new Map();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  for (const row of parsed.data) {
    if (row['Land Border Region'] !== 'Southwest Land Border') continue;
    const fiscal = String(row['Fiscal Year']).match(/^(\d{4})(?: \(FYTD\))?$/);
    const year = fiscal ? Number(fiscal[1]) : NaN;
    const month = months.indexOf(row['Month (abbv)']);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || month < 0) throw new Error('invalid CBP period');
    const date = iso(Date.UTC(year - (month >= 9 ? 1 : 0), month + 1, 0));
    totals.set(date, (totals.get(date) ?? 0) + count(row['Encounter Count']));
  }
  if (!totals.size) throw new Error('no southwest border observations');
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, n]) => ({ date, count: n }));
}

export function monthlyRoute(points) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted.at(-1);
  if (!latest) throw new Error('no monthly observations');
  const earlier = sorted.slice(-4, -1);
  const contiguous = earlier.length === 3 && [...earlier, latest].every((p, i, all) => i === 0 || Date.parse(p.date) > Date.parse(all[i - 1].date) && Date.parse(p.date) - Date.parse(all[i - 1].date) <= 31 * DAY);
  return { asOf: latest.date, period: latest.date.slice(0, 7), latestCount: latest.count,
    surge: contiguous && latest.count >= 1000 && latest.count >= 2 * Math.max(1, median(earlier.map(p => p.count))) };
}
