'use strict';

const { BASE_URL, PATHS } = require('../constants');

// Zapier treats the first rows as the newest, and the API groups rows by source.
const perform = async (z, _bundle) => {
  const response = await z.request({ url: `${BASE_URL}${PATHS.diseaseOutbreaks}` });
  const outbreaks = Array.isArray(response.data && response.data.outbreaks) ? response.data.outbreaks : [];
  return [...outbreaks].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
};

module.exports = {
  key: 'new_disease_outbreak',
  noun: 'Disease Outbreak',
  display: {
    label: 'New Disease Outbreak',
    description:
      'Triggers when WorldMonitor lists a new disease outbreak report from WHO, ECDC, CDC, CIDRAP, or ThinkGlobalHealth.',
  },
  operation: {
    type: 'polling',
    inputFields: [],
    perform,
    sample: {
      id: 'thinkglobalhealth-lh9lkn-1792022400000',
      disease: 'Measles',
      location: 'Pennsylvania',
      countryCode: 'US',
      alertLevel: 'alert',
      summary: "Pennsylvania's Department of Health recorded a sixth death in its ongoing measles outbreak as cases reach 1,222.",
      sourceUrl: 'https://www.pa.gov/agencies/health/diseases-conditions/infectious-disease/measles',
      publishedAt: 1792022400000,
      sourceName: 'ThinkGlobalHealth',
      lat: 40.93009949,
      lng: -77.4756012,
      cases: 1222,
    },
  },
};
