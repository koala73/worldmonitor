// Widget-only admission and paid-work reservations. See docs/widget-quota.md.
export const WIDGET_QUOTA_KEY = 'widget:quota:v1';
export const WIDGET_TARIFF = '2026-09-10';
export const WIDGET_MODEL_POLICY = Object.freeze({
  basic: Object.freeze({
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    microUsd: 220480,
  }),
  pro: Object.freeze({
    model: 'claude-sonnet-4-6',
    maxTokens: 8192,
    microUsd: 3122880,
  }),
});
// Above the published cost of fast search + text for eight pages, and Brave
// web search. Each fallback attempt gets its own reservation.
export const WIDGET_SEARCH_MICRO_USD = 100000;

export class WidgetQuotaError extends Error {
  constructor(status = 503, retryAfter = 30) {
    super(
      status === 429
        ? 'Widget quota exhausted. Try again later.'
        : 'Widget quota unavailable. Try again later.',
    );
    this.name = 'WidgetQuotaError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// One persistent ledger, provisioned by the operator. Redis time owns all
// windows. No TTL, refunds, local fallback, or read/modify/write race.
export const WIDGET_RESERVE_LUA = `
local function integer(v)
  local n = tonumber(v)
  if not n or n < 0 or n > 1000000000000 or n ~= math.floor(n) then return nil end
  return n
end
local config = redis.call('HMGET', KEYS[1], 'tariff', 'globalLimit', 'basicLimit', 'proLimit', 'day', 'spent')
local globalLimit, basicLimit, proLimit = integer(config[2]), integer(config[3]), integer(config[4])
local globalDay, globalSpent = integer(config[5]), integer(config[6])
if config[1] ~= ARGV[1] or not globalLimit or not basicLimit or not proLimit or not globalDay or not globalSpent then return {503,30} end
local now = tonumber(redis.call('TIME')[1])
local day, hour = math.floor(now / 86400), math.floor(now / 3600)
if globalDay > day then return {503,30} end
if globalDay < day then globalSpent = 0 end
local raw = redis.call('HGET', KEYS[1], ARGV[2])
local state = {day=day, spent=0, edgeHour=hour, edgeCount=0, relayHour=hour, relayCount=0}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return {503,30} end
  state = decoded
  for _, field in ipairs({'day','spent','edgeHour','edgeCount','relayHour','relayCount'}) do
    if not integer(state[field]) then return {503,30} end
  end
  if state.day > day or state.edgeHour > hour or state.relayHour > hour then return {503,30} end
end
if state.day < day then state.day = day; state.spent = 0 end
local limit = ARGV[3] == 'pro' and proLimit or basicLimit
local cost = integer(ARGV[5])
if not cost then return {503,30} end
if globalSpent + cost > globalLimit or state.spent + cost > limit then return {429,86400 - now % 86400} end
if ARGV[4] ~= 'paid' then
  local hourField, countField = ARGV[4] .. 'Hour', ARGV[4] .. 'Count'
  if state[hourField] < hour then state[hourField] = hour; state[countField] = 0 end
  local rate = ARGV[3] == 'pro' and 20 or 10
  if state[countField] >= rate then return {429,3600 - now % 3600} end
  state[countField] = state[countField] + 1
end
state.spent = state.spent + cost
redis.call('HSET', KEYS[1], 'day', day, 'spent', globalSpent + cost, ARGV[2], cjson.encode(state))
return {200,0}
`;

export async function reserveWidgetQuota(principal, tier, stage, microUsd = 0) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (
    !url ||
    !token ||
    (!/^https:\/\//.test(url) &&
      !(
        process.env.UPSTASH_ALLOW_INSECURE_HTTP === 'true' &&
        /^http:\/\//.test(url)
      )) ||
    !/^(key|user):[a-f0-9]{64}$/.test(principal) ||
    !['basic', 'pro'].includes(tier) ||
    !['edge', 'relay', 'paid'].includes(stage) ||
    !Number.isSafeInteger(microUsd) ||
    microUsd < 0 ||
    microUsd > 1000000000000 ||
    (stage === 'paid' ? microUsd === 0 : microUsd !== 0)
  )
    throw new WidgetQuotaError();
  let result;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WorldMonitor-WidgetQuota/1.0',
      },
      body: JSON.stringify([
        'EVAL',
        WIDGET_RESERVE_LUA,
        1,
        WIDGET_QUOTA_KEY,
        WIDGET_TARIFF,
        principal,
        tier,
        stage,
        microUsd,
      ]),
      signal: AbortSignal.timeout(4500),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('quota store status');
    const payload = await response.json();
    if (payload.error) throw new Error('quota store error');
    result = payload.result;
  } catch {
    throw new WidgetQuotaError();
  }
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    !Number.isSafeInteger(result[1])
  )
    throw new WidgetQuotaError();
  if (result[0] === 200 && result[1] === 0) return;
  if (result[0] === 429 && result[1] > 0 && result[1] <= 86400)
    throw new WidgetQuotaError(429, result[1]);
  throw new WidgetQuotaError();
}

const encoder = new TextEncoder();
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export async function widgetPrincipal(kind, value) {
  if (!['key', 'user'].includes(kind) || typeof value !== 'string' || !value)
    throw new WidgetQuotaError();
  return `${kind}:${await digest(value)}`;
}
async function signingKey() {
  const secret = process.env.WIDGET_QUOTA_SIGNING_KEY;
  if (!secret || secret.length < 32) throw new WidgetQuotaError();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
async function proofMessage(principal, tier, timestamp, body) {
  return encoder.encode(
    `widget-quota-v1\n${principal}\n${tier}\n${timestamp}\n${await digest(body)}`,
  );
}
export async function signWidgetPrincipal(principal, tier, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = hex(
    await crypto.subtle.sign(
      'HMAC',
      await signingKey(),
      await proofMessage(principal, tier, timestamp, body),
    ),
  );
  return {
    'X-Widget-Principal': principal,
    'X-Widget-Timestamp': timestamp,
    'X-Widget-Signature': signature,
  };
}
export async function verifyWidgetPrincipal(headers, tier, body) {
  const principal = headers['x-widget-principal'];
  const timestamp = headers['x-widget-timestamp'];
  const signature = headers['x-widget-signature'];
  if (
    typeof principal !== 'string' ||
    !/^(key|user):[a-f0-9]{64}$/.test(principal) ||
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 120 ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new WidgetQuotaError(403);
  const bytes = Uint8Array.from(signature.match(/../g), (h) => parseInt(h, 16));
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await signingKey(),
      bytes,
      await proofMessage(principal, tier, timestamp, body),
    ))
  )
    throw new WidgetQuotaError(403);
  return principal;
}
