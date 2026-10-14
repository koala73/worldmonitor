'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);

describe('search latest_events', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('returns UCDP events for Sudan', async () => {
    nock(BASE_URL)
      .get(PATHS.latestEvents)
      .query({ country: 'Sudan', start: '2026-06-01' })
      .reply(200, {
        events: [
          {
            id: 'ucdp-1',
            dateStart: '2026-06-28',
            country: 'Sudan',
            location: 'Khartoum',
            deathsBest: 12,
          },
        ],
      });

    const results = await appTester(App.searches.latest_events.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: { country: 'Sudan', start: '2026-06-01' },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'ucdp-1');
    assert.equal(results[0].country, 'Sudan');
    assert.equal(results[0].location, 'Khartoum');
    assert.equal(results[0].deathsBest, 12);
  });
});
