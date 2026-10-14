'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, AUTH_HEADER, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);

describe('authentication', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('accepts a key when country risk for US returns 200', async () => {
    nock(BASE_URL, {
      reqheaders: {
        [AUTH_HEADER]: 'wm_0123456789abcdef0123456789abcdef01234567',
        'user-agent': 'worldmonitor-zapier/1.0',
      },
    })
      .get(PATHS.countryRisk)
      .query({ country_code: 'US' })
      .reply(200, { countryCode: 'US', countryName: 'United States' });

    const result = await appTester(App.authentication.test, {
      authData: { apiKey: 'wm_0123456789abcdef0123456789abcdef01234567' },
    });

    assert.equal(result.countryName, 'United States');
    assert.equal(result.countryCode, 'US');
    assert.equal(App.authentication.connectionLabel, undefined);
  });

  it('rejects an invalid key with 401', async () => {
    nock(BASE_URL)
      .get(PATHS.countryRisk)
      .query({ country_code: 'US' })
      .reply(401, { error: 'Invalid API key' });

    await assert.rejects(
      () => appTester(App.authentication.test, { authData: { apiKey: 'bad' } }),
      (error) => {
        assert.match(String(error.message), /401/);
        return true;
      },
    );
  });
});
