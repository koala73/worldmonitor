'use strict';

const BASE_URL = 'https://www.worldmonitor.app';
const AUTH_HEADER = 'X-WorldMonitor-Key';
const USER_AGENT = 'worldmonitor-zapier/1.2';

const PATHS = {
  countryRisk: '/api/intelligence/v1/get-country-risk',
  chokepointStatus: '/api/supply-chain/v1/get-chokepoint-status',
  latestEvents: '/api/conflict/v1/list-ucdp-events',
  diseaseOutbreaks: '/api/health/v1/list-disease-outbreaks',
  riskScores: '/api/intelligence/v1/get-risk-scores',
  webhooks: '/api/v2/shipping/webhooks',
  feedDigest: '/api/news/v1/list-feed-digest',
  marketQuotes: '/api/market/v1/list-market-quotes',
  commodityQuotes: '/api/market/v1/list-commodity-quotes',
  cryptoQuotes: '/api/market/v1/list-crypto-quotes',
  earthquakes: '/api/seismology/v1/list-earthquakes',
  naturalEvents: '/api/natural/v1/list-natural-events',
};

// Surface-neutral event registry (shared/event-triggers.json at the repo
// root). Zapier bundles only this folder, so the file is mirrored here;
// test/event-registry.test.js pins the copy to the canonical one.
const EVENT_REGISTRY = require('./event-triggers.json');

// Zapier re-subscribes before a webhook subscription expires when the
// subscribe response carries expiration_date. Subscriptions live 30 days.
const SUBSCRIPTION_RENEW_DAYS = 29;

module.exports = {
  BASE_URL,
  AUTH_HEADER,
  USER_AGENT,
  PATHS,
  EVENT_REGISTRY,
  SUBSCRIPTION_RENEW_DAYS,
};
