'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);

const CHOKEPOINTS = {
  chokepoints: [
    { id: 'suez', name: 'Suez Canal', disruptionScore: 30, status: 'yellow' },
    { id: 'hormuz_strait', name: 'Strait of Hormuz', disruptionScore: 85, status: 'red' },
  ],
};

describe('search chokepoint_status', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  for (const chokepoint of ['hormuz_strait', 'Strait of Hormuz', ' strait of hormuz ']) {
    it(`finds Hormuz by "${chokepoint}"`, async () => {
      nock(BASE_URL).get(PATHS.chokepointStatus).reply(200, CHOKEPOINTS);

      const results = await appTester(App.searches.chokepoint_status.operation.perform, {
        authData: { apiKey: 'wm_test' },
        inputData: { chokepoint },
      });

      assert.deepEqual(results.map((c) => c.id), ['hormuz_strait']);
      assert.equal(results[0].disruptionScore, 85);
    });
  }

  it('returns an empty list for an unknown chokepoint', async () => {
    nock(BASE_URL).get(PATHS.chokepointStatus).reply(200, CHOKEPOINTS);

    const results = await appTester(App.searches.chokepoint_status.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: { chokepoint: 'atlantis' },
    });

    assert.deepEqual(results, []);
  });

  it('fills the Chokepoint dropdown from the hidden list trigger', async () => {
    nock(BASE_URL).get(PATHS.chokepointStatus).reply(200, CHOKEPOINTS);

    const results = await appTester(App.triggers.chokepoint_list.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: {},
    });

    assert.deepEqual(results, [
      { id: 'suez', name: 'Suez Canal' },
      { id: 'hormuz_strait', name: 'Strait of Hormuz' },
    ]);
    assert.equal(App.searches.chokepoint_status.operation.inputFields[0].dynamic, 'chokepoint_list.id.name');
  });
});
