// Swiss National Bank daily spot rates on Confederation bonds
// (Nelson–Siegel–Svensson fitted). The supplementary Confederation cube
// SNB1A.SNB.NSS.KZS.EID publishes daily; rendeiduebd republishes monthly.
// Keep the same 12 tenors and only daily, unaggregated observations at 11am.

import { normalizeDateLabel, parseYieldNumber, collapseCurves } from './model.mjs';

export const SNB_TENORS = {
  'J01M0': '1y', 'J02M0': '2y', 'J03M0': '3y', 'J04M0': '4y', 'J05M0': '5y', 'J06M0': '6y',
  'J07M0': '7y', 'J08M0': '8y', 'J09M0': '9y', 'J10M0': '10y', 'J20M0': '20y', 'J30M0': '30y',
};

export function parseSnbConfederationCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.replace(/"/g, '').trim() === 'Date;LAUFZEIT;ZEITPUNKT;frequency;AGGREGATIONSMETHODE;Value');
  if (headerIndex === -1) return [];
  const byDate = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(';').map((cell) => cell.replace(/"/g, '').trim());
    if (cells.length < 6) continue;
    if (cells[2] !== 'A1100' || cells[3] !== 'P1D_L' || cells[4] !== 'ZZ') continue;
    const tenor = Object.prototype.hasOwnProperty.call(SNB_TENORS, cells[1]) ? SNB_TENORS[cells[1]] : null;
    if (!tenor) continue;
    const date = normalizeDateLabel(cells[0] ?? '');
    const value = parseYieldNumber(cells[5]);
    if (!date || value == null) continue;
    const point = byDate.get(date) ?? { date, tenors: {} };
    point.tenors[tenor] = value;
    byDate.set(date, point);
  }
  return collapseCurves([...byDate.values()]);
}
