// Japan MOF constant-maturity JGB par yields.
// Files: jgbcme.csv (current month) and historical/jgbcme_all.csv (since
// 1974-09-24). UTF-8 CSV with a one-line title preamble; missing prints are
// '-' and every value is a percent par yield.

import { normalizeDateLabel, parseYieldNumber, collapseCurves } from './model.mjs';

export function parseJgbCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  // Find the header row: first line whose first cell is exactly "Date".
  const headerIndex = lines.findIndex((line) => line.split(',')[0]?.trim() === 'Date');
  if (headerIndex === -1) return [];
  const headers = lines[headerIndex].split(',').map((cell) => cell.trim());
  const columns = headers.map((header) => (/^(\d+)Y$/.test(header) ? `${Number(RegExp.$1)}y` : null));
  const out = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const date = normalizeDateLabel(cells[0] ?? '');
    if (!date) continue;
    const tenors = {};
    for (let i = 1; i < cells.length && i < columns.length; i += 1) {
      const tenor = columns[i];
      if (!tenor) continue;
      const value = parseYieldNumber(cells[i]);
      if (value == null) continue;
      tenors[tenor] = value;
    }
    if (Object.keys(tenors).length > 0) out.push({ date, tenors });
  }
  return collapseCurves(out);
}
