'use strict';

const { createHash } = require('node:crypto');

const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');

const MAX_RESULTS = 25;
const CATEGORIES = EVENT_REGISTRY.events['news.breaking'].categories;
const VARIANTS = ['full', 'tech', 'finance', 'commodity', 'happy'];

// The digest API has no keyword parameter (list-feed-digest takes variant and
// lang only), so the match runs here over the headlines the digest returns.
const perform = async (z, bundle) => {
  const keyword = String(bundle.inputData.keyword || '').trim().toLowerCase();
  const category = String(bundle.inputData.category || '').trim();
  const variant = VARIANTS.includes(bundle.inputData.variant) ? bundle.inputData.variant : 'full';
  const response = await z.request({ url: `${BASE_URL}${PATHS.feedDigest}`, params: { variant } });
  const data = response.data || {};
  const items = Object.values(data.categories || {})
    .flatMap((bucket) => (bucket && Array.isArray(bucket.items) ? bucket.items : []))
    .filter((item) => item && typeof item.title === 'string' && item.title);
  const seen = new Set();
  return items
    .filter((item) => item.title.toLowerCase().includes(keyword))
    .filter((item) => !category || (item.threat && item.threat.category === category))
    .map((item) => ({
      id: item.link || createHash('sha256').update(item.title).digest('hex').slice(0, 32),
      title: item.title,
      link: item.link || null,
      source: item.source || '',
      publishedAt: Number.isFinite(item.publishedAt) && item.publishedAt > 0 ? new Date(item.publishedAt).toISOString() : null,
      importanceScore: Number.isFinite(item.importanceScore) ? item.importanceScore : 0,
      corroborationCount: Number.isFinite(item.corroborationCount) ? item.corroborationCount : 1,
      category: item.threat && item.threat.category ? item.threat.category : null,
      threatLevel: item.threat && item.threat.level ? item.threat.level : null,
      variant,
    }))
    .filter((row) => (seen.has(row.id) ? false : seen.add(row.id)))
    .sort((a, b) => b.importanceScore - a.importanceScore || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, MAX_RESULTS);
};

module.exports = {
  key: 'find_news',
  noun: 'Headline',
  display: {
    label: 'Find News by Keyword',
    description: 'Finds current WorldMonitor digest headlines containing a keyword, most important first.',
  },
  operation: {
    inputFields: [
      {
        key: 'keyword',
        label: 'Keyword',
        type: 'string',
        required: true,
        helpText: 'Case-insensitive text to look for in the headline, such as Hormuz or semiconductor.',
      },
      {
        key: 'category',
        label: 'Category',
        type: 'string',
        required: false,
        choices: Object.fromEntries(CATEGORIES.map((c) => [c, c])),
        helpText: 'Only headlines the classifier put in this category.',
      },
      {
        key: 'variant',
        label: 'Feed Variant',
        type: 'string',
        required: false,
        default: 'full',
        choices: Object.fromEntries(VARIANTS.map((v) => [v, v])),
        helpText: 'Which WorldMonitor digest to search: full (geopolitics, default), tech, finance, commodity or happy.',
      },
    ],
    perform,
    sample: {
      id: 'https://www.rferl.org/a/iran-guards-tankers-mines-hormuz/33560001.html',
      title: 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz',
      link: 'https://www.rferl.org/a/iran-guards-tankers-mines-hormuz/33560001.html',
      source: 'RFE/RL',
      publishedAt: '2026-10-17T18:31:00.000Z',
      importanceScore: 88,
      corroborationCount: 3,
      category: 'conflict',
      threatLevel: 'THREAT_LEVEL_CRITICAL',
      variant: 'full',
    },
  },
};
