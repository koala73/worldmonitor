// Norges Bank government zero-coupon yields (NSS fitted). SDMX-CSV:
//   https://data.norges-bank.no/api/data/GOVT_ZEROCOUPON/B...?startPeriod=2015&format=csv&bom=include&locale=en
// Semicolon-delimited long format with a one-row header; columns TENOR,
// TIME_PERIOD, OBS_VALUE. Tenors: 6M 9M 12M 2Y…10Y.

import { normalizeDateLabel, parseYieldNumber, collapseCurves } from './model.mjs';

export const NORGES_TENORS = {
  '6M': '6m', '9M': '9m', '12M': '1y', '2Y': '2y', '3Y': '3y', '4Y': '4y',
  '5Y': '5y', '6Y': '6y', '7Y': '7y', '8Y': '8y', '9Y': '9y', '10Y': '10y',
};

export function parseNorgesZeroCouponCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.replace(/^ï»¿/, '').startsWith('FREQ;Frequency;TENOR'));
  if (headerIndex === -1) return [];
  const headers = lines[headerIndex].replace(/^ï»¿/, '').split(';').map((cell) => cell.trim());
  const iTenor = headers.indexOf('TENOR');
  const iDate = headers.indexOf('TIME_PERIOD');
  const iValue = headers.indexOf('OBS_VALUE');
  if (iTenor === -1 || iDate === -1 || iValue === -1) return [];
  const byDate = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(';').map((cell) => cell.trim());
    if (cells.length <= Math.max(iTenor, iDate, iValue)) continue;
    const tenor = Object.prototype.hasOwnProperty.call(NORGES_TENORS, cells[iTenor]) ? NORGES_TENORS[cells[iTenor]] : null;
    if (!tenor) continue;
    const date = normalizeDateLabel(cells[iDate] ?? '');
    const value = parseYieldNumber(cells[iValue]);
    if (!date || value == null) continue;
    const point = byDate.get(date) ?? { date, tenors: {} };
    point.tenors[tenor] = value;
    byDate.set(date, point);
  }
  return collapseCurves([...byDate.values()]);
}
