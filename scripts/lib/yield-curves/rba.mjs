// RBA F2 capital-market yields — Australian Government bonds (interpolated
// AGS yields). f2-data.csv is daily since 2013-05-20 with five series: 2Y, 3Y,
// 5Y, 10Y nominal and the indexed (inflation-linked) bond, which is real and
// therefore excluded.

import { collapseCurves } from './model.mjs';

export const RBA_SERIES = {
  FCMYGBAG2D: '2y',
  FCMYGBAG3D: '3y',
  FCMYGBAG5D: '5y',
  FCMYGBAG10D: '10y',
};

function numericCell(cell) {
  const token = String(cell ?? '').trim();
  if (token === '' || token === '.') return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

const CSV_MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function csvDateToIso(token) {
  const match = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(token);
  const month = match && CSV_MONTHS[match[2]];
  if (!month) return null;
  const iso = `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Parse RBA's f2-data.csv: the same F2 table as f02d.xlsx at ~2.5% of its size.
 * Columns are mapped by the "Series ID" row, never by position; data rows are
 * "DD-Mon-YYYY" dates. Header rows can hold quoted commas, the Series ID and
 * data rows cannot, so those two are split plainly.
 */
export function parseRbaCsv(text) {
  const lines = String(text ?? '').replace(/^\ufeff/, '').split(/\r?\n/);
  const seriesLine = lines.find((line) => line.startsWith('Series ID,'));
  if (!seriesLine) return [];
  const columns = [];
  seriesLine.split(',').forEach((cell, col) => {
    const id = cell.trim();
    if (Object.hasOwn(RBA_SERIES, id)) columns.push({ col, tenor: RBA_SERIES[id] });
  });
  // A renamed or duplicated series would publish curves with a tenor silently
  // missing; require each nominal series exactly once.
  const tenors = new Set(columns.map(({ tenor }) => tenor));
  if (columns.length !== Object.keys(RBA_SERIES).length || tenors.size !== columns.length) return [];
  const out = [];
  for (const line of lines) {
    const cells = line.split(',');
    const date = csvDateToIso(cells[0]?.trim() ?? '');
    if (!date) continue;
    const tenors = {};
    for (const { col, tenor } of columns) {
      const value = numericCell(cells[col]);
      if (value == null) continue;
      tenors[tenor] = value;
    }
    if (Object.keys(tenors).length > 0) out.push({ date, tenors });
  }
  return collapseCurves(out);
}
