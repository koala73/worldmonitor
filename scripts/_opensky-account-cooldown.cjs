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
    recordedBy,
  };
}

module.exports = {
  OPENSKY_COOLDOWN_KEY,
  OPENSKY_MAX_COOLDOWN_MS,
  accountFingerprint,
  clampCooldownMs,
  ttlSecondsForCooldown,
  inspectCooldownRecord,
  buildCooldownRecord,
};
