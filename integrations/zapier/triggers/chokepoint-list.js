'use strict';

const { BASE_URL, PATHS } = require('../constants');

const perform = async (z, _bundle) => {
  const response = await z.request({ url: `${BASE_URL}${PATHS.chokepointStatus}` });
  const chokepoints = Array.isArray(response.data && response.data.chokepoints) ? response.data.chokepoints : [];
  return chokepoints.map(({ id, name }) => ({ id, name }));
};

module.exports = {
  key: 'chokepoint_list',
  noun: 'Chokepoint',
  display: {
    label: 'List Chokepoints',
    description: 'Lists the monitored maritime chokepoints for the Chokepoint dropdown.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform,
    sample: { id: 'hormuz_strait', name: 'Strait of Hormuz' },
  },
};
