'use strict';

const authentication = require('./authentication');
const { addAuthHeader, handleHttpError } = require('./middleware');
const countryRisk = require('./searches/country-risk');
const chokepointStatus = require('./searches/chokepoint-status');
const latestEvents = require('./searches/latest-events');
const newDiseaseOutbreak = require('./triggers/new-disease-outbreak');
const chokepointList = require('./triggers/chokepoint-list');

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  flags: { cleanInputData: false },
  authentication,
  beforeRequest: [addAuthHeader],
  afterResponse: [handleHttpError],
  searches: {
    [countryRisk.key]: countryRisk,
    [chokepointStatus.key]: chokepointStatus,
    [latestEvents.key]: latestEvents,
  },
  triggers: {
    [newDiseaseOutbreak.key]: newDiseaseOutbreak,
    [chokepointList.key]: chokepointList,
  },
};
