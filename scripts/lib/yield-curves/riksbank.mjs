// Riksbank SWEA API government bond fixings. The API publishes one series per
// maturity (SEGVB2YC, SEGVB5YC, SEGVB7YC, SEGVB10YC) with date-ranged
// observations:
//   https://api.riksbank.se/swea/v1/Observations/<id>/<from>/<to>
// Ranges are capped; full history is fetched per series in yearly windows.

import { normalizeDateLabel, collapseCurves } from './model.mjs';

export const RIKSBANK_SERIES = {
  SEGVB2YC: '2y',
  SEGVB5YC: '5y',
  SEGVB7YC: '7y',
  SEGVB10YC: '10y',
};

export function parseRiksbankObservations(seriesId, observations) {
  const tenor = Object.prototype.hasOwnProperty.call(RIKSBANK_SERIES, seriesId) ? RIKSBANK_SERIES[seriesId] : null;
  if (!tenor || !Array.isArray(observations)) return [];
  const out = [];
  for (const obs of observations) {
    if (!obs || typeof obs !== 'object') continue;
    const date = normalizeDateLabel(String(obs.date ?? ''));
    const value = typeof obs.value === 'number' && Number.isFinite(obs.value) ? obs.value : null;
    if (!date || value == null) continue;
    out.push({ date, tenors: { [tenor]: value } });
  }
  return collapseCurves(out);
}
