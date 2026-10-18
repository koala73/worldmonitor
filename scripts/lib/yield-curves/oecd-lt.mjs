// OECD MEI long-term government bond yields via FRED reprints
// (IRLTLT01<CC>M156N, monthly). FRED serves keyless CSV:
//   https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES>
// One column per requested series; missing prints are '.'.
//
// The seeder fans out over the verified markets. Note these series are
// monthly 10Y benchmarks — a different measure and cadence from the daily
// fitted curves, surfaced as measure "monthly-10y".

export const OECD_LT_MARKETS = {
  DE: 'IRLTLT01DEM156N', JP: 'IRLTLT01JPM156N', GB: 'IRLTLT01GBM156N', CA: 'IRLTLT01CAM156N',
  AU: 'IRLTLT01AUM156N', CH: 'IRLTLT01CHM156N', NO: 'IRLTLT01NOM156N', SE: 'IRLTLT01SEM156N',
  IT: 'IRLTLT01ITM156N', ES: 'IRLTLT01ESM156N', KR: 'IRLTLT01KRM156N', MX: 'IRLTLT01MXM156N',
  ZA: 'IRLTLT01ZAM156N', PL: 'IRLTLT01PLM156N', NL: 'IRLTLT01NLM156N', BE: 'IRLTLT01BEM156N',
  AT: 'IRLTLT01ATM156N', PT: 'IRLTLT01PTM156N', IE: 'IRLTLT01IEM156N', FI: 'IRLTLT01FIM156N',
  DK: 'IRLTLT01DKM156N', GR: 'IRLTLT01GRM156N', CZ: 'IRLTLT01CZM156N', HU: 'IRLTLT01HUM156N',
  CL: 'IRLTLT01CLM156N', FR: 'IRLTLT01FRM156N', US: 'IRLTLT01USM156N',
};

export const OECD_LT_TENOR = '10y';

import { normalizeDateLabel, parseYieldNumber } from './model.mjs';

export function parseFredCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  if (lines.length < 2) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    if (cells.length < 2) continue;
    const date = normalizeDateLabel(cells[0] ?? '');
    const value = parseYieldNumber(cells[1]);
    if (!date || value == null) continue;
    out.push({ date, value });
  }
  return out;
}

/** Build the canonical OECD payload from per-market parsed series. */
export function buildOecdLtPayload(series) {
  const countries = {};
  for (const [market, points] of Object.entries(series)) {
    if (!Array.isArray(points) || points.length === 0) continue;
    countries[market] = {
      curves: points.map(({ date, value }) => ({ date, tenors: { [OECD_LT_TENOR]: value } })),
    };
  }
  return { countries };
}

export function declareOecdRecords(payload) {
  const countries = payload?.countries;
  if (!countries || typeof countries !== 'object') return 0;
  return Object.values(countries).reduce((sum, entry) => sum + (Array.isArray(entry?.curves) ? entry.curves.length : 0), 0);
}
