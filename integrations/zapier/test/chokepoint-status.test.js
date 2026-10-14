'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);

describe('search chokepoint_status', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('returns Hormuz from the chokepoints array', async () => {
    nock(BASE_URL)
      .get(PATHS.chokepointStatus)
      .reply(200, {
        chokepoints: [
          {
            id: 'hormuz_strait',
            name: 'Strait of Hormuz',
            disruptionScore: 42,
            status: 'yellow',
          },
        ],
      });

    const results = await appTester(App.searches.chokepoint_status.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: {},
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'hormuz_strait');
    assert.equal(results[0].name, 'Strait of Hormuz');
    assert.equal(results[0].disruptionScore, 42);
    assert.equal(results[0].status, 'yellow');
  });
});
