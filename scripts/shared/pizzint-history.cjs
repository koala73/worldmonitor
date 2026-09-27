'use strict';

const PREFIX = 'intelligence:pizzint:history:v1';
const PROVIDERS = new Set(['pizzint', 'besttime']);
const QUALITIES = new Set(['available', 'closed', 'missing', 'stale', 'invalid_clock']);
const MAX_LOCATIONS = 24;
const MAX_PLACE_ID_BYTES = 200;
const MAX_RECORD_BYTES = 1024;
const MAX_FIELDS = 4000;
const RETENTION_DAYS = 90;

const WRITE_LUA = `
local missing = 0
local seen = {}
for i = 1, #ARGV - 2, 3 do
  if not seen[ARGV[i]] and redis.call('HEXISTS', KEYS[1], ARGV[i]) == 0 then missing = missing + 1 end
  seen[ARGV[i]] = true
end
if redis.call('HLEN', KEYS[1]) + missing > tonumber(ARGV[#ARGV]) then
  return {err = 'history_bucket_cap'}
end
local inserted = 0
local replaced = 0
local skipped = 0
for i = 1, #ARGV - 2, 3 do
  local field = ARGV[i]
  local captured = tonumber(ARGV[i + 1])
  local value = ARGV[i + 2]
  local current = redis.call('HGET', KEYS[1], field)
  if current then
    local ok, decoded = pcall(cjson.decode, current)
    local prior = ok and type(decoded) == 'table' and tonumber(decoded.c) or nil
    if prior and prior >= captured then
      skipped = skipped + 1
    else
      redis.call('HSET', KEYS[1], field, value)
      replaced = replaced + 1
    end
  else
    redis.call('HSET', KEYS[1], field, value)
    inserted = inserted + 1
  end
end
redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[#ARGV - 1]))
return {inserted, replaced, skipped, redis.call('HLEN', KEYS[1])}
`;

function isoMillis(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be an ISO timestamp`);
  return ms;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactRecord(record) {
  return JSON.stringify({
    v: 1, p: record.provider, i: record.placeId, c: isoMillis(record.capturedAt, 'capturedAt'),
    s: record.sourceRecordedAt === null ? null : isoMillis(record.sourceRecordedAt, 'sourceRecordedAt'),
    l: finiteOrNull(record.live), f: finiteOrNull(record.providerForecast), q: record.quality,
    b: record.sourceClock === 'provider' ? 'p' : 'c',
  });
}

function decodePizzintHistoryRecord(value) {
  let raw;
  try { raw = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new TypeError('invalid history record JSON'); }
  const valid = raw && raw.v === 1 && PROVIDERS.has(raw.p) && typeof raw.i === 'string'
    && Buffer.byteLength(raw.i) > 0 && Buffer.byteLength(raw.i) <= MAX_PLACE_ID_BYTES
    && Number.isFinite(raw.c) && (raw.s === null || Number.isFinite(raw.s))
    && (raw.l === null || Number.isFinite(raw.l)) && (raw.f === null || Number.isFinite(raw.f))
    && QUALITIES.has(raw.q) && raw.b === (raw.p === 'pizzint' ? 'p' : 'c')
    && (raw.p === 'besttime' ? raw.s === null : (raw.s !== null || raw.q === 'invalid_clock'))
    && !(raw.q === 'available' && (raw.l === null || raw.l < 0));
  if (!valid) throw new TypeError('invalid history record');
  return {
    version: 1, provider: raw.p, placeId: raw.i, capturedAt: new Date(raw.c).toISOString(),
    sourceRecordedAt: raw.s === null ? null : new Date(raw.s).toISOString(), live: raw.l,
    providerForecast: raw.f, quality: raw.q, sourceClock: raw.b === 'p' ? 'provider' : 'collection',
  };
}

function qualityOf(provider, location, capturedMs) {
  const sourceMs = Date.parse(location.recordedAt);
  if (provider === 'pizzint' && (!Number.isFinite(sourceMs) || sourceMs > capturedMs || capturedMs - sourceMs > 15 * 60000)) return 'invalid_clock';
  if (location.isClosedNow) return 'closed';
  if (location.dataFreshness !== 'DATA_FRESHNESS_FRESH') return 'stale';
  if (location.noLiveSignal || !Number.isFinite(location.currentPopularity)) return 'missing';
  return 'available';
}

function buildPizzintHistoryWrite({ provider, locations, capturedAt }) {
  if (!PROVIDERS.has(provider)) throw new TypeError('provider must be pizzint or besttime');
  if (!Array.isArray(locations)) throw new TypeError('locations must be an array');
  if (locations.length > MAX_LOCATIONS) throw new RangeError('locations must contain at most 24 rows');
  const capturedMs = isoMillis(capturedAt, 'capturedAt');
  const captureIso = new Date(capturedMs).toISOString();
  const day = captureIso.slice(0, 10);
  const slot = new Date(Math.floor(capturedMs / 600000) * 600000).toISOString().slice(0, 16) + 'Z';
  const records = locations.map((location) => {
    const placeId = String(location.placeId || '');
    if (!placeId || Buffer.byteLength(placeId) > MAX_PLACE_ID_BYTES) throw new RangeError('placeId must contain 1..200 bytes');
    const record = {
      version: 1, provider, placeId, capturedAt: captureIso,
      sourceRecordedAt: provider === 'pizzint' && Number.isFinite(Date.parse(location.recordedAt)) ? location.recordedAt : null,
      live: finiteOrNull(location.currentPopularity),
      providerForecast: location.hasBaseline === false ? null : finiteOrNull(location.forecastPopularity), quality: qualityOf(provider, location, capturedMs),
      sourceClock: provider === 'pizzint' ? 'provider' : 'collection',
    };
    const value = compactRecord(record);
    if (Buffer.byteLength(value) > MAX_RECORD_BYTES) throw new RangeError('history record exceeds 1024 bytes');
    return { field: `${placeId}|${slot}`, capturedMs, value };
  });
  const bucketEndMs = Date.parse(`${day}T00:00:00.000Z`) + 86400000;
  return { keys: [`${PREFIX}:${provider}:${day}`], records, expireAt: Math.floor((bucketEndMs + RETENTION_DAYS * 86400000) / 1000) };
}

async function recordPizzintHistory(input, evalCommand) {
  if (typeof evalCommand !== 'function') throw new TypeError('evalCommand must be a function');
  const write = buildPizzintHistoryWrite(input);
  if (write.records.length === 0) return { ok: true, inserted: 0, replaced: 0, skipped: 0, fields: 0 };
  const args = write.records.flatMap(({ field, capturedMs, value }) => [field, capturedMs, value]);
  args.push(write.expireAt, MAX_FIELDS);
  const result = await evalCommand(WRITE_LUA, write.keys, args);
  if (!Array.isArray(result) || result.length !== 4 || result.some((n) => !Number.isInteger(Number(n)))) throw new Error('history_write_failed');
  return { ok: true, inserted: Number(result[0]), replaced: Number(result[1]), skipped: Number(result[2]), fields: Number(result[3]) };
}

const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const weekdayIndex = new Map([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]);
function localParts(ms) {
  const parts = Object.fromEntries(nyParts.formatToParts(ms).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: weekdayIndex.get(parts.weekday), hour: Number(parts.hour) };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function evaluatePizzintHistory(records, { asOf = new Date().toISOString(), days = RETENTION_DAYS } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) throw new RangeError('days must be an integer from 1 through 90');
  const asOfMs = isoMillis(asOf, 'asOf');
  const cutoff = asOfMs - days * 86400000;
  const currentLocalDate = localParts(asOfMs).date;
  const exclusions = { invalid: 0, unavailable_quality: 0, future: 0, current_local_date: 0, outside_retention: 0, duplicate_source_time: 0 };
  const included = [];
  const seenSource = new Map();
  for (const candidate of records) {
    let record;
    try {
      if (candidate?.version === 1) {
        const exact = candidate && candidate.provider && candidate.placeId && candidate.capturedAt
          && Object.hasOwn(candidate, 'sourceRecordedAt') && Object.hasOwn(candidate, 'live')
          && Object.hasOwn(candidate, 'providerForecast') && candidate.quality
          && ['provider', 'collection'].includes(candidate.sourceClock)
          && (candidate.live === null || Number.isFinite(candidate.live))
          && (candidate.providerForecast === null || Number.isFinite(candidate.providerForecast));
        if (!exact) throw new TypeError('invalid expanded record');
        record = decodePizzintHistoryRecord(compactRecord(candidate));
      } else {
        record = decodePizzintHistoryRecord(candidate);
      }
    } catch { exclusions.invalid++; continue; }
    const capturedMs = Date.parse(record.capturedAt);
    const cohortMs = record.sourceRecordedAt === null ? capturedMs : Date.parse(record.sourceRecordedAt);
    const sourceAge = capturedMs - cohortMs;
    if (record.quality !== 'available' || record.live === null || record.live < 0
      || (record.provider === 'pizzint' && (sourceAge < 0 || sourceAge > 15 * 60000))) { exclusions.unavailable_quality++; continue; }
    if (cohortMs >= asOfMs || capturedMs >= asOfMs) { exclusions.future++; continue; }
    if (capturedMs < cutoff || cohortMs < cutoff) { exclusions.outside_retention++; continue; }
    const local = localParts(cohortMs);
    if (local.date === currentLocalDate) { exclusions.current_local_date++; continue; }
    if (record.provider === 'pizzint') {
      const id = `${record.provider}|${record.placeId}|${record.sourceRecordedAt}`;
      if (seenSource.has(id)) {
        exclusions.duplicate_source_time++;
        const index = seenSource.get(id);
        const prior = included[index];
        if (capturedMs < Date.parse(prior.capturedAt)
          || (capturedMs === Date.parse(prior.capturedAt) && record.live < prior.live)) {
          included[index] = { ...record, ...local, cohortMs };
        }
        continue;
      }
      seenSource.set(id, included.length);
    }
    included.push({ ...record, ...local, cohortMs });
  }
  const grouped = new Map();
  for (const record of included) {
    const key = `${record.provider}\0${record.placeId}\0${record.weekday}\0${record.hour}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  const cohorts = [];
  for (const rows of grouped.values()) {
    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row.live);
    }
    const daily = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, median: median(values), observations: values.length }));
    const dateCount = daily.length;
    const baseline = dateCount >= 6 ? median(daily.map((d) => d.median)) : null;
    const mad = baseline === null ? null : median(daily.map((d) => Math.abs(d.median - baseline)));
    const latest = rows.reduce((a, b) => a.cohortMs > b.cohortMs ? a : b);
    cohorts.push({
      provider: latest.provider, placeId: latest.placeId, weekday: latest.weekday, hour: latest.hour,
      status: dateCount >= 6 ? 'ready' : 'insufficient_history', dateCount, observationCount: rows.length,
      firstDate: daily[0]?.date || null, lastDate: daily.at(-1)?.date || null, baseline, mad,
      daily,
    });
  }
  cohorts.sort((a, b) => a.provider.localeCompare(b.provider) || a.placeId.localeCompare(b.placeId) || a.weekday - b.weekday || a.hour - b.hour);
  const excluded = Object.values(exclusions).reduce((sum, value) => sum + value, 0);
  return {
    schemaVersion: 1, asOf: new Date(asOfMs).toISOString(), days, timezone: 'America/New_York',
    provenance: { storage: 'redis_daily_utc_hash', cohortClock: { pizzint: 'provider', besttime: 'collection' }, method: 'median_of_date_medians', minimumDates: 6 },
    counts: { input: records.length, included: included.length, excluded }, exclusions, cohorts,
  };
}

module.exports = {
  PREFIX, PROVIDERS: [...PROVIDERS], RETENTION_DAYS, WRITE_LUA,
  buildPizzintHistoryWrite, decodePizzintHistoryRecord, recordPizzintHistory, evaluatePizzintHistory,
};
