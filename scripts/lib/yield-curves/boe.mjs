// Bank of England gilt nominal spot curves (Anderson–Sleath fitted).
// latest-yield-curve-data.zip (refreshed daily, current month) and the
// glcnominalddata archive (1979→, one xlsx per era). Both zips contain four
// workbooks; the nominal one matches /GLC Nominal daily data/i.
//
// Sheet names drifted across eras: current files use "3. spot, short end" /
// "4. spot curve"; archive files (≤ 2004) use "3. nominal spot, short end" /
// "4. nominal spot curve". Both are matched by suffix.
//
// Sheet layout: row 4 holds the "years:" maturity grid on both sheets; data
// rows follow with an Excel date in column 1 and yields per column.

import { collapseCurves } from './model.mjs';

const SPOT_CURVE_SHEET = '4. spot curve';
const SHORT_END_SHEET = '3. spot, short end';

export const BOE_SPOT_CURVE_SHEET = SPOT_CURVE_SHEET;
export const BOE_SHORT_END_SHEET = SHORT_END_SHEET;
export const BOE_NOMINAL_ENTRY_MATCHER = /GLC Nominal daily data/i;

// The BoE grid publishes every half-year maturity (41 points ≥ 6m). The
// canonical payload keeps the standard whole-year tenor set plus the short-end
// months — the half-year intermediates would push the 47-year history past
// the 5 MB per-key payload limit (8.2 MB with them, ~4 MB without).
const KEPT_TENORS = new Set(['6m', '9m', '1y', '2y', '3y', '4y', '5y', '6y', '7y', '8y', '9y', '10y', '15y', '20y', '25y', '30y', '40y']);

function tenorLabel(years) {
  if (years < 1) {
    const months = Math.round(years * 12);
    return months === 6 || months === 9 ? `${months}m` : null;
  }
  const whole = Math.round(years);
  if (Math.abs(years - whole) > 1e-6) return null;
  return `${whole}y`;
}

function numericCell(cell) {
  if (cell == null) return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell === 'object') {
    const value = cell.result;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  const token = String(cell).trim();
  if (token === '' || token === '.') return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function excelDateToIso(cell) {
  let ms = null;
  if (cell instanceof Date) ms = cell.getTime();
  else if (typeof cell === 'number') ms = (cell - 25569) * 86400_000; // Excel serial → epoch ms (UTC)
  else if (typeof cell === 'object' && cell != null) {
    const value = cell.result;
    if (typeof value === 'number') ms = (value - 25569) * 86400_000;
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function sheetTenorColumns(sheet) {
  const yearsRow = sheet.getRow(4);
  const columns = [];
  yearsRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const years = numericCell(cell.value);
    if (years == null) return;
    const tenor = tenorLabel(years);
    if (tenor) columns.push({ col, tenor });
  });
  return columns;
}

function parseSheet(sheet) {
  const columns = sheetTenorColumns(sheet);
  const out = [];
  for (let n = 5; n <= sheet.rowCount; n += 1) {
    const row = sheet.getRow(n);
    const date = excelDateToIso(row.getCell(1).value);
    if (!date) continue;
    const tenors = {};
    for (const { col, tenor } of columns) {
      if (!KEPT_TENORS.has(tenor)) continue;
      const value = numericCell(row.getCell(col).value);
      if (value == null) continue;
      tenors[tenor] = value;
    }
    if (Object.keys(tenors).length > 0) out.push({ date, tenors });
  }
  return out;
}

function findSheet(workbook, preferredName) {
  const exact = workbook.getWorksheet?.(preferredName);
  if (exact) return exact;
  // Archive-era naming ("3. nominal spot, short end"). The preferred name is
  // "3. spot, short end" / "4. spot curve"; the archive inserts "nominal ".
  const legacy = preferredName.replace(/^([34]\. )/, '$1nominal ');
  return workbook.getWorksheet?.(legacy) ?? null;
}

/** Parse one BoE nominal workbook (an ExcelJS Workbook already loaded). */
export function parseBoeNominalWorkbook(workbook) {
  const spot = findSheet(workbook, SPOT_CURVE_SHEET);
  const shortEnd = findSheet(workbook, SHORT_END_SHEET);
  return collapseCurves([
    ...(spot ? parseSheet(spot) : []),
    ...(shortEnd ? parseSheet(shortEnd) : []),
  ]);
}
