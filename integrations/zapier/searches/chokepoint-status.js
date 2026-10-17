'use strict';

const { BASE_URL, PATHS } = require('../constants');

const perform = async (z, bundle) => {
  const wanted = String(bundle.inputData.chokepoint || '').trim().toLowerCase();
  const response = await z.request({ url: `${BASE_URL}${PATHS.chokepointStatus}` });
  const chokepoints = Array.isArray(response.data && response.data.chokepoints) ? response.data.chokepoints : [];
  return chokepoints.filter(
    (c) => String(c.id).toLowerCase() === wanted || String(c.name).toLowerCase() === wanted,
  );
};

module.exports = {
  key: 'chokepoint_status',
  noun: 'Chokepoint',
  display: {
    label: 'Find Chokepoint Status',
    description:
      'Finds the live disruption status of a monitored maritime chokepoint, such as the Strait of Hormuz or the Suez Canal.',
  },
  operation: {
    inputFields: [
      {
        key: 'chokepoint',
        label: 'Chokepoint',
        type: 'string',
        required: true,
        dynamic: 'chokepoint_list.id.name',
        helpText: 'Pick a chokepoint, or enter its ID (such as hormuz_strait) or name (such as Strait of Hormuz).',
      },
    ],
    perform,
    sample: {
      id: 'hormuz_strait',
      name: 'Strait of Hormuz',
      lat: 26.56,
      lon: 56.25,
      disruptionScore: 85,
      status: 'red',
      activeWarnings: 0,
      congestionLevel: 'high',
      warRiskTier: 'WAR_RISK_TIER_WAR_ZONE',
      description: 'Active conflict; Iranian naval blockade risk and mines reported in the Persian Gulf.',
    },
  },
};
