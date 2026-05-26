#!/usr/bin/env node

import { loadEnvFile, runSeed, sleep, verifySeedKey, writeExtraKey, extendExistingTtl } from './_seed-utils.mjs';
import { fetchGdeltJson } from './_gdelt-fetch.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:gdelt-intel:v1';
const CACHE_TTL = 86400; // 24h — intentionally much longer than the 2h cron so verifySeedKey always has a prior snapshot to merge from when GDELT 429s all topics
const TIMELINE_TTL = 43200; // 12h = 2× cron interval; tone/vol must survive until next 6h run
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const INTER_TOPIC_DELAY_MS = 20_000; // 20s between topics on success
const POST_EXHAUST_DELAY_MS = 120_000; // 2min extra cooldown after a topic exhausts all retries

const INTEL_TOPICS = [
  { id: 'military',     query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng' },
  { id: 'cyber',        query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng' },
  { id: 'nuclear',      query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng' },
  { id: 'sanctions',    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng' },
  { id: 'intelligence', query: '(espionage OR spy OR "intelligence agency" OR covert OR surveillance) sourcelang:eng' },
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

  // fetchGdeltJson does direct retry + curl proxy multi-retry internally.
  // Throws on exhaustion with HTTP 429 in message — outer fetchWithRetry's
  // is429 substring match still works against the new error format.
  const data = await fetchGdeltJson(url.toString(), { label: topic.id });
  const articles = (data.articles || [])
    .map(normalizeArticle)
    .filter(Boolean);

  return {
    id: topic.id,
    articles,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeTimeline(data, mode) {
  const raw = data?.timeline ?? data?.data ?? [];
  return raw.map((pt) => ({
    date: String(pt.date || pt.datetime || ''),
    value: typeof pt.value === 'number' ? pt.value : (typeof pt[mode] === 'number' ? pt[mode] : 0),
  })).filter((pt) => pt.date);
}

async function fetchTopicTimeline(topic, mode) {
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', mode);
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', '14d');

  try {
    // Best-effort: timelines degrade silently to [] on any failure.
    // Pre-helper code did a single direct fetch with no retry. The
    // article-fetch defaults (3 direct retries + 5 proxy attempts ≈ 90s)
    // are too aggressive for discarded-on-failure data — would burn up to
    // ~18 min/seed-run across 12 timeline calls under GDELT 429 storms.
    //
    // Compromise: 1 direct + 2 proxy (Decodo session rotation) attempts.
    // Worst case ~25s per call × 12 = ~5 min ceiling. Gives timelines a
    // realistic chance to succeed via proxy without blocking the seeder
    // for the full article-fetch budget.
    const data = await fetchGdeltJson(url.toString(), {
      label: `${topic.id}/${mode}`,
      maxRetries: 0,
      proxyMaxAttempts: 2,
    });
    return normalizeTimeline(data, mode === 'TimelineTone' ? 'tone' : 'value');
  } catch {
    return [];
  }
}

async function fetchWithRetry(topic) {
  // Pre-helper: this function did 3 outer retries with 60/120/240s backoff
  // on top of fetchTopicArticles. Now fetchGdeltJson handles ALL retry +
  // proxy multi-retry internally (3 direct retries + 5 curl proxy attempts
  // per call), so the outer loop is gone. This function's only remaining
  // job is to translate thrown exhaustion into the {exhausted, articles:[]}
  // shape that fetchAllTopics expects (used to drive POST_EXHAUST_DELAY_MS
  // cooldown decisions).
  try {
    return await fetchTopicArticles(topic);
  } catch (err) {
    // Helper's exhausted-throw includes "HTTP 429" in the message when
    // 429 was the upstream signal — substring match preserved.
    const is429 = err.message?.includes('429');
    console.warn(`    ${topic.id}: giving up (${err.message})`);
    return { id: topic.id, articles: [], fetchedAt: new Date().toISOString(), exhausted: is429 };
  }
}

async function fetchAllTopics() {
  const topics = [];
  for (let i = 0; i < INTEL_TOPICS.length; i++) {
    if (i > 0) await sleep(INTER_TOPIC_DELAY_MS);
    console.log(`  Fetching ${INTEL_TOPICS[i].id}...`);
    const result = await fetchWithRetry(INTEL_TOPICS[i]);
    console.log(`    ${result.articles.length} articles`);
    // Fetch tone/vol timelines in parallel — best-effort, 429s silently return []
    const [tone, vol] = await Promise.all([
      fetchTopicTimeline(INTEL_TOPICS[i], 'TimelineTone'),
      fetchTopicTimeline(INTEL_TOPICS[i], 'TimelineVol'),
    ]);
    result._tone = tone;
    result._vol = vol;
    console.log(`    timeline: ${tone.length} tone pts, ${vol.length} vol pts`);
    topics.push(result);
    // After a topic exhausts all retries, give GDELT a longer cooldown before hitting
    // it again with the next topic — the rate limit window for popular queries exceeds 50s
    if (result.exhausted && i < INTEL_TOPICS.length - 1) {
      console.log(`    Rate-limit cooldown: waiting ${POST_EXHAUST_DELAY_MS / 1000}s before next topic...`);
      await sleep(POST_EXHAUST_DELAY_MS);
    }
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
  return populated.length >= 3; // at least 3 of 6 topics must have articles; partial 429s handled by per-topic merge above
}

// Strip private fields (_tone, _vol, exhausted) before writing to the canonical Redis key.
function publishTransform(data) {
  return {
    ...data,
    topics: (data.topics ?? []).map(({ _tone: _t, _vol: _v, exhausted: _e, ...rest }) => rest),
  };
}

// Write per-topic tone/vol timeline keys (TIMELINE_TTL, separate from the
// 24h canonical key). When GDELT rate-limits a topic's TimelineTone/Vol
// sub-fetch, _tone / _vol arrive empty for that topic — rather than let
// the existing Redis key silently expire mid-cycle, extend its TTL with
// EXPIRE so downstream consumers (cross-source-signals, etc.) keep seeing
// the last successful snapshot until the next cron cycle refreshes it.
async function afterPublish(data, _meta) {
  const toneKeysToExtend = [];
  const volKeysToExtend = [];
  for (const topic of data.topics ?? []) {
    const fetchedAt = topic.fetchedAt ?? data.fetchedAt;
    const toneKey = `gdelt:intel:tone:${topic.id}`;
    const volKey = `gdelt:intel:vol:${topic.id}`;

    if (Array.isArray(topic._tone) && topic._tone.length > 0) {
      await writeExtraKey(toneKey, { data: topic._tone, fetchedAt }, TIMELINE_TTL);
    } else {
      toneKeysToExtend.push(toneKey);
    }
    if (Array.isArray(topic._vol) && topic._vol.length > 0) {
      await writeExtraKey(volKey, { data: topic._vol, fetchedAt }, TIMELINE_TTL);
    } else {
      volKeysToExtend.push(volKey);
    }
  }
  if (toneKeysToExtend.length > 0) {
    console.log(`  Extending tone TTL for ${toneKeysToExtend.length} rate-limited topic(s): ${toneKeysToExtend.map((k) => k.split(':').pop()).join(', ')}`);
    await extendExistingTtl(toneKeysToExtend, TIMELINE_TTL);
  }
  if (volKeysToExtend.length > 0) {
    console.log(`  Extending vol TTL for ${volKeysToExtend.length} rate-limited topic(s): ${volKeysToExtend.map((k) => k.split(':').pop()).join(', ')}`);
    await extendExistingTtl(volKeysToExtend, TIMELINE_TTL);
  }
}

export function declareRecords(data) {
  return Array.isArray(data?.topics) ? data.topics.length : 0;
}

if (process.argv[1]?.endsWith('seed-gdelt-intel.mjs')) {
  runSeed('intelligence', 'gdelt-intel', CANONICAL_KEY, fetchAllTopics, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'gdelt-doc-v2',
    publishTransform,
    afterPublish,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 420,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
