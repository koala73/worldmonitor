// Malaysia monthly merchandise trade by SITC section from the Department of
// Statistics Malaysia (DOSM) open data storage:
//   trade_sitc_1d.csv  exports and imports by section, monthly from 1990
//   tradeidx.csv       unit value and volume indices by section, from 2015
//
// The catalogue metadata labels trade values "RM millions", but the files carry
// whole ringgit: the 2024 overall rows sum to RM 1,509 billion of exports,
// matching DOSM's published annual total, and each month's sections sum exactly
// to its "overall" row. The payload therefore stores whole MYR and says so.

import Papa from 'papaparse';

export const DOSM_SITC_TRADE_URL = 'https://storage.dosm.gov.my/trade/trade_sitc_1d.csv';
export const DOSM_TRADE_INDEX_URL = 'https://storage.dosm.gov.my/trade/tradeidx.csv';
export const DOSM_SITC_TRADE_PAGE = 'https://open.dosm.gov.my/data-catalogue/trade_sitc_1d';

/** SITC section labels from the DOSM SITC dictionary; section 9 is absent there, so the SITC title is used. */
export const SITC_SECTION_LABELS = {
  0: 'Food',
  1: 'Beverages and tobacco',
  2: 'Crude materials, inedible, except fuel',
  3: 'Mineral fuels, lubricants, etc',
  4: 'Animal and vegetable oils, and fats',
  5: 'Chemicals',
  6: 'Manufactured goods',
  7: 'Machinery and transport equipment',
  8: 'Miscellaneous manufactured goods',
  9: 'Commodities and transactions not classified elsewhere',
  overall: 'All goods',
};
export const SITC_SECTIONS = Object.keys(SITC_SECTION_LABELS).sort((a, b) => (a === 'overall') - (b === 'overall') || a.localeCompare(b));

const MAX_ROWS = 20_000;
const INDEX_FIELDS = [
  ['exports_unit_value', 'exportsUnitValueIndex'],
  ['exports_volume', 'exportsVolumeIndex'],
  ['imports_unit_value', 'importsUnitValueIndex'],
  ['imports_volume', 'importsVolumeIndex'],
];

function rows(text, columns, label) {
  const parsed = Papa.parse(String(text).replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true });
  if (parsed.errors.length || !columns.every((column) => parsed.meta.fields?.includes(column))) {
    throw new Error(`DOSM ${label} CSV format changed`);
  }
  if (parsed.data.length === 0 || parsed.data.length > MAX_ROWS) throw new Error(`DOSM ${label} CSV row count out of range`);
  return parsed.data;
}

function monthOf(value, label) {
  const match = /^(\d{4})-(\d{2})-01$/.exec(String(value));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new Error(`DOSM ${label} date changed: ${value}`);
  return `${match[1]}-${match[2]}`;
}

function sectionOf(value, label) {
  const section = String(value);
  if (!Object.hasOwn(SITC_SECTION_LABELS, section)) throw new Error(`DOSM ${label} section changed: ${value}`);
  return section;
}

function amount(value, label, { allowZero = true } = {}) {
  const number = Number(value);
  if (value === '' || value == null || !Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new Error(`DOSM ${label} value invalid: ${value}`);
  }
  return number;
}

/**
 * Build the seeded payload from the two publisher CSV documents. Trade values
 * are required for every month and section; indices are attached where the
 * index file has the same month and section.
 */
export function buildSitcTradePayload(tradeCsv, indexCsv, fetchedAt = Date.now()) {
  const series = new Map(SITC_SECTIONS.map((section) => [section, new Map()]));
  for (const row of rows(tradeCsv, ['date', 'section', 'exports', 'imports'], 'trade')) {
    const month = monthOf(row.date, 'trade');
    const section = sectionOf(row.section, 'trade');
    const months = series.get(section);
    if (months.has(month)) throw new Error(`DOSM trade duplicate ${section} ${month}`);
    months.set(month, { month, exports: amount(row.exports, 'trade exports'), imports: amount(row.imports, 'trade imports') });
  }

  let latestIndexMonth = '';
  const indexSeen = new Set();
  for (const row of rows(indexCsv, ['date', 'section', ...INDEX_FIELDS.map(([column]) => column)], 'index')) {
    const month = monthOf(row.date, 'index');
    const section = sectionOf(row.section, 'index');
    // A repeated section and month would make the published value depend on row order.
    if (indexSeen.has(`${section}|${month}`)) throw new Error(`DOSM index duplicate ${section} ${month}`);
    indexSeen.add(`${section}|${month}`);
    const entry = series.get(section).get(month);
    // An index month newer than the trade release cannot be attached to a trade row.
    if (!entry) continue;
    for (const [column, field] of INDEX_FIELDS) entry[field] = amount(row[column], `index ${column}`, { allowZero: false });
    if (month > latestIndexMonth) latestIndexMonth = month;
  }

  const overall = [...series.get('overall').keys()].sort();
  const latestMonth = overall.at(-1) ?? '';
  for (const [section, months] of series) {
    if (months.size !== overall.length || !overall.every((month) => months.has(month))) {
      throw new Error(`DOSM trade section ${section} does not cover every overall month`);
    }
  }
  // Sections must add up to the overall row for the newest month; a mismatch means a unit or coverage change.
  const newest = SITC_SECTIONS.filter((section) => section !== 'overall').map((section) => series.get(section).get(latestMonth));
  const total = series.get('overall').get(latestMonth);
  for (const flow of ['exports', 'imports']) {
    const sum = newest.reduce((acc, entry) => acc + entry[flow], 0);
    if (Math.abs(sum - total[flow]) > Math.max(1, total[flow] * 0.001)) throw new Error(`DOSM trade sections do not sum to overall ${flow}`);
  }

  return {
    country: 'MY',
    currency: 'MYR',
    source: 'DOSM Monthly Trade by SITC Section',
    sourceUrl: DOSM_SITC_TRADE_PAGE,
    indexBase: '2010=100',
    latestMonth,
    latestIndexMonth,
    fetchedAt,
    sections: SITC_SECTIONS.map((section) => ({
      section,
      label: SITC_SECTION_LABELS[section],
      months: [...series.get(section).values()].sort((a, b) => a.month.localeCompare(b.month)),
    })),
  };
}

/** Seed acceptance: full section coverage, long history and a recent newest month. */
export function validateSitcTradePayload(data, now = new Date()) {
  if (!Array.isArray(data?.sections) || data.sections.length !== SITC_SECTIONS.length) return false;
  const months = data.sections[0]?.months?.length ?? 0;
  if (months < 400) return false;
  // DOSM publishes about four weeks after the reference month; 180 days tolerates a missed release.
  const newest = Date.parse(`${data.latestMonth}-01T00:00:00Z`);
  return Number.isFinite(newest) && now.getTime() - newest < 180 * 86_400_000;
}

export function countSitcTradeMonths(data) {
  return Array.isArray(data?.sections) ? data.sections.reduce((acc, section) => acc + (section.months?.length ?? 0), 0) : 0;
}
