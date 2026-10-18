// ChinaBond (CCDC) MOF-China government treasury yield curve — par YTM.
// The public cbweb-czb-web czbChartSearch endpoint returns the latest
// business day's full curve as [[years, percent], …] with 111 points from
// 0.0 to 30.0. History requires the licensed annual download (PR 2).
//
// Sampled onto the standard tenor grid: exact whole-year maturities plus
// 3m/6m at 0.25/0.5 years.

import { collapseCurves } from './model.mjs';

export const CHINABOND_SAMPLE_YEARS = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30];

function tenorLabel(years) {
  if (years < 1) {
    const months = Math.round(years * 12);
    return months === 3 || months === 6 ? `${months}m` : null;
  }
  const whole = Math.round(years);
  if (Math.abs(years - whole) > 1e-6) return null;
  return `${whole}y`;
}

export function parseChinaBondSearch(json) {
  const entries = Array.isArray(json) ? json : [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const worktime = String(entry.worktime ?? '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(worktime) ? worktime : null;
    const seriesData = entry.seriesData;
    if (!date || !Array.isArray(seriesData)) continue;
    const byYears = new Map();
    for (const point of seriesData) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [years, value] = point;
      if (typeof years !== 'number' || typeof value !== 'number' || !Number.isFinite(value)) continue;
      byYears.set(years, value);
    }
    const tenors = {};
    for (const years of CHINABOND_SAMPLE_YEARS) {
      const tenor = tenorLabel(years);
      if (!tenor) continue;
      const value = byYears.get(years);
      if (value == null) continue;
      tenors[tenor] = value;
    }
    if (Object.keys(tenors).length > 0) out.push({ date, tenors });
  }
  return collapseCurves(out);
}
