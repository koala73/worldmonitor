'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);

describe('search country_risk', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('returns the Sudan risk snapshot for country_code SD', async () => {
    nock(BASE_URL)
      .get(PATHS.countryRisk)
      .query({ country_code: 'SD' })
      .reply(200, {
        countryCode: 'SD',
        countryName: 'Sudan',
        advisoryLevel: 'do-not-travel',
        sanctionsActive: true,
        sanctionsCount: 41,
        fetchedAt: 1783250000000,
        upstreamUnavailable: false,
      });

    const results = await appTester(App.searches.country_risk.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: { country_code: 'sd' },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'SD');
    assert.equal(results[0].countryName, 'Sudan');
    assert.equal(results[0].countryCode, 'SD');
    assert.equal(results[0].advisoryLevel, 'do-not-travel');
    assert.equal(results[0].sanctionsCount, 41);
  });
});
