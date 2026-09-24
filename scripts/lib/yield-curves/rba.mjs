// RBA F2 capital-market yields — Australian Government bonds (interpolated
// AGS yields). f02d.xlsx is daily since 2013-05-20 with five series: 2Y, 3Y,
// 5Y, 10Y nominal and the indexed (inflation-linked) bond, which is real and
// therefore excluded. Layout: row 2 titles, row 11 "Series ID" row; data rows
// start at row 12 with an Excel date in column 1.

import { collapseCurves } from './model.mjs';

export const RBA_SERIES = {
  FCMYGBAG2D: '2y',
  FCMYGBAG3D: '3y',
  FCMYGBAG5D: '5y',
  FCMYGBAG10D: '10y',
};

const SERIES_ID_ROW = 11;
const FIRST_DATA_ROW = 12;

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
  else if (typeof cell === 'number') ms = (cell - 25569) * 86400_000;
  else if (typeof cell === 'object' && cell != null) {
    const value = cell.result;
    if (typeof value === 'number') ms = (value - 25569) * 86400_000;
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse the "Data" worksheet of an RBA F2 workbook (ExcelJS Worksheet). */
export function parseRbaDataSheet(sheet) {
  if (!sheet) return [];
  const seriesRow = sheet.getRow(SERIES_ID_ROW);
  const columns = [];
  seriesRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const id = String(cell.value ?? '').trim();
    if (Object.prototype.hasOwnProperty.call(RBA_SERIES, id)) {
      columns.push({ col, tenor: RBA_SERIES[id] });
    }
  });
  const out = [];
  for (let n = FIRST_DATA_ROW; n <= sheet.rowCount; n += 1) {
    const row = sheet.getRow(n);
    const date = excelDateToIso(row.getCell(1).value);
    if (!date) continue;
    const tenors = {};
    for (const { col, tenor } of columns) {
      const value = numericCell(row.getCell(col).value);
      if (value == null) continue;
      tenors[tenor] = value;
    }
    if (Object.keys(tenors).length > 0) out.push({ date, tenors });
  }
  return collapseCurves(out);
}

export function parseRbaWorkbook(workbook) {
  return parseRbaDataSheet(workbook?.getWorksheet?.('Data'));
}
