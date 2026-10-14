'use strict';

const BASE_URL = 'https://www.worldmonitor.app';
const AUTH_HEADER = 'X-WorldMonitor-Key';
const USER_AGENT = 'worldmonitor-zapier/1.0';

const PATHS = {
  countryRisk: '/api/intelligence/v1/get-country-risk',
  chokepointStatus: '/api/supply-chain/v1/get-chokepoint-status',
  latestEvents: '/api/conflict/v1/list-ucdp-events',
  diseaseOutbreaks: '/api/health/v1/list-disease-outbreaks',
};

module.exports = {
  BASE_URL,
  AUTH_HEADER,
  USER_AGENT,
  PATHS,
};
