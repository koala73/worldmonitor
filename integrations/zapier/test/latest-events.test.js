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

  it('sends only the country filter and returns the newest 25 events first', async () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ id: String(i), dateStart: 1788000000000 + i * 86400000, country: 'Sudan' }));
    nock(BASE_URL)
      .get(PATHS.latestEvents)
      .query({ country: 'SD' })
      .reply(200, { events });

    const results = await appTester(App.searches.latest_events.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: { country: ' SD ' },
    });

    assert.equal(results.length, 25);
    assert.deepEqual(results.slice(0, 3).map((e) => e.id), ['29', '28', '27']);
  });

  it('returns an empty list when the country has no events', async () => {
    nock(BASE_URL).get(PATHS.latestEvents).query({ country: 'Iceland' }).reply(200, { events: [] });

    const results = await appTester(App.searches.latest_events.operation.perform, {
      authData: { apiKey: 'wm_test' },
      inputData: { country: 'Iceland' },
    });

    assert.deepEqual(results, []);
  });

  it('offers only the country field the API implements', () => {
    const keys = App.searches.latest_events.operation.inputFields.map((f) => f.key);
    assert.deepEqual(keys, ['country']);
  });
});
