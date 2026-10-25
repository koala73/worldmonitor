'use strict';

const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');
const { subscribe, unsubscribe, receive } = require('../lib/hooks');

const EVENT = EVENT_REGISTRY.events['country.risk_surge'];
const COUNTRY_NAMES = EVENT.countries;
const RULE = EVENT.threshold;

const readCountries = (bundle) => {
  const raw = bundle.inputData.countries;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  return [...new Set(list.map((code) => String(code).trim().toUpperCase()).filter(Boolean))];
};

const performSubscribe = (z, bundle) => subscribe(z, bundle, {
  eventType: EVENT.key,
  countries: readCountries(bundle),
});

const performUnsubscribe = (z, bundle) => unsubscribe(z, bundle);

const perform = (z, bundle) => receive(z, bundle, { eventType: EVENT.key });

// Sample rows: the monitored countries in scope with the largest 24-hour
// rise right now, shaped like a delivery. A country that already satisfies
// the rule is marked so; the editor still needs rows when nothing surges.
const performList = async (z, bundle) => {
  const scope = new Set(readCountries(bundle));
  const response = await z.request({ url: `${BASE_URL}${PATHS.riskScores}` });
  const data = response.data || {};
  const scores = Array.isArray(data.ciiScores) ? data.ciiScores : [];
  return scores
    .filter((cii) => cii && typeof cii.region === 'string' && (scope.size === 0 || scope.has(cii.region)))
    .sort((a, b) => (Number(b.dynamicScore) || 0) - (Number(a.dynamicScore) || 0))
    .slice(0, 5)
    .map((cii) => {
      const computedAt = Number.isFinite(cii.computedAt) ? cii.computedAt : Date.now();
      const triggeredAt = new Date(computedAt).toISOString();
      return {
        id: `sample:${cii.region}:${computedAt}`,
        eventType: EVENT.key,
        deliveryId: null,
        subscriberId: 'sample',
        countryCode: cii.region,
        countryName: COUNTRY_NAMES[cii.region] || cii.region,
        score: cii.combinedScore,
        previousScore: Number.isFinite(cii.combinedScore) && Number.isFinite(cii.dynamicScore)
          ? cii.combinedScore - cii.dynamicScore : null,
        delta24h: cii.dynamicScore,
        trend: cii.trend || 'TREND_DIRECTION_UNSPECIFIED',
        advisoryLevel: cii.advisoryLevel || null,
        triggeredAt,
        reason: 'risk_surge',
        details: {
          riseThreshold: RULE.riseThreshold,
          floor: RULE.floor,
          staticBaseline: Number.isFinite(cii.staticBaseline) ? cii.staticBaseline : null,
          components: cii.components || {},
          methodologyVersion: cii.methodologyVersion || '',
          computedAt,
          scoresFetchedAt: triggeredAt,
        },
      };
    });
};

module.exports = {
  key: 'country_risk_surge',
  noun: EVENT.noun,
  display: {
    label: 'New Country Risk Surge',
    description: EVENT.description.replace('riseThreshold', String(RULE.riseThreshold)),
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'countries',
        label: 'Countries',
        type: 'string',
        required: false,
        list: true,
        dynamic: 'country_list.id.name',
        helpText: `${EVENT.inputSchema.properties.countries.description} Leave empty to watch all ${Object.keys(COUNTRY_NAMES).length} monitored countries.`,
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: { id: 'whd_3c1b7f5e9d2a4c6e8f0b1d3a5c7e9f1b', eventType: EVENT.key, deliveryId: 'whd_3c1b7f5e9d2a4c6e8f0b1d3a5c7e9f1b', ...EVENT.sample },
    outputFields: [
      { key: 'id', label: 'Delivery ID' },
      { key: 'countryCode', label: 'Country Code' },
      { key: 'countryName', label: 'Country' },
      { key: 'score', label: 'Instability Index', type: 'integer' },
      { key: 'previousScore', label: 'Index 24h Earlier', type: 'integer' },
      { key: 'delta24h', label: '24h Rise', type: 'integer' },
      { key: 'trend', label: 'Trend' },
      { key: 'advisoryLevel', label: 'Travel Advisory Level' },
      { key: 'triggeredAt', label: 'Triggered At', type: 'datetime' },
      { key: 'reason', label: 'Reason' },
      { key: 'details__riseThreshold', label: 'Rise Threshold', type: 'integer' },
      { key: 'details__floor', label: 'Index Floor', type: 'integer' },
    ],
  },
};
