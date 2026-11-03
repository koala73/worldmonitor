import { unzipSync } from 'fflate';
import { monthlyRoute } from './border-route-arrivals.mjs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SPANISH_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const endOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const observation = value => {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('invalid report count');
  return Number(text);
};

const FRONTEX_ROUTES = {
  'Eastern Mediterranean Route': { id: 'frontex-eastern-mediterranean', name: 'Eastern Mediterranean detections', countryCode: '', latitude: 37, longitude: 27 },
  'Central Mediterranean Route': { id: 'frontex-central-mediterranean', name: 'Central Mediterranean detections', countryCode: '', latitude: 35, longitude: 14 },
  'Western Mediterranean Route': { id: 'frontex-western-mediterranean', name: 'Western Mediterranean detections', countryCode: 'ES', latitude: 36, longitude: -4 },
  'Western Balkan Route': { id: 'frontex-western-balkan', name: 'Western Balkan detections', countryCode: '', latitude: 44.5, longitude: 19.5 },
  'Eastern Borders Route': { id: 'frontex-eastern-borders', name: 'Eastern land border detections', countryCode: '', latitude: 53.5, longitude: 24 },
  'Western African Route': { id: 'frontex-western-african', name: 'Western African route detections', countryCode: 'ES', latitude: 28, longitude: -16 },
  'Circular Route from Albania to Greece': { id: 'frontex-albania-greece', name: 'Albania to Greece detections', countryCode: 'GR', latitude: 40, longitude: 20.5 },
  'Black Sea Route': { id: 'frontex-black-sea', name: 'Black Sea detections', countryCode: '', latitude: 43.5, longitude: 29 },
  Other: { id: 'frontex-other', name: 'Other EU border detections', countryCode: '' },
};

export async function parseFrontex(bytes) {
  let expandedSize = 0;
  unzipSync(new Uint8Array(bytes), { filter: file => {
    expandedSize += file.originalSize;
    if (expandedSize > 50_000_000) throw new Error('Frontex workbook exceeds size budget');
    return false;
  } });
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheet = book.getWorksheet('Detections_of_IBC');
  const headers = sheet?.getRow(2).values;
  if (!headers || headers[1] !== 'Route' || headers[2] !== 'Border type or inland' || headers[3] !== 'Nationality') throw new Error('invalid Frontex headers');
  const columns = Array.from(headers.slice(4), (value, i) => {
    const match = String(value).match(/^([A-Z]{3})(20\d{2})$/);
    const month = MONTHS.indexOf(match?.[1]);
    if (!match || month < 0) throw new Error('invalid Frontex month');
    return { column: i + 4, date: endOfMonth(Number(match[2]), month) };
  });
  if (!columns.length || new Set(columns.map(c => c.date)).size !== columns.length) throw new Error('invalid Frontex periods');
  const totals = new Map();
  const seen = new Set();
  sheet.eachRow((row, i) => {
    if (i <= 2) return;
    const [route, border, nationality] = [1, 2, 3].map(c => row.getCell(c).text.trim());
    if (!Object.hasOwn(FRONTEX_ROUTES, route) || !['Sea', 'Land', 'Inland'].includes(border) || !nationality || /^(?:grand )?total$/i.test(nationality)) throw new Error('invalid Frontex route row');
    const key = `${route}|${border}|${nationality}`;
    if (seen.has(key)) throw new Error('duplicate Frontex nationality row');
    seen.add(key);
    if (!totals.has(route)) totals.set(route, columns.map(c => ({ date: c.date, count: 0 })));
    for (const [index, { column }] of columns.entries()) {
      const point = totals.get(route)[index];
      point.count += observation(row.getCell(column).value);
      if (!Number.isSafeInteger(point.count)) throw new Error('invalid Frontex route total');
    }
  });
  if (!totals.size) throw new Error('no Frontex observations');
  return [...totals].map(([name, points]) => ({ ...FRONTEX_ROUTES[name], kind: 'encounter', measure: 'monthly', ...monthlyRoute(points), surge: false }));
}

export function parsePanamaText(text) {
  const normalized = normalize(text);
  if (!/transito irregular de extranjeros por la frontera con colombia/.test(normalized)) throw new Error('invalid Panama report title');
  const cutoff = normalized.match(/actualizacion al (\d{1,2}) de ([a-z]+) de (20\d{2})/);
  const month = SPANISH_MONTHS.indexOf(cutoff?.[2]);
  if (!cutoff || month < 0) throw new Error('missing Panama report date');
  const year = Number(cutoff[3]);
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${cutoff[1].padStart(2, '0')}`;
  if (!Number.isFinite(Date.parse(date)) || new Date(Date.parse(date)).toISOString().slice(0, 10) !== date) throw new Error('invalid Panama report date');
  const table = normalized.match(/region\s+total\s+ene\.\s+feb\.\s+mar\.\s+abr\.\s+may\.\s+jun\.\s+jul\.\s+ago\.\s+sep\.\s+oct\.\s+nov\.\s+dic\.\s*\n\s*total\s+([^\n]+)/);
  const cells = table?.[1].trim().split(/\s+/);
  if (!cells || cells.length !== 13) throw new Error('missing Panama monthly totals');
  const published = cells.slice(1, month + 2).map(observation);
  if (cells.slice(month + 2).some(c => c !== '-') || published.reduce((a, b) => a + b, 0) !== observation(cells[0])) throw new Error('inconsistent Panama yearly total');
  const complete = date === endOfMonth(year, month) ? published : published.slice(0, -1);
  const points = complete.map((count, i) => ({ date: endOfMonth(year, i), count }));
  return [{ id: 'darien-gap', name: 'Darién Gap arrivals into Panama', countryCode: 'PA', originCode: 'CO', kind: 'arrival', measure: 'monthly', latitude: 8.1, longitude: -77.4, ...monthlyRoute(points) }];
}

export async function parsePanama(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push(item);
    }
    const text = [...lines].sort(([a], [b]) => b - a).map(([, items]) => items.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' ')).join('\n');
    return parsePanamaText(text);
  } finally {
    await task.destroy();
  }
}
