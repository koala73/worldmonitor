'use strict';

const { BASE_URL, PATHS } = require('../constants');

const perform = async (z, _bundle) => {
  const response = await z.request({
    url: `${BASE_URL}${PATHS.chokepointStatus}`,
  });
  const body = response.data;
  if (Array.isArray(body)) {
    return body;
  }
  if (Array.isArray(body && body.chokepoints)) {
    return body.chokepoints;
  }
  return [body];
};

module.exports = {
  key: 'chokepoint_status',
  noun: 'Chokepoint',
  display: {
    label: 'Find Chokepoint Status',
    description:
      'Fetch live disruption status for the monitored maritime chokepoints, including Hormuz, Suez, Malacca, and Bab el-Mandeb.',
  },
  operation: {
    inputFields: [],
    perform,
    sample: {
      id: 'hormuz_strait',
      name: 'Strait of Hormuz',
      lat: 26.57,
      lon: 56.25,
      disruptionScore: 42,
      status: 'yellow',
      activeWarnings: 2,
      congestionLevel: 'elevated',
    },
  },
};
