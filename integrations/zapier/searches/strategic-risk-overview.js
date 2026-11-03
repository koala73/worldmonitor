'use strict';

const { BASE_URL, PATHS } = require('../constants');
const { toInteger } = require('../lib/hooks');

const DEFAULT_TOP_COUNTRIES = 5;
const MAX_TOP_COUNTRIES = 10;

// One row: the global strategic risk roll-up from get-risk-scores (score,
// level, the countries driving it) plus the highest Country Instability Index
// readings. Empty when the API has no roll-up this minute. Zapier requires a
// search to take at least one input (D009); the count of countries is the
// one knob the row has.
const perform = async (z, bundle) => {
  const topCount = Math.min(MAX_TOP_COUNTRIES, Math.max(1, toInteger(bundle.inputData.top_countries, DEFAULT_TOP_COUNTRIES)));
  const response = await z.request({ url: `${BASE_URL}${PATHS.riskScores}` });
  const data = response.data || {};
  const risks = Array.isArray(data.strategicRisks) ? data.strategicRisks : [];
  if (!risks.length) return [];
  const risk = risks[0];
  const scores = (Array.isArray(data.ciiScores) ? data.ciiScores : [])
    .filter((cii) => cii && typeof cii.region === 'string' && Number.isFinite(cii.combinedScore));
  const computedAt = Math.max(0, ...scores.map((cii) => (Number.isFinite(cii.computedAt) ? cii.computedAt : 0)));
  const topCountries = [...scores]
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, topCount)
    .map((cii) => ({
      countryCode: cii.region,
      score: cii.combinedScore,
      delta24h: Number.isFinite(cii.dynamicScore) ? cii.dynamicScore : 0,
      trend: cii.trend || 'TREND_DIRECTION_UNSPECIFIED',
      advisoryLevel: cii.advisoryLevel || null,
    }));
  return [{
    id: `${risk.region || 'global'}:${computedAt}`,
    region: risk.region || 'global',
    level: risk.level || 'SEVERITY_LEVEL_UNSPECIFIED',
    score: Number.isFinite(risk.score) ? risk.score : 0,
    factors: Array.isArray(risk.factors) ? risk.factors : [],
    trend: risk.trend || 'TREND_DIRECTION_UNSPECIFIED',
    topCountries,
    computedAt: computedAt > 0 ? new Date(computedAt).toISOString() : null,
    degraded: data.degraded === true,
    stale: data.stale === true,
  }];
};

module.exports = {
  key: 'strategic_risk_overview',
  noun: 'Strategic Risk Overview',
  display: {
    label: 'Find Strategic Risk Overview',
    description: 'Fetches the global strategic risk level and score with the countries driving it and the highest Country Instability Index readings.',
  },
  operation: {
    inputFields: [
      {
        key: 'top_countries',
        label: 'Countries to Include',
        type: 'integer',
        required: false,
        default: String(DEFAULT_TOP_COUNTRIES),
        helpText: `How many of the highest Country Instability Index readings to include as Top Countries, 1 to ${MAX_TOP_COUNTRIES}.`,
      },
    ],
    perform,
    sample: {
      id: 'global:1792240364085',
      region: 'global',
      level: 'SEVERITY_LEVEL_HIGH',
      score: 74,
      factors: ['RU', 'IR', 'UA'],
      trend: 'TREND_DIRECTION_UNSPECIFIED',
      topCountries: [
        { countryCode: 'RU', score: 90, delta24h: 0, trend: 'TREND_DIRECTION_STABLE', advisoryLevel: 'do-not-travel' },
        { countryCode: 'IR', score: 72, delta24h: 6, trend: 'TREND_DIRECTION_RISING', advisoryLevel: 'do-not-travel' },
      ],
      computedAt: '2026-10-17T12:32:44.085Z',
      degraded: false,
      stale: false,
    },
  },
};
