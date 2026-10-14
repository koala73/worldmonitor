'use strict';

const { BASE_URL, PATHS } = require('./constants');

const testAuth = async (z, _bundle) => {
  const response = await z.request({
    url: `${BASE_URL}${PATHS.countryRisk}`,
    params: { country_code: 'US' },
  });
  return response.data;
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'string',
      required: true,
      helpText:
        'Create a wm_ key from Dashboard → Settings → API Keys on an API Starter or API Business plan. Send it as X-WorldMonitor-Key. See https://www.worldmonitor.app/docs/api-keys',
    },
  ],
  test: testAuth,
};
