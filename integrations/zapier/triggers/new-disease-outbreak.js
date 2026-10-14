'use strict';

const { BASE_URL, PATHS } = require('../constants');

const perform = async (z, _bundle) => {
  const response = await z.request({
    url: `${BASE_URL}${PATHS.diseaseOutbreaks}`,
  });
  const body = response.data;
  return Array.isArray(body && body.outbreaks) ? body.outbreaks : [];
};

module.exports = {
  key: 'new_disease_outbreak',
  noun: 'Disease Outbreak',
  display: {
    label: 'New Disease Outbreak',
    description:
      'Triggers when WorldMonitor lists a disease outbreak alert from the health service.',
  },
  operation: {
    type: 'polling',
    inputFields: [],
    perform,
    sample: {
      id: 'outbreak-cd-1',
      disease: 'mpox',
      location: 'Democratic Republic of the Congo',
      countryCode: 'CD',
      alertLevel: 'warning',
      summary: 'WHO-reported outbreak',
      publishedAt: 1783250000000,
      sourceName: 'WHO',
    },
  },
};
