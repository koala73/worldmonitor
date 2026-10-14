'use strict';

const { BASE_URL, PATHS } = require('../constants');

const perform = async (z, bundle) => {
  const params = {};
  if (bundle.inputData.country) {
    params.country = bundle.inputData.country;
  }
  if (bundle.inputData.start) {
    params.start = bundle.inputData.start;
  }
  if (bundle.inputData.end) {
    params.end = bundle.inputData.end;
  }
  if (bundle.inputData.page_size) {
    params.page_size = bundle.inputData.page_size;
  }

  const response = await z.request({
    url: `${BASE_URL}${PATHS.latestEvents}`,
    params,
  });
  const body = response.data;
  return Array.isArray(body && body.events) ? body.events : [];
};

module.exports = {
  key: 'latest_events',
  noun: 'Conflict Event',
  display: {
    label: 'Find Latest Conflict Events',
    description:
      'Search geolocated UCDP armed-conflict events by country name and optional ISO date range.',
  },
  operation: {
    inputFields: [
      {
        key: 'country',
        label: 'Country',
        type: 'string',
        required: false,
        helpText: 'Country name as used by UCDP, such as Sudan.',
      },
      {
        key: 'start',
        label: 'Start Date',
        type: 'string',
        required: false,
        helpText: 'Inclusive ISO date, such as 2026-06-01.',
      },
      {
        key: 'end',
        label: 'End Date',
        type: 'string',
        required: false,
        helpText: 'Inclusive ISO date, such as 2026-06-30.',
      },
      {
        key: 'page_size',
        label: 'Page Size',
        type: 'integer',
        required: false,
      },
    ],
    perform,
    sample: {
      id: 'ucdp-1',
      dateStart: '2026-06-28',
      dateEnd: '2026-06-28',
      location: 'Khartoum',
      country: 'Sudan',
      sideA: 'Government of Sudan',
      sideB: 'RSF',
      deathsBest: 12,
      deathsLow: 8,
      deathsHigh: 20,
      violenceType: 'state-based',
    },
  },
};
