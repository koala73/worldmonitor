'use strict';

const { BASE_URL, PATHS } = require('../constants');

const MAX_RESULTS = 25;

const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}${PATHS.latestEvents}`,
    params: { country: String(bundle.inputData.country || '').trim() },
  });
  const events = Array.isArray(response.data && response.data.events) ? response.data.events : [];
  return [...events].sort((a, b) => (b.dateStart || 0) - (a.dateStart || 0)).slice(0, MAX_RESULTS);
};

module.exports = {
  key: 'latest_events',
  noun: 'Conflict Event',
  display: {
    label: 'Find Latest Conflict Events',
    description:
      'Finds the most recent geolocated UCDP armed-conflict events in a country, newest first.',
  },
  operation: {
    inputFields: [
      {
        key: 'country',
        label: 'Country',
        type: 'string',
        required: true,
        helpText: 'Country name or ISO 3166-1 alpha-2 code, such as Sudan or SD.',
      },
    ],
    perform,
    sample: {
      id: '639816',
      dateStart: 1788134400000,
      dateEnd: 1788134400000,
      location: { latitude: 12.483333, longitude: 25.8 },
      country: 'Sudan',
      sideA: 'Government of Sudan',
      sideB: 'SFA',
      deathsBest: 4,
      deathsLow: 4,
      deathsHigh: 4,
      violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
      sourceOriginal: 'Sources from the city of Al-Abyad',
    },
  },
};
