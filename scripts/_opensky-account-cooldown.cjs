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

const OPENSKY_COOLDOWN_KEY = 'opensky:cooldown-until:v1';
const OPENSKY_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Header-less 429s still park the shared key. The seeder is a one-shot */5
// cron, so any deadline under 300s expires before the next tick and
// suppresses exactly zero seeder requests. Two ticks (10 min) is the persist
// fallback both writers use; the relay may keep a shorter in-process cooldown.
const OPENSKY_SHARED_FALLBACK_COOLDOWN_MS = 10 * 60_000;

function accountFingerprint(clientId) {
  if (!clientId) return null;
  return createHash('sha256').update(clientId).digest('hex').slice(0, 12);
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
  // path, so obey the clock rather than the value. Logged as a raw number:
  // `new Date(n).toISOString()` throws RangeError past ±8.64e15 (#6241).
  if (remainingMs > maxMs) {
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
local current = redis.call('GET', KEYS[1])
local newUntil = tonumber(ARGV[3])
if newUntil == nil then
  return 0
end
if current then
  local ok, existing = pcall(cjson.decode, current)
  local existingUntil = ok and tonumber(existing['until']) or nil
  if existingUntil ~= nil and existingUntil >= newUntil then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return 1
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
  if (Number.isFinite(existingUntil) && existingUntil >= incomingUntil) {
    return { write: false, reason: 'existing-deadline-wins', existingUntil };
  }
  return { write: true, reason: Number.isFinite(existingUntil) ? 'newer-deadline' : 'missing' };
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

function maxDeadlineSetCommand(key, record, ttlSeconds) {
  return [
    'EVAL', OPENSKY_MAX_DEADLINE_SET_LUA, '1',
    key,
    serializeCooldownRecord(record),
    String(ttlSeconds),
    String(record.until),
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
  OPENSKY_MAX_COOLDOWN_MS,
  OPENSKY_SHARED_FALLBACK_COOLDOWN_MS,
  OPENSKY_MAX_DEADLINE_SET_LUA,
  OPENSKY_COMPARE_AND_DEL_LUA,
  accountFingerprint,
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
