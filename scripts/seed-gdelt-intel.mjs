#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:gdelt-intel:v1';
const CACHE_TTL = 3600;
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';

const INTEL_TOPICS = [
  { id: 'military',     query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng' },
  { id: 'cyber',        query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng' },
  { id: 'nuclear',      query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng' },
  { id: 'sanctions',    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng' },
  { id: 'intelligence', query: '(espionage OR spy OR intelligence agency OR covert OR surveillance) sourcelang:eng' },
  { id: 'maritime',     query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng' },
];

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function normalizeArticle(raw) {
  const url = raw.url || '';
  if (!isValidUrl(url)) return null;
  return {
    title: String(raw.title || '').slice(0, 500),
    url,
    source: String(raw.domain || raw.source?.domain || '').slice(0, 200),
    date: String(raw.seendate || ''),
    image: isValidUrl(raw.socialimage || '') ? raw.socialimage : '',
    language: String(raw.language || ''),
    tone: typeof raw.tone === 'number' ? raw.tone : 0,
  };
}

async function fetchTopicArticles(topic) {
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '10');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) throw new Error(`GDELT ${topic.id}: HTTP ${resp.status}`);

  const data = await resp.json();
  const articles = (data.articles || [])
    .map(normalizeArticle)
    .filter(Boolean);

  return {
    id: topic.id,
    articles,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchWithRetry(topic, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchTopicArticles(topic);
    } catch (err) {
      const is429 = err.message?.includes('429');
      if (!is429 || attempt === maxRetries) throw err;
      const backoff = (attempt + 1) * 10_000;
      console.log(`    429 rate-limited, waiting ${backoff / 1000}s...`);
      await sleep(backoff);
    }
  }
}

async function fetchAllTopics() {
  const topics = [];
  for (let i = 0; i < INTEL_TOPICS.length; i++) {
    if (i > 0) await sleep(12_000);
    console.log(`  Fetching ${INTEL_TOPICS[i].id}...`);
    const result = await fetchWithRetry(INTEL_TOPICS[i]);
    console.log(`    ${result.articles.length} articles`);
    topics.push(result);
  }
  return { topics, fetchedAt: new Date().toISOString() };
}

function validate(data) {
  if (!Array.isArray(data?.topics) || data.topics.length !== INTEL_TOPICS.length) return false;
  const military = data.topics.find((t) => t.id === 'military');
  return military && Array.isArray(military.articles) && military.articles.length > 0;
}

runSeed('intelligence', 'gdelt-intel', CANONICAL_KEY, fetchAllTopics, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'gdelt-doc-v2',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
