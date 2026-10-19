'use strict';

const { EVENT_REGISTRY } = require('../constants');

const COUNTRIES = EVENT_REGISTRY.events['country.risk_surge'].countries;

// The monitored-country set comes from the event registry, which the server
// enforces on registration, so the dropdown cannot offer a code the API
// rejects. No request is needed.
const perform = async () => Object.entries(COUNTRIES)
  .map(([id, name]) => ({ id, name: `${name} (${id})` }))
  .sort((a, b) => a.name.localeCompare(b.name));

module.exports = {
  key: 'country_list',
  noun: 'Country',
  display: {
    label: 'List Monitored Countries',
    description: 'Lists the countries with a Country Instability Index for the Countries dropdown.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform,
    sample: { id: 'IR', name: 'Iran (IR)' },
  },
};
