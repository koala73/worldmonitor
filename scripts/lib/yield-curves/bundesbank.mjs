// Bundesbank daily term structure on listed Federal securities (Svensson),
// par yields derived from the curve ("ZAR" series family).
// One wildcard SDMX request returns all tenor columns at once:
//   BBSIS/D.I.ZAR.ZI.EUR.S1311.B.A604..R.A.A._Z._Z.A?format=csv
// Semicolon-delimited with a metadata preamble; decimals are German commas and
// missing values are '.' (with a flag column carrying "Kein Wert vorhanden").

import { normalizeDateLabel, parseYieldNumber, collapseCurves } from './model.mjs';

export const BUNDESBANK_PAR_TENORS = {
  R01XX: '1y', R02XX: '2y', R03XX: '3y', R04XX: '4y', R05XX: '5y', R06XX: '6y',
  R07XX: '7y', R08XX: '8y', R09XX: '9y', R10XX: '10y', R15XX: '15y', R20XX: '20y',
  R30XX: '30y',
};

export function parseBundesbankCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  // Header row is the first line carrying a BBSIS series key in cell 2.
  const headerIndex = lines.findIndex((line) => /;BBSIS\.[^;]+;/.test(line));
  if (headerIndex === -1) return [];
  const headers = lines[headerIndex].split(';');
  const columns = headers.map((header) => {
    const match = /(R\d{2}XX)\b/.exec(header);
    return match && Object.prototype.hasOwnProperty.call(BUNDESBANK_PAR_TENORS, match[1])
      ? BUNDESBANK_PAR_TENORS[match[1]]
      : null;
  });
  const out = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(';');
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
