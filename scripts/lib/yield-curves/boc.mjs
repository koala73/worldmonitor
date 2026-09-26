// Bank of Canada Valet CSV group downloads.
// bond_yields_benchmark: on-the-run benchmark yields (2Y 3Y 5Y 7Y 10Y LONG RRB).
// TBILL_ALL: secondary-market T-bill averages (1M 3M 6M 1Y); the group carries
// both auction-average and daily-average series — the daily averages are used.
//
// Both files carry a quoted TERMS/SERIES preamble; observations start after the
// "OBSERVATIONS" marker row with a quoted "date" header.

import { normalizeDateLabel, parseYieldNumber, collapseCurves } from './model.mjs';

export const BENCHMARK_SERIES = {
  'BD.CDN.2YR.DQ.YLD': '2y',
  'BD.CDN.3YR.DQ.YLD': '3y',
  'BD.CDN.5YR.DQ.YLD': '5y',
  'BD.CDN.7YR.DQ.YLD': '7y',
  'BD.CDN.10YR.DQ.YLD': '10y',
  // "Long-term benchmark" is a ~30-year bond; labeled 30y as the curve endpoint.
  'BD.CDN.LONG.DQ.YLD': '30y',
  // Real-return bond yield is real, not nominal — excluded (null).
  'BD.CDN.RRB.DQ.YLD': null,
};

export const TBILL_DAILY_SERIES = {
  V80691342: '1m',
  V80691344: '3m',
  V80691345: '6m',
  V80691346: '1y',
};

function parseValetObservationsCsv(csv, seriesMap) {
  const lines = String(csv ?? '').split(/\r?\n/);
  const obsIndex = lines.findIndex((line) => line.replace(/"/g, '').trim() === 'OBSERVATIONS');
  if (obsIndex === -1) return [];
  const headers = (lines[obsIndex + 1] ?? '').split(',').map((cell) => cell.replace(/"/g, '').trim());
  const columns = headers.map((header) => (Object.prototype.hasOwnProperty.call(seriesMap, header) ? seriesMap[header] : null));
  const out = [];
  for (const line of lines.slice(obsIndex + 2)) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((cell) => cell.replace(/"/g, '').trim());
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

export function parseBocBenchmarkCsv(csv) {
  return parseValetObservationsCsv(csv, BENCHMARK_SERIES);
}

export function parseBocTbillCsv(csv) {
  return parseValetObservationsCsv(csv, TBILL_DAILY_SERIES);
}

/** Merge the benchmark and T-bill groups into one curve per date. */
export function mergeBocCurves(benchmark, tbill) {
  return collapseCurves([...benchmark, ...tbill]);
}
