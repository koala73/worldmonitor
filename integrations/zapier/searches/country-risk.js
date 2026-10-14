'use strict';

const { BASE_URL, PATHS } = require('../constants');

const perform = async (z, bundle) => {
  const countryCode = String(bundle.inputData.country_code || '').toUpperCase();
  const response = await z.request({
    url: `${BASE_URL}${PATHS.countryRisk}`,
    params: { country_code: countryCode },
  });
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  return [
    {
      ...data,
      id: data.countryCode || countryCode,
    },
  ];
};

module.exports = {
  key: 'country_risk',
  noun: 'Country Risk',
  display: {
    label: 'Find Country Risk',
    description:
      'Fetch the Country Instability Index, travel advisory, and sanctions snapshot for one ISO 3166-1 alpha-2 country code.',
  },
  operation: {
    inputFields: [
      {
        key: 'country_code',
        label: 'Country Code',
        type: 'string',
        required: true,
        helpText: 'Uppercase ISO 3166-1 alpha-2 code, such as IR or SD.',
      },
    ],
    perform,
    sample: {
      id: 'SD',
      countryCode: 'SD',
      countryName: 'Sudan',
      advisoryLevel: 'do-not-travel',
      sanctionsActive: true,
      sanctionsCount: 41,
      fetchedAt: 1783250000000,
      upstreamUnavailable: false,
    },
  },
};
