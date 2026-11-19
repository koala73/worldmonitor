'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);
const search = App.searches.strategic_risk_overview.operation;
const AUTH = { apiKey: 'wm_test' };

// Recorded from get-risk-scores on 2026-10-17 (trimmed).
const RISK_SCORES = {
  ciiScores: [
    { region: 'RU', staticBaseline: 35, dynamicScore: 0, combinedScore: 90, trend: 'TREND_DIRECTION_STABLE', computedAt: 1792240364085, advisoryLevel: 'do-not-travel' },
    { region: 'IR', staticBaseline: 50, dynamicScore: 6, combinedScore: 72, trend: 'TREND_DIRECTION_RISING', computedAt: 1792240364085, advisoryLevel: 'do-not-travel' },
    { region: 'DE', staticBaseline: 10, dynamicScore: 12, combinedScore: 31, trend: 'TREND_DIRECTION_RISING', computedAt: 1792240364085, advisoryLevel: 'normal' },
    { region: 'BR', staticBaseline: 50, dynamicScore: 0, combinedScore: 50, trend: 'TREND_DIRECTION_STABLE', computedAt: 1792240364000 },
    { region: 'UA', staticBaseline: 60, dynamicScore: 3, combinedScore: 85, trend: 'TREND_DIRECTION_STABLE', computedAt: 1792240364085, advisoryLevel: 'do-not-travel' },
    { region: 'JP', staticBaseline: 5, dynamicScore: 0, combinedScore: 12, trend: 'TREND_DIRECTION_STABLE', computedAt: 1792240364085, advisoryLevel: 'normal' },
  ],
  strategicRisks: [{ region: 'global', level: 'SEVERITY_LEVEL_HIGH', score: 74, factors: ['RU', 'UA', 'IR'], trend: 'TREND_DIRECTION_UNSPECIFIED' }],
  degraded: false,
  stale: false,
};

describe('search strategic_risk_overview', () => {
  afterEach(() => nock.cleanAll());

  it('returns one row: the global roll-up with the five highest index readings', async () => {
    nock(BASE_URL).get(PATHS.riskScores).reply(200, RISK_SCORES);
    const rows = await appTester(search.perform, { authData: AUTH, inputData: {} });
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.id, 'global:1792240364085');
    assert.equal(row.level, 'SEVERITY_LEVEL_HIGH');
    assert.equal(row.score, 74);
    assert.deepEqual(row.factors, ['RU', 'UA', 'IR']);
    assert.deepEqual(row.topCountries.map((c) => c.countryCode), ['RU', 'UA', 'IR', 'BR', 'DE']);
    assert.deepEqual(row.topCountries[1], { countryCode: 'UA', score: 85, delta24h: 3, trend: 'TREND_DIRECTION_STABLE', advisoryLevel: 'do-not-travel' });
    assert.equal(row.topCountries[3].advisoryLevel, null);
    assert.equal(row.computedAt, '2026-10-17T12:32:44.085Z');
    assert.equal(row.degraded, false);
    assert.deepEqual(Object.keys(row).sort(), Object.keys(search.sample).sort());
  });

  it('honours the country count input, clamped to 1-10', async () => {
    nock(BASE_URL).get(PATHS.riskScores).reply(200, RISK_SCORES);
    const two = await appTester(search.perform, { authData: AUTH, inputData: { top_countries: '2' } });
    assert.deepEqual(two[0].topCountries.map((c) => c.countryCode), ['RU', 'UA']);
    nock(BASE_URL).get(PATHS.riskScores).reply(200, RISK_SCORES);
    const clamped = await appTester(search.perform, { authData: AUTH, inputData: { top_countries: '0' } });
    assert.equal(clamped[0].topCountries.length, 1);
  });

  it('returns no rows when the API has no roll-up', async () => {
    nock(BASE_URL).get(PATHS.riskScores).reply(200, { ...RISK_SCORES, strategicRisks: [] });
    assert.deepEqual(await appTester(search.perform, { authData: AUTH, inputData: {} }), []);
  });
});
