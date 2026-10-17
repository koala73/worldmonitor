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

  it('returns outbreaks newest first across sources', async () => {
    nock(BASE_URL)
      .get(PATHS.diseaseOutbreaks)
      .reply(200, {
        outbreaks: [
          { id: 'thinkglobalhealth-a-1', disease: 'Polio', countryCode: 'PK', publishedAt: 1791763200000 },
          { id: 'thinkglobalhealth-b-2', disease: 'Polio', countryCode: 'SS', publishedAt: 1791763200000 },
          { id: 'cidrap-c-3', disease: 'Plague', countryCode: 'RU', publishedAt: 1792022400000 },
        ],
        fetchedAt: 1792022400000,
      });

    const results = await appTester(App.triggers.new_disease_outbreak.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: {},
    });

    assert.deepEqual(results.map((o) => o.id), ['cidrap-c-3', 'thinkglobalhealth-a-1', 'thinkglobalhealth-b-2']);
  });
});
