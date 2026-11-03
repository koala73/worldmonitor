'use strict';

const authentication = require('./authentication');
const { addAuthHeader, handleHttpError } = require('./middleware');
const countryRisk = require('./searches/country-risk');
const chokepointStatus = require('./searches/chokepoint-status');
const latestEvents = require('./searches/latest-events');
const newDiseaseOutbreak = require('./triggers/new-disease-outbreak');
const chokepointList = require('./triggers/chokepoint-list');
const countryList = require('./triggers/country-list');
const chokepointDisruption = require('./triggers/chokepoint-disruption');
const countryRiskSurge = require('./triggers/country-risk-surge');
const newsBreaking = require('./triggers/news-breaking');
const marketMove = require('./triggers/market-move');
const naturalHazard = require('./triggers/natural-hazard');
const findNews = require('./searches/find-news');
const strategicRiskOverview = require('./searches/strategic-risk-overview');

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
    [findNews.key]: findNews,
    [strategicRiskOverview.key]: strategicRiskOverview,
  },
  triggers: {
    [chokepointDisruption.key]: chokepointDisruption,
    [countryRiskSurge.key]: countryRiskSurge,
    [newsBreaking.key]: newsBreaking,
    [marketMove.key]: marketMove,
    [naturalHazard.key]: naturalHazard,
    [newDiseaseOutbreak.key]: newDiseaseOutbreak,
    [chokepointList.key]: chokepointList,
    [countryList.key]: countryList,
  },
};
