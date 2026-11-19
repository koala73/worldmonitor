#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getRedisCredentials, loadEnvFile, redisCommand, withRetry, SEED_REDIS_RETRY_ATTEMPTS } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { listRankableCountries } from './shared/rankable-universe.mjs';

const DAY = 86400000;
const COUNTRY_NAMES = JSON.parse(readFileSync(new URL('./shared/country-names.json', import.meta.url), 'utf8'));
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
const fresh = (time, now, age) => Number.isFinite(time) && time > 0 && time <= now && now - time <= age;
const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const words = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function composeCountrySnapshots({ countries, risk, ranking, digest, now }) {
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
  const events = Object.entries(digest.categories).flatMap(([category, bucket]) => {
    if (!Array.isArray(bucket?.items)) throw new Error('country history malformed news bucket');
    return bucket.items.map(item => ({ ...item, category }));
  }).filter(item => typeof item.title === 'string' && item.title && typeof item.source === 'string' && item.source
    && typeof item.link === 'string' && /^https?:\/\//i.test(item.link)
    && fresh(item.publishedAt, now, DAY))
    .sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0) || b.publishedAt - a.publishedAt);
  return countries.map(countryCode => {
    const cii = scores.get(countryCode);
    const res = resilience.get(countryCode);
    const names = [...Object.entries(COUNTRY_NAMES).filter(([name, code]) => code === countryCode && !AMBIGUOUS_HEADLINE_NAMES.has(name)).map(([name]) => name),
      ...(QUALIFIED_HEADLINE_NAMES[countryCode] ?? [])].map(name => ` ${words(name)} `);
    const exclusions = Object.entries(COUNTRY_NAMES)
      .filter(([name, code]) => code !== countryCode && names.some(alias => ` ${words(name)} `.includes(alias)))
      .map(([name]) => words(name));
    const seen = new Set();
    const topEvents = events.filter(item => {
      let title = ` ${words(item.title)} `;
      for (const phrase of exclusions) title = title.split(phrase).join(' ');
      if (seen.has(item.link) || !names.some(name => title.includes(name))) return false;
      seen.add(item.link);
      return true;
    }).slice(0, 5).filter(item => item.link.length <= 1024).map(item => ({ title: item.title.slice(0, 300), link: item.link, source: item.source.slice(0, 100), category: item.category.slice(0, 100) }));
    return {
      countryCode, date: new Date(now).toISOString().slice(0, 10), capturedAt: now,
      ...(cii ? { cii: { score: cii.combinedScore, version: cii.methodologyVersion, observedAt: cii.computedAt } } : {}),
      ...(res && validScore(res.overallScore) ? { resilience: { score: res.overallScore, version: ranking._scoreCacheIdentity, observedAt: rankingAt } } : {}),
      topEvents,
      keySignals: [!cii && 'cii_unavailable', (!res || !validScore(res.overallScore)) && 'resilience_unavailable', digest.coverage.state === 'partial' && 'news_partial'].filter(Boolean),
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
  const now = Date.now();
  const snapshots = composeCountrySnapshots({ countries: listRankableCountries(), risk, ranking, digest, now });
  await publishCountrySnapshots(url, token, snapshots, now);
  console.log(`[country-history] published=${snapshots.length} date=${snapshots[0].date}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const startedAt = Date.now();
  main().then(() => console.log(`=== Done (${Date.now() - startedAt}ms) ===`))
    .catch(error => { console.error('[country-history]', error.message); process.exitCode = 1; });
}
