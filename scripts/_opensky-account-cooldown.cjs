'use strict';

// Shared OpenSky account-quota cooldown. The quota is per OpenSky *account*,
// but the seeder (one-shot cron) and the AIS relay (long-lived process) used
// to keep independent 429 state — so each still burned a doomed request to
// discover the other's lockout (#6253 / #6241).
//
// Redis is the only state that outlives a seeder process. Both writers stamp
// a non-secret fingerprint of OPENSKY_CLIENT_ID so a credential rotation
// cannot inherit the previous account's lockout. Every unreadable record
// fails OPEN: a wrong "no cooldown" costs one wasted request; a wrong
// "cooldown active" silently deletes a data tier.

const { createHash } = require('node:crypto');

const OPENSKY_COOLDOWN_KEY = 'opensky:cooldown-until:v2';
// v1 stored every account under one key. Readers retain this name only while
// migrating a matching account's still-live record into its v2 key.
const OPENSKY_LEGACY_COOLDOWN_KEY = 'opensky:cooldown-until:v1';
// Temporary rolling-deploy bridge. New writers update v2 and v1 atomically,
// and new readers consult v1 only until this deadline. The override lets an
// operator extend a delayed rollout without leaving the extra Redis read in
// the steady-state request path forever.
const OPENSKY_LEGACY_COOLDOWN_COMPAT_DEFAULT_UNTIL = '2026-09-07T00:00:00.000Z';
const OPENSKY_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const OPENSKY_MAX_CLOCK_SKEW_MS = 5_000;
// Header-less 429s still park the shared key. The seeder is a one-shot */5
// cron, so any deadline under 300s expires before the next tick and
// suppresses exactly zero seeder requests. Two ticks (10 min) is the persist
// fallback both writers use; the relay may keep a shorter in-process cooldown.
const OPENSKY_SHARED_FALLBACK_COOLDOWN_MS = 10 * 60_000;

function accountFingerprint(clientId) {
  if (!clientId) return null;
  return createHash('sha256').update(clientId).digest('hex').slice(0, 12);
}

function cooldownKeyForAccount(account) {
  return OPENSKY_COOLDOWN_KEY + ':' + (typeof account === 'string' && account ? account : 'unknown');
}

function legacyCooldownCompatibilityEnabled({
  now = Date.now(),
  cutoff = process.env.OPENSKY_LEGACY_COOLDOWN_COMPAT_UNTIL
    || OPENSKY_LEGACY_COOLDOWN_COMPAT_DEFAULT_UNTIL,
} = {}) {
  const cutoffMs = typeof cutoff === 'number' ? cutoff : Date.parse(String(cutoff));
  return Number.isFinite(now) && Number.isFinite(cutoffMs) && now < cutoffMs;
}

function clampCooldownMs(retryAfterSeconds, fallbackMs, maxMs = OPENSKY_MAX_COOLDOWN_MS) {
  const advertisedMs = (Number(retryAfterSeconds) || 0) * 1000;
  const fallback = Number(fallbackMs);
  const safeFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
  return Math.min(maxMs, Math.max(safeFallback, advertisedMs));
}

function ttlSecondsForCooldown(cooldownMs) {
  return Math.ceil(cooldownMs / 1000) + 60;
}

function inspectCooldownRecord(record, {
  account,
  now = Date.now(),
  maxMs = OPENSKY_MAX_COOLDOWN_MS,
} = {}) {
  const until = Number(record?.until);
  if (!Number.isFinite(until)) return { remainingMs: 0 };
  // A record written by different credentials describes a quota this process
  // does not share. Records with no fingerprint predate this field, so they
  // are also treated as not-ours rather than obeyed blindly (#6241).
  if (!record?.account || record.account !== account) {
    return { remainingMs: 0, ignoreReason: 'account-mismatch' };
  }
  const remainingMs = until - now;
  // Beyond the documented maximum the record cannot have come from this code
  // path, unless this writer recorded the exact clamped duration. That lets a
  // reader whose clock is slightly behind still honor a valid maximum window.
  if (remainingMs > maxMs) {
    const recordedAt = record?.recordedAt;
    const cooldownMs = record?.cooldownMs;
    const hasRecordedDuration = typeof recordedAt === 'number'
      && typeof cooldownMs === 'number'
      && Number.isFinite(recordedAt)
      && Number.isFinite(cooldownMs)
      && cooldownMs >= 0
      && cooldownMs <= maxMs
      && until === recordedAt + cooldownMs
      && recordedAt <= now + OPENSKY_MAX_CLOCK_SKEW_MS;
    if (hasRecordedDuration) return { remainingMs: maxMs };
    return { remainingMs: 0, ignoreReason: 'implausible-deadline', until };
  }
  return { remainingMs: Math.max(0, remainingMs) };
}

function buildCooldownRecord({
  now = Date.now(),
  cooldownMs,
  retryAfterSeconds,
  account,
  recordedBy,
}) {
  const until = now + cooldownMs;
  return {
    until,
    untilIso: new Date(until).toISOString(),
    // Both values: the clamped one drove the deadline, the advertised one is
    // what OpenSky actually said. Persisting only the clamp hides an
    // implausible upstream header from whoever reads this key during an
    // incident (#6241).
    retryAfterSeconds: retryAfterSeconds ?? null,
    cooldownMs,
    account,
    recordedAt: now,
    // Compare-and-delete identity. Same instant as recordedAt; named so a
    // success path can drop only the record it observed, not a later write.
    revision: now,
    recordedBy,
  };
}

function serializeCooldownRecord(record) {
  return JSON.stringify(record);
}

function parseStoredCooldownRecord(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storedCooldownJson(raw) {
  if (raw == null || raw === '') return '';
  return typeof raw === 'string' ? raw : serializeCooldownRecord(raw);
}

// Last-write-wins SET can let a late 90s relay 429 erase a seeder's 10 min
// lockout, or the reverse. Both writers EVAL this so the stored `until` is a
// max, not a coin-flip (#6253 review).
const OPENSKY_MAX_DEADLINE_SET_LUA = `
local newUntil = tonumber(ARGV[3])
local incomingAccount = ARGV[4] or ''
if newUntil == nil then
  return 0
end
local writes = 0
for _, key in ipairs(KEYS) do
  local current = redis.call('GET', key)
  local shouldWrite = true
  if current then
    local ok, existing = pcall(cjson.decode, current)
    if ok and type(existing) == 'table' then
      local existingUntil = tonumber(existing['until'])
      if type(existing['account']) == 'string'
        and existing['account'] == incomingAccount
        and existingUntil ~= nil and existingUntil >= newUntil then
        shouldWrite = false
      end
    end
  end
  if shouldWrite then
    redis.call('SET', key, ARGV[1], 'EX', tonumber(ARGV[2]))
    writes = writes + 1
  end
end
return writes
`.trim();

// Unconditional DEL after a success can erase a newer, longer cooldown that
// landed while the request was in flight. Delete only the observed revision,
// an exact stored record, or a deadline that is not newer than the watermark
// (expired / corrupt leftovers still self-heal when the read failed open).
const OPENSKY_COMPARE_AND_DEL_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if ARGV[1] ~= '' and current == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
local ok, existing = pcall(cjson.decode, current)
if not ok or type(existing) ~= 'table' then
  return redis.call('DEL', KEYS[1])
end
if ARGV[2] ~= '' then
  local rev = existing['revision']
  if rev == nil then rev = existing['recordedAt'] end
  if tostring(rev) == ARGV[2] then
    return redis.call('DEL', KEYS[1])
  end
end
local existingUntil = tonumber(existing['until'])
local watermark = tonumber(ARGV[3])
if existingUntil == nil or (watermark ~= nil and existingUntil <= watermark) then
  return redis.call('DEL', KEYS[1])
end
return 0
`.trim();

function decideMaxDeadlineWrite(existingRecord, incomingRecord) {
  const incomingUntil = Number(incomingRecord?.until);
  if (!Number.isFinite(incomingUntil)) {
    return { write: false, reason: 'invalid-incoming' };
  }
  const existingUntil = Number(existingRecord?.until);
  const existingAccount = existingRecord?.account;
  const accountsMatch = typeof existingAccount === 'string'
    && existingAccount !== ''
    && existingAccount === incomingRecord?.account;
  if (accountsMatch && Number.isFinite(existingUntil) && existingUntil >= incomingUntil) {
    return { write: false, reason: 'existing-deadline-wins', existingUntil };
  }
  return { write: true, reason: Number.isFinite(existingUntil) && accountsMatch ? 'newer-deadline' : 'missing' };
}

function decideCompareAndDelete(currentRaw, {
  expectedJson = '',
  expectedRevision = '',
  watermarkUntil,
} = {}) {
  if (currentRaw == null || currentRaw === '') {
    return { delete: false, reason: 'missing' };
  }
  const currentJson = storedCooldownJson(currentRaw);
  if (expectedJson && currentJson === expectedJson) {
    return { delete: true, reason: 'record-match' };
  }
  const parsed = parseStoredCooldownRecord(currentRaw);
  if (!parsed) {
    return { delete: true, reason: 'unparseable' };
  }
  if (expectedRevision !== '' && expectedRevision != null) {
    const revision = parsed.revision ?? parsed.recordedAt;
    if (revision != null && String(revision) === String(expectedRevision)) {
      return { delete: true, reason: 'revision-match' };
    }
  }
  const existingUntil = Number(parsed.until);
  if (!Number.isFinite(existingUntil)) {
    return { delete: true, reason: 'unparseable' };
  }
  if (Number.isFinite(watermarkUntil) && existingUntil <= watermarkUntil) {
    return { delete: true, reason: 'not-newer-than-watermark' };
  }
  return { delete: false, reason: 'newer-revision' };
}

function applyMaxDeadlineWrite(store, key, record, ttlSeconds) {
  const decision = decideMaxDeadlineWrite(parseStoredCooldownRecord(store[key]), record);
  if (decision.write) {
    store[key] = serializeCooldownRecord(record);
  }
  return { ...decision, ttlSeconds };
}

function applyCompareAndDelete(store, key, opts) {
  const decision = decideCompareAndDelete(store[key], opts);
  if (decision.delete) {
    delete store[key];
  }
  return decision;
}

function maxDeadlineSetCommand(keyOrKeys, record, ttlSeconds) {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  if (keys.length === 0 || keys.some((key) => typeof key !== 'string' || key === '')) {
    throw new TypeError('maxDeadlineSetCommand requires at least one Redis key');
  }
  return [
    'EVAL', OPENSKY_MAX_DEADLINE_SET_LUA, String(keys.length),
    ...keys,
    serializeCooldownRecord(record),
    String(ttlSeconds),
    String(record.until),
    typeof record.account === 'string' ? record.account : '',
  ];
}

function compareAndDelCommand(key, {
  expectedJson = '',
  expectedRevision = '',
  watermarkUntil,
} = {}) {
  return [
    'EVAL', OPENSKY_COMPARE_AND_DEL_LUA, '1',
    key,
    expectedJson || '',
    expectedRevision == null ? '' : String(expectedRevision),
    String(Number.isFinite(watermarkUntil) ? watermarkUntil : 0),
  ];
}

module.exports = {
  OPENSKY_COOLDOWN_KEY,
  OPENSKY_LEGACY_COOLDOWN_KEY,
  OPENSKY_LEGACY_COOLDOWN_COMPAT_DEFAULT_UNTIL,
  OPENSKY_MAX_COOLDOWN_MS,
  OPENSKY_MAX_CLOCK_SKEW_MS,
  OPENSKY_SHARED_FALLBACK_COOLDOWN_MS,
  OPENSKY_MAX_DEADLINE_SET_LUA,
  OPENSKY_COMPARE_AND_DEL_LUA,
  accountFingerprint,
  cooldownKeyForAccount,
  legacyCooldownCompatibilityEnabled,
  clampCooldownMs,
  ttlSecondsForCooldown,
  inspectCooldownRecord,
  buildCooldownRecord,
  serializeCooldownRecord,
  parseStoredCooldownRecord,
  decideMaxDeadlineWrite,
  decideCompareAndDelete,
  applyMaxDeadlineWrite,
  applyCompareAndDelete,
  maxDeadlineSetCommand,
  compareAndDelCommand,
};
