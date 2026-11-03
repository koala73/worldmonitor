'use strict';

const { createHash } = require('node:crypto');

const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');
const { subscribe, unsubscribe, receive, toInteger, readList, scopeFromInputs } = require('../lib/hooks');

const EVENT = EVENT_REGISTRY.events['news.breaking'];
const INPUT = EVENT.inputSchema.properties;
const CATEGORY_CHOICES = Object.fromEntries(EVENT.categories.map((category) => [category, category]));
const SEVERITY_CHOICES = Object.fromEntries(INPUT.severityFloor.enum.map((level) => [level, level]));
const SAMPLE_ROWS = 10;

const readInputs = (bundle) => ({
  keywords: readList(bundle.inputData.keywords).map((keyword) => keyword.toLowerCase()),
  categories: readList(bundle.inputData.categories),
  countries: readList(bundle.inputData.countries).map((code) => code.toUpperCase()),
  importanceFloor: toInteger(bundle.inputData.importance_floor, INPUT.importanceFloor.default),
  severityFloor: String(bundle.inputData.severity_floor || INPUT.severityFloor.default),
});

const performSubscribe = (z, bundle) => subscribe(z, bundle, {
  eventType: EVENT.key,
  scope: scopeFromInputs(readInputs(bundle)),
});

const performUnsubscribe = (z, bundle) => unsubscribe(z, bundle);

const perform = (z, bundle) => receive(z, bundle, { eventType: EVENT.key });

// Same rule as the delivery worker (keywordMatches): whole word, case-insensitive.
function matchedKeywords(title, keywords) {
  return keywords.filter((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(title);
  });
}

function severityOf(item) {
  const level = item.threat && item.threat.level;
  return level === 'THREAT_LEVEL_CRITICAL' ? 'critical' : 'high';
}

function rowId(item) {
  const material = item.link || item.title || '';
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

// Sample rows for the Zap editor: the digest's most important current
// headlines, shaped exactly like a delivery. The digest carries no country
// attribution, so countryCodes is empty in samples; the scope's keyword and
// category filters are applied when they leave anything, otherwise the top
// headlines are shown so the editor always has rows to map.
const performList = async (z, bundle) => {
  const { keywords, categories, importanceFloor, severityFloor } = readInputs(bundle);
  const response = await z.request({ url: `${BASE_URL}${PATHS.feedDigest}`, params: { variant: 'full' } });
  const data = response.data || {};
  const generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : new Date().toISOString();
  const items = Object.values(data.categories || {})
    .flatMap((bucket) => (bucket && Array.isArray(bucket.items) ? bucket.items : []))
    .filter((item) => item && typeof item.title === 'string' && item.title);
  const shape = (item) => {
    const publishedAt = Number.isFinite(item.publishedAt) && item.publishedAt > 0 ? new Date(item.publishedAt).toISOString() : generatedAt;
    return {
      id: `sample:${rowId(item)}:${generatedAt}`,
      eventType: EVENT.key,
      deliveryId: null,
      subscriberId: 'sample',
      eventId: `rss_${rowId(item)}`,
      title: item.title,
      source: item.source || '',
      link: item.link || null,
      publishedAt,
      severity: severityOf(item),
      importanceScore: Number.isFinite(item.importanceScore) ? item.importanceScore : 0,
      corroborationCount: Number.isFinite(item.corroborationCount) && item.corroborationCount >= 1 ? item.corroborationCount : 1,
      category: item.threat && item.threat.category ? item.threat.category : null,
      countryCodes: [],
      variant: 'full',
      matchedKeywords: matchedKeywords(item.title, keywords),
      triggeredAt: generatedAt,
      reason: 'breaking_news',
    };
  };
  const ranked = items
    .map(shape)
    .filter((row) => row.importanceScore >= importanceFloor && (severityFloor !== 'critical' || row.severity === 'critical'))
    .sort((a, b) => b.importanceScore - a.importanceScore || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const scoped = ranked.filter((row) =>
    (!keywords.length || row.matchedKeywords.length > 0)
    && (!categories.length || (row.category && categories.includes(row.category))));
  const seen = new Set();
  return (scoped.length ? scoped : ranked)
    .filter((row) => (seen.has(row.id) ? false : seen.add(row.id)))
    .slice(0, SAMPLE_ROWS);
};

module.exports = {
  key: 'news_breaking',
  noun: EVENT.noun,
  display: {
    label: 'New Breaking News Alert',
    description: EVENT.description,
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'keywords',
        label: 'Keywords',
        type: 'string',
        required: false,
        list: true,
        helpText: `${INPUT.keywords.description} Whole words, so "tank" does not match "tankers". Up to ${INPUT.keywords.maxItems}.`,
      },
      {
        key: 'categories',
        label: 'Categories',
        type: 'string',
        required: false,
        list: true,
        choices: CATEGORY_CHOICES,
        helpText: INPUT.categories.description,
      },
      {
        key: 'countries',
        label: 'Countries',
        type: 'string',
        required: false,
        list: true,
        helpText: `${INPUT.countries.description} Codes such as IR or UA.`,
      },
      {
        key: 'importance_floor',
        label: 'Minimum Importance Score',
        type: 'integer',
        required: false,
        default: String(INPUT.importanceFloor.default),
        helpText: INPUT.importanceFloor.description,
      },
      {
        key: 'severity_floor',
        label: 'Minimum Severity',
        type: 'string',
        required: false,
        choices: SEVERITY_CHOICES,
        default: INPUT.severityFloor.default,
        helpText: `${INPUT.severityFloor.description} Each Zap receives at most ${EVENT.volume.maxDeliveriesPerHour} alerts an hour and ${EVENT.volume.maxDeliveriesPerDay} a day; add keywords, categories or countries to stay well under that.`,
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: { id: 'whd_5e2c8a1f7b9d4c3e6a0f1b2d3c4e5f60', eventType: EVENT.key, deliveryId: 'whd_5e2c8a1f7b9d4c3e6a0f1b2d3c4e5f60', ...EVENT.sample },
    outputFields: [
      { key: 'id', label: 'Delivery ID' },
      { key: 'eventId', label: 'Story ID' },
      { key: 'title', label: 'Headline' },
      { key: 'source', label: 'Source' },
      { key: 'link', label: 'Link' },
      { key: 'publishedAt', label: 'Published At', type: 'datetime' },
      { key: 'severity', label: 'Severity' },
      { key: 'importanceScore', label: 'Importance Score', type: 'number' },
      { key: 'corroborationCount', label: 'Corroborating Publishers', type: 'integer' },
      { key: 'category', label: 'Category' },
      { key: 'countryCodes', label: 'Country Codes', list: true },
      { key: 'variant', label: 'Feed Variant' },
      { key: 'matchedKeywords', label: 'Matched Keywords', list: true },
      { key: 'triggeredAt', label: 'Triggered At', type: 'datetime' },
      { key: 'reason', label: 'Reason' },
    ],
  },
};
