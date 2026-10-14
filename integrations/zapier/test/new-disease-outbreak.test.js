'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);

describe('trigger new_disease_outbreak', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('returns outbreak rows with stable ids', async () => {
    nock(BASE_URL)
      .get(PATHS.diseaseOutbreaks)
      .reply(200, {
        outbreaks: [
          {
            id: 'outbreak-cd-1',
            disease: 'mpox',
            countryCode: 'CD',
            alertLevel: 'warning',
            publishedAt: 1783250000000,
          },
        ],
        fetchedAt: 1783250000000,
      });

    const results = await appTester(App.triggers.new_disease_outbreak.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: {},
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'outbreak-cd-1');
    assert.equal(results[0].disease, 'mpox');
    assert.equal(results[0].countryCode, 'CD');
    assert.equal(results[0].alertLevel, 'warning');
  });
});
