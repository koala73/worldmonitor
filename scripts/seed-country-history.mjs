#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getRedisCredentials, loadEnvFile, redisCommand, withRetry, SEED_REDIS_RETRY_ATTEMPTS } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { listRankableCountries } from './shared/rankable-universe.mjs';
import { countryMentionTerms, mentionsCountry, normalizeMentionText } from './shared/country-mention.js';
import { isVerifiableArticleUrl } from './shared/article-url.js';
import { publisherFamilyFor } from './shared/publisher-families.js';

const DAY = 86400000;
const HEADLINE_LIMIT = 5;
const COUNTRY_NAMES = JSON.parse(readFileSync(new URL('./shared/country-names.json', import.meta.url), 'utf8'));
const NEWS_CATALOG = JSON.parse(readFileSync(new URL('./shared/news-catalog.json', import.meta.url), 'utf8'));
const AMBIGUOUS_HEADLINE_NAMES = new Set(['georgia', 'jordan', 'chad', 'turkey', 'guinea', 'congo', 'republic of the congo']);
const QUALIFIED_HEADLINE_NAMES = {
  GE: ['country of georgia', 'republic of georgia'],
  JO: ['kingdom of jordan'],
  TD: ['republic of chad'],
  TR: ['republic of turkey'],
  GN: ['guinea conakry'],
};
const RISK_KEY = 'risk:scores:sebuf:stale:v14';
const RANKING_KEY = 'resilience:ranking:v29';
const DIGEST_KEY = 'news:digest:v1:full:en';
// The per-feed caches the digest builder writes (server/worldmonitor/news/v1/_rss-cache.ts).
const FEED_KEY_PREFIX = 'rss:feed:v11:full:';
const FEED_COUNTRY_KEY_PREFIX = 'rss:feed-country:v1:full:';
const REVOKED_URLS_KEY = 'news:digest:revoked-urls:v1';
const FEED_READ_BATCH = 100;
const FUTURE_TOLERANCE = 3600000;
const fresh = (time, now, age) => Number.isFinite(time) && time > 0 && time <= now && now - time <= age;
const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const storableLink = link => typeof link === 'string' && link.length <= 1024 && isVerifiableArticleUrl(link);

/**
 * The feeds whose cached rows the country headline RPC reads
 * (server/worldmonitor/news/v1/list-country-headlines.ts): every full-edition
 * and intel feed an English build fetches. Each carries the digest category it
 * is placed in, so a pool headline keeps a category like a digest headline.
 */
export function countryHistoryFeeds(catalog = NEWS_CATALOG) {
  const fullCategories = new Set(catalog.layout.server.full);
  const reachable = feed => !feed.lang || feed.lang === 'en' || !!feed.strategicDefault || !!feed.fetchInAllLanguages;
  const feeds = [];
  for (const feed of catalog.feeds) {
    if (typeof feed.url !== 'string' || !reachable(feed)) continue;
    const placement = feed.placements.find(item => item.serverOrder !== undefined
      && ((item.edition === 'full' && fullCategories.has(item.category)) || (item.edition === 'intel' && item.category === 'intel')));
    if (placement) feeds.push({ name: feed.name, url: feed.url, category: placement.category });
  }
  return feeds;
}

/** A feed's digest rows plus its retained country rows from the same parse. */
function feedRows(entry, countryEntry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.items)) return null;
  if (Array.isArray(entry.countryItems)) return [...entry.items, ...entry.countryItems];
  if (typeof entry.parsedAt === 'number' && countryEntry && countryEntry.parsedAt === entry.parsedAt && Array.isArray(countryEntry.items)) {
    return [...entry.items, ...countryEntry.items];
  }
  return entry.items;
}

/** Shapes one cached feed row the way the country headline RPC does, or null. */
function poolHeadline(row, feed) {
  if (!row || typeof row !== 'object' || row.source !== feed.name || typeof row.title !== 'string' || typeof row.link !== 'string') return null;
  const source = row.originPublisherTrusted === true ? (typeof row.originPublisher === 'string' ? row.originPublisher.trim() : '') : feed.name;
  const title = row.title.replace(/\s+/g, ' ').trim();
  if (!source || !title || title.includes('**')) return null;
  return { title, link: row.link, source, category: feed.category, publishedAt: row.publishedAt };
}

export async function readFeedPool(url, token, command = redisCommand, feeds = countryHistoryFeeds()) {
  const items = [];
  let feedsCached = 0;
  for (let index = 0; index < feeds.length; index += FEED_READ_BATCH) {
    const batch = feeds.slice(index, index + FEED_READ_BATCH);
    const keys = [...batch.map(feed => FEED_KEY_PREFIX + feed.url), ...batch.map(feed => FEED_COUNTRY_KEY_PREFIX + feed.url)];
    const { result } = await withRetry(() => command(url, token, ['MGET', ...keys]), SEED_REDIS_RETRY_ATTEMPTS - 1);
    if (!Array.isArray(result) || result.length !== keys.length) throw new Error('country history feed pool read failed');
    batch.forEach((feed, offset) => {
      const parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
      const rows = feedRows(parse(result[offset]), parse(result[offset + batch.length]));
      if (!rows) return;
      feedsCached++;
      for (const row of rows) {
        const item = poolHeadline(row, feed);
        if (item) items.push(item);
      }
    });
  }
  return { feedsTotal: feeds.length, feedsCached, items };
}

/**
 * Country matching for the archive: the shared country-mention rules (names,
 * case-sensitive demonyms, exclusions such as "Northern Ireland"), with the
 * archive's own alias table and its stricter rule that ambiguous bare names
 * ("Jordan", "Georgia", "Turkey") need a qualifying phrase.
 */
function countryMatcher(countryCode) {
  const shared = countryMentionTerms(countryCode);
  const names = [...new Set([
    ...Object.entries(COUNTRY_NAMES).filter(([, code]) => code === countryCode).map(([name]) => name),
    ...shared.names,
    ...(QUALIFIED_HEADLINE_NAMES[countryCode] ?? []),
  ].map(normalizeMentionText).filter(name => name && !AMBIGUOUS_HEADLINE_NAMES.has(name)))];
  const exclusions = [...new Set([
    ...shared.exclusions.map(normalizeMentionText),
    ...Object.entries(COUNTRY_NAMES)
      .filter(([name, code]) => code !== countryCode && names.some(alias => ` ${normalizeMentionText(name)} `.includes(` ${alias} `)))
      .map(([name]) => normalizeMentionText(name)),
  ])];
  const terms = { code: countryCode, names, demonyms: shared.demonyms, exclusions };
  const tokens = [...shared.demonyms, ...(countryCode === 'US' ? ['US'] : [])];
  // Cheap substring prefilter before the regex match: ~18k titles x ~200 countries.
  return item => (names.some(name => item.normalized.includes(name)) || tokens.some(token => item.title.includes(token)))
    && mentionsCountry(item.title, terms);
}

export function composeCountrySnapshots({ countries, risk, ranking, digest, pool = null, revoked = new Set(), now }) {
  if (!Array.isArray(risk?.ciiScores) || !risk.ciiScores.length || risk.stale || risk.degraded
    || !risk.ciiScores.every(row => validScore(row.combinedScore) && typeof row.methodologyVersion === 'string' && row.methodologyVersion
      && fresh(row.computedAt, now, 30 * 60000))) throw new Error('country history CII source unavailable');
  const rankingAt = Date.parse(ranking?.fetchedAt);
  if (!Array.isArray(ranking?.items) || !Array.isArray(ranking?.greyedOut) || ranking.partial
    || !ranking.items.length || typeof ranking._scoreCacheIdentity !== 'string' || !ranking._scoreCacheIdentity
    || !fresh(rankingAt, now, 12 * 3600000)) throw new Error('country history resilience source unavailable');
  if (!digest?.categories || !['complete', 'partial'].includes(digest.coverage?.state)
    || !fresh(Date.parse(digest.generatedAt), now, 30 * 60000)) throw new Error('country history news source unavailable');
  const scores = new Map(risk.ciiScores.map(row => [row.region, row]));
  const resilience = new Map([...ranking.items, ...ranking.greyedOut].map(row => [row.countryCode, row]));
  const usable = item => typeof item.title === 'string' && item.title && typeof item.source === 'string' && item.source
    && typeof item.category === 'string' && storableLink(item.link)
    && Number.isFinite(item.publishedAt) && item.publishedAt > 0 && item.publishedAt >= now - DAY && item.publishedAt <= now + FUTURE_TOLERANCE;
  // As in the country headline RPC: a revocation may name the raw or the normalized
  // spelling, and the archive stores the normalized one.
  const normalizeLink = item => {
    const url = URL.parse(item.link);
    if (!url || url.username || url.password || revoked.has(item.link) || revoked.has(url.href) || !storableLink(url.href)) return null;
    return { ...item, link: url.href };
  };
  const prepare = item => ({ ...item, normalized: normalizeMentionText(item.title) });
  // The digest is the editorially ranked front page, so its headlines lead.
  const digestEvents = Object.entries(digest.categories).flatMap(([category, bucket]) => {
    if (!Array.isArray(bucket?.items)) throw new Error('country history malformed news bucket');
    return bucket.items.map(item => ({ ...item, category }));
  }).filter(usable).map(normalizeLink).filter(Boolean)
    .sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0) || b.publishedAt - a.publishedAt)
    .map(prepare);
  // The feed pool holds every headline the feeds published, newest first.
  const poolEvents = (pool?.items ?? []).filter(usable).map(normalizeLink).filter(Boolean)
    .sort((a, b) => b.publishedAt - a.publishedAt || a.link.localeCompare(b.link))
    .map(prepare);
  const newsPartial = digest.coverage.state === 'partial' || !pool || pool.feedsCached === 0;
  return countries.map(countryCode => {
    const cii = scores.get(countryCode);
    const res = resilience.get(countryCode);
    const matches = countryMatcher(countryCode);
    const seen = new Set();
    const take = item => {
      if (seen.has(item.link) || !matches(item)) return false;
      seen.add(item.link);
      return true;
    };
    const fromDigest = digestEvents.filter(take);
    // Pool headlines from publishers not yet chosen come before repeats, as in the country panel.
    const families = new Set(fromDigest.map(item => publisherFamilyFor(item.source)));
    const first = [];
    const rest = [];
    for (const item of poolEvents) {
      if (fromDigest.length + first.length >= HEADLINE_LIMIT) break;
      if (!take(item)) continue;
      const family = publisherFamilyFor(item.source);
      if (families.has(family)) rest.push(item);
      else {
        families.add(family);
        first.push(item);
      }
    }
    const topEvents = [...fromDigest, ...first, ...rest].slice(0, HEADLINE_LIMIT)
      .map(item => ({ title: item.title.slice(0, 300), link: item.link, source: item.source.slice(0, 100), category: item.category.slice(0, 100) }));
    return {
      countryCode, date: new Date(now).toISOString().slice(0, 10), capturedAt: now,
      ...(cii ? { cii: { score: cii.combinedScore, version: cii.methodologyVersion, observedAt: cii.computedAt } } : {}),
      ...(res && validScore(res.overallScore) ? { resilience: { score: res.overallScore, version: ranking._scoreCacheIdentity, observedAt: rankingAt } } : {}),
      topEvents,
      keySignals: [!cii && 'cii_unavailable', (!res || !validScore(res.overallScore)) && 'resilience_unavailable', newsPartial && 'news_partial'].filter(Boolean),
    };
  });
}

export const COUNTRY_HISTORY_WRITE_LUA = `
local count = #KEYS - 3
local day = tonumber(ARGV[1])
local captured = tonumber(ARGV[2])
for i, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local expected = i <= count and 'zset' or 'string'
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('country_history_wrong_type') end
end
local previous = redis.call('GET', KEYS[count + 2])
if previous and tonumber(cjson.decode(previous).fetchedAt) > captured then return 0 end
for i = 1, count do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], day, day)
  redis.call('ZADD', KEYS[i], day, ARGV[4 + i])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', day - 365)
  redis.call('EXPIRE', KEYS[i], 34560000)
end
redis.call('SET', KEYS[count + 1], ARGV[3], 'EX', 34560000)
redis.call('SET', KEYS[count + 2], ARGV[4], 'EX', 34646400)
redis.call('SET', KEYS[count + 3], captured)
return count
`;

export async function publishCountrySnapshots(url, token, snapshots, now, command = redisCommand) {
  if (!snapshots.length) throw new Error('country history cannot publish an empty universe');
  const keys = [...snapshots.map(row => `history:country:${row.countryCode}`), 'history:country:index', 'seed-meta:history:country', 'seed-activated:history:country'];
  const result = await withRetry(() => command(url, token, ['EVAL', COUNTRY_HISTORY_WRITE_LUA, keys.length, ...keys,
    Math.floor(now / DAY), now,
    JSON.stringify({ date: new Date(now).toISOString().slice(0, 10), countries: snapshots.map(row => row.countryCode) }),
    JSON.stringify({ fetchedAt: now, recordCount: snapshots.length }), ...snapshots.map(row => JSON.stringify(row)),
  ]), SEED_REDIS_RETRY_ATTEMPTS - 1);
  if (result.result !== snapshots.length) throw new Error('country history publication unconfirmed');
}

async function main() {
  loadEnvFile(import.meta.url);
  const { url, token } = getRedisCredentials();
  if (!url || !token) throw new Error('Redis credentials are required');
  const { result } = await withRetry(() => redisCommand(url, token, ['MGET', RISK_KEY, RANKING_KEY, DIGEST_KEY]), SEED_REDIS_RETRY_ATTEMPTS - 1);
  if (!Array.isArray(result) || result.length !== 3) throw new Error('country history input read failed');
  const [risk, ranking, digest] = result.map(raw => unwrapEnvelope(raw).data);
  // The archive keeps links for a year, so an unreadable revocation set fails the run.
  const revokedRead = await withRetry(() => redisCommand(url, token, ['SMEMBERS', REVOKED_URLS_KEY]), SEED_REDIS_RETRY_ATTEMPTS - 1);
  if (!Array.isArray(revokedRead.result)) throw new Error('country history revocation read failed');
  const pool = await readFeedPool(url, token);
  const now = Date.now();
  const snapshots = composeCountrySnapshots({ countries: listRankableCountries(), risk, ranking, digest, pool, revoked: new Set(revokedRead.result), now });
  await publishCountrySnapshots(url, token, snapshots, now);
  const withHeadlines = snapshots.filter(row => row.topEvents.length).length;
  console.log(`[country-history] published=${snapshots.length} date=${snapshots[0].date} withHeadlines=${withHeadlines} feeds=${pool.feedsCached}/${pool.feedsTotal} poolRows=${pool.items.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const startedAt = Date.now();
  main().then(() => console.log(`=== Done (${Date.now() - startedAt}ms) ===`))
    .catch(error => { console.error('[country-history]', error.message); process.exitCode = 1; });
}
