import { EMBED_MODEL } from './brief-dedup-consts.mjs';

export const HISTORY_COST_TIMEOUT_MS = 2000;
export const HISTORY_COST_RETENTION_DAYS = 200;

export const HISTORY_COST_FIELDS = [
  'runs', 'failedRuns', 'inputTexts', 'uniqueTexts', 'cacheHitTexts',
  'providerInputs', 'providerRequests', 'knownCostUsd', 'unknownCostRequests',
  'knownPromptTokens', 'unknownTokenRequests', 'unknownEmbeddingRuns',
  'inserted', 'deduped', 'retracted', 'failedChunks', 'abandoned',
];

export function historyCostKey(domain, resource, day, model = EMBED_MODEL) {
  return `intel-history:cost:v1:${[domain, resource, model, day].map(encodeURIComponent).join(':')}`;
}

export const HISTORY_COST_UPDATE_SCRIPT = `
local increments = cjson.decode(ARGV[1])
local totals = {}
local first = tonumber(redis.call('HGET', KEYS[1], 'firstObservedAt') or ARGV[2])
local last = tonumber(redis.call('HGET', KEYS[1], 'lastObservedAt') or ARGV[2])
if not first or not last then
  return redis.error_reply('invalid history cost timestamp')
end
for field, increment in pairs(increments) do
  local current = tonumber(redis.call('HGET', KEYS[1], field) or '0')
  if not current or current < 0 then
    return redis.error_reply('invalid history cost counter ' .. field)
  end
  totals[field] = current + increment
end
for field, total in pairs(totals) do
  redis.call('HSET', KEYS[1], field, string.format('%.17g', total))
end
redis.call('HSET', KEYS[1], 'firstObservedAt', math.min(first, tonumber(ARGV[2])),
  'lastObservedAt', math.max(last, tonumber(ARGV[2])))
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 'OK'
`;

export async function recordHistoryCost(observation, deps = {}) {
  const env = deps.env ?? process.env;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return false;
  const { domain, resource, at } = observation;
  if (!domain || !resource || !Number.isSafeInteger(at) || at < 0) {
    throw new Error('invalid history cost scope or timestamp');
  }
  const increments = Object.fromEntries(HISTORY_COST_FIELDS.map(field => {
    const value = observation[field] ?? 0;
    if (!Number.isFinite(value) || value < 0 || (field !== 'knownCostUsd' && !Number.isSafeInteger(value))) {
      throw new Error(`invalid history cost counter ${field}`);
    }
    return [field, value];
  }));
  const day = new Date(at).toISOString().slice(0, 10);
  const expiresAt = Math.floor(Date.parse(day) / 1000) + (HISTORY_COST_RETENTION_DAYS + 1) * 86400;
  const command = ['EVAL', HISTORY_COST_UPDATE_SCRIPT, 1,
    historyCostKey(domain, resource, day), JSON.stringify(increments), at, expiresAt];
  const response = await (deps.fetchImpl ?? globalThis.fetch)(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-history-cost/1.0',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(HISTORY_COST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`history cost write HTTP ${response.status}`);
  const result = await response.json();
  if (result?.result !== 'OK' || result?.error) throw new Error('history cost write was not confirmed');
  return true;
}
