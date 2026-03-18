#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep, verifySeedKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:gdelt-intel:v1';
const CACHE_TTL = 21600; // 6h — cron runs every 2h; TTL must outlive maxStaleMin:300 to allow STALE warning before EMPTY/CRIT
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const INTER_TOPIC_DELAY_MS = 20_000; // 20s between topics to avoid 429

// 4 topics (down from 6 in prior fix #1817) to reduce GDELT 429 pressure on the 2h cron cycle.
// Dropped: sanctions (covered by market/economic data), intelligence (overlaps with military).
const INTEL_TOPICS = [
  { id: 'military',     query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng' },
  { id: 'cyber',        query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng' },
  { id: 'nuclear',      query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng' },
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
      if (!is429 || attempt === maxRetries) {
        // Non-429 error or exhausted retries: return empty rather than killing the whole seed
        console.warn(`    ${topic.id}: giving up after ${attempt + 1} attempts (${err.message})`);
        return { id: topic.id, articles: [], fetchedAt: new Date().toISOString() };
      }
      // Start backoff at 20s (GDELT needs longer cooldown than 10s)
      const backoff = 20_000 + attempt * 15_000;
      console.log(`    429 rate-limited, waiting ${backoff / 1000}s...`);
      await sleep(backoff);
    }
  }
}

async function fetchAllTopics() {
  const topics = [];
  for (let i = 0; i < INTEL_TOPICS.length; i++) {
    if (i > 0) await sleep(INTER_TOPIC_DELAY_MS);
    console.log(`  Fetching ${INTEL_TOPICS[i].id}...`);
    const result = await fetchWithRetry(INTEL_TOPICS[i]);
    console.log(`    ${result.articles.length} articles`);
    topics.push(result);
  }

  // For topics that returned 0 articles (rate-limited), preserve the previous
  // snapshot's articles rather than publishing empty results over good cached data.
  const emptyTopics = topics.filter((t) => t.articles.length === 0);
  if (emptyTopics.length > 0) {
    const previous = await verifySeedKey(CANONICAL_KEY).catch(() => null);
    if (previous && Array.isArray(previous.topics)) {
      const prevMap = new Map(previous.topics.map((t) => [t.id, t]));
      for (const topic of topics) {
        if (topic.articles.length === 0 && prevMap.has(topic.id)) {
          const prev = prevMap.get(topic.id);
          if (prev.articles?.length > 0) {
            console.log(`    ${topic.id}: rate-limited — using ${prev.articles.length} cached articles from previous snapshot`);
            topic.articles = prev.articles;
            topic.fetchedAt = prev.fetchedAt;
          }
        }
      }
    }
  }

  return { topics, fetchedAt: new Date().toISOString() };
}

function validate(data) {
  if (!Array.isArray(data?.topics) || data.topics.length === 0) return false;
  const populated = data.topics.filter((t) => Array.isArray(t.articles) && t.articles.length > 0);
  return populated.length >= 2; // safety net for first run or total outage; partial 429s are handled by per-topic merge above
}

runSeed('intelligence', 'gdelt-intel', CANONICAL_KEY, fetchAllTopics, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'gdelt-doc-v2',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
