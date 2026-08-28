import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const {
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
  applyMaxDeadlineWrite,
  applyCompareAndDelete,
  maxDeadlineSetCommand,
  compareAndDelCommand,
} = createRequire(import.meta.url)('../scripts/_opensky-account-cooldown.cjs');

test('shared cooldown key and fingerprint stay stable across processes', () => {
  assert.equal(OPENSKY_COOLDOWN_KEY, 'opensky:cooldown-until:v1');
  assert.equal(accountFingerprint('test-client'), accountFingerprint('test-client'));
  assert.notEqual(accountFingerprint('test-client'), accountFingerprint('other-client'));
  assert.equal(accountFingerprint(''), null);
  assert.equal(accountFingerprint(), null);
});

test('clamp uses the caller fallback and caps at 24h', () => {
  assert.equal(clampCooldownMs(null, 90_000), 90_000);
  assert.equal(clampCooldownMs(30, 90_000), 90_000, 'advertised window below fallback still uses fallback');
  assert.equal(clampCooldownMs(900, 90_000), 900_000);
  assert.equal(clampCooldownMs(999_999, 90_000), OPENSKY_MAX_COOLDOWN_MS);
  assert.equal(ttlSecondsForCooldown(90_000), 150);
});

test('shared persist fallback spans the seeder */5 cadence', () => {
  assert.ok(OPENSKY_SHARED_FALLBACK_COOLDOWN_MS >= 300_000);
  assert.equal(OPENSKY_SHARED_FALLBACK_COOLDOWN_MS, 10 * 60_000);
  assert.equal(clampCooldownMs(null, OPENSKY_SHARED_FALLBACK_COOLDOWN_MS), 10 * 60_000);
  assert.equal(clampCooldownMs(120, OPENSKY_SHARED_FALLBACK_COOLDOWN_MS), 10 * 60_000);
});

test('inspectCooldownRecord fails open on corrupt, mismatched, and implausible records', () => {
  const account = accountFingerprint('test-client');
  const now = 1_700_000_000_000;
  assert.equal(inspectCooldownRecord(null, { account, now }).remainingMs, 0);
  assert.equal(inspectCooldownRecord({ until: 'nope' }, { account, now }).remainingMs, 0);
  assert.deepEqual(
    inspectCooldownRecord({ until: now + 60_000 }, { account, now }),
    { remainingMs: 0, ignoreReason: 'account-mismatch' },
  );
  assert.deepEqual(
    inspectCooldownRecord({ until: now + 60_000, account: 'other' }, { account, now }),
    { remainingMs: 0, ignoreReason: 'account-mismatch' },
  );
  const implausible = inspectCooldownRecord(
    { until: now + OPENSKY_MAX_COOLDOWN_MS + 1, account },
    { account, now },
  );
  assert.equal(implausible.remainingMs, 0);
  assert.equal(implausible.ignoreReason, 'implausible-deadline');
  assert.equal(
    inspectCooldownRecord({ until: now + 45_000, account }, { account, now }).remainingMs,
    45_000,
  );
  assert.equal(
    inspectCooldownRecord({ until: now - 1, account }, { account, now }).remainingMs,
    0,
  );
});

test('relay and seeder records are interchangeable for a matching account', () => {
  const account = accountFingerprint('shared-account');
  const now = 1_700_000_000_000;
  const seederRecord = buildCooldownRecord({
    now,
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: null,
    account,
    recordedBy: 'seed-military-flights',
  });
  const relayRecord = buildCooldownRecord({
    now,
    cooldownMs: 90_000,
    retryAfterSeconds: 120,
    account,
    recordedBy: 'ais-relay',
  });
  assert.equal(seederRecord.recordedBy, 'seed-military-flights');
  assert.equal(relayRecord.recordedBy, 'ais-relay');
  assert.equal(inspectCooldownRecord(seederRecord, { account, now: now + 1_000 }).remainingMs, 599_000);
  assert.equal(inspectCooldownRecord(relayRecord, { account, now: now + 1_000 }).remainingMs, 89_000);
  assert.equal(seederRecord.revision, now);
  assert.equal(relayRecord.revision, now);
});

test('interleaved max-deadline writes keep the longer until', () => {
  const key = OPENSKY_COOLDOWN_KEY;
  const account = accountFingerprint('shared-account');
  const t0 = 1_700_000_000_000;
  const longRecord = buildCooldownRecord({
    now: t0,
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: 900,
    account,
    recordedBy: 'seed-military-flights',
  });
  const shortRecord = buildCooldownRecord({
    now: t0 + 80,
    cooldownMs: 90_000,
    retryAfterSeconds: 30,
    account,
    recordedBy: 'ais-relay',
  });

  const lateShort = {};
  assert.equal(applyMaxDeadlineWrite(lateShort, key, longRecord).write, true);
  const skippedShort = applyMaxDeadlineWrite(lateShort, key, shortRecord);
  assert.equal(skippedShort.write, false);
  assert.equal(skippedShort.reason, 'existing-deadline-wins');
  assert.equal(skippedShort.existingUntil, longRecord.until);
  assert.equal(JSON.parse(lateShort[key]).until, longRecord.until);
  assert.equal(JSON.parse(lateShort[key]).recordedBy, 'seed-military-flights');

  const lateLong = {};
  assert.equal(applyMaxDeadlineWrite(lateLong, key, shortRecord).write, true);
  assert.equal(applyMaxDeadlineWrite(lateLong, key, longRecord).reason, 'newer-deadline');
  assert.equal(JSON.parse(lateLong[key]).until, longRecord.until);
  assert.equal(JSON.parse(lateLong[key]).recordedBy, 'seed-military-flights');
});

test('compare-and-delete refuses a stale success after a newer longer cooldown', () => {
  const key = OPENSKY_COOLDOWN_KEY;
  const account = accountFingerprint('shared-account');
  const t0 = 1_700_000_000_000;
  const observedExpired = buildCooldownRecord({
    now: t0 - 200_000,
    cooldownMs: 90_000,
    account,
    recordedBy: 'ais-relay',
  });
  const newerLong = buildCooldownRecord({
    now: t0 + 25,
    cooldownMs: 15 * 60_000,
    retryAfterSeconds: 900,
    account,
    recordedBy: 'ais-relay',
  });

  const store = {};
  applyMaxDeadlineWrite(store, key, observedExpired);
  applyMaxDeadlineWrite(store, key, newerLong);

  assert.deepEqual(
    applyCompareAndDelete(store, key, {
      expectedJson: JSON.stringify(observedExpired),
      expectedRevision: String(observedExpired.revision),
      watermarkUntil: t0,
    }),
    { delete: false, reason: 'newer-revision' },
  );
  assert.equal(JSON.parse(store[key]).until, newerLong.until);

  assert.equal(
    applyCompareAndDelete(store, key, {
      expectedJson: '',
      expectedRevision: '',
      watermarkUntil: t0,
    }).delete,
    false,
    'fail-open success must not wipe an active later deadline',
  );

  const matching = { [key]: JSON.stringify(observedExpired) };
  assert.equal(
    applyCompareAndDelete(matching, key, {
      expectedRevision: String(observedExpired.revision),
      watermarkUntil: t0 - 1,
    }).reason,
    'revision-match',
  );
  assert.equal(matching[key], undefined);

  const leftover = { [key]: JSON.stringify(observedExpired) };
  assert.equal(
    applyCompareAndDelete(leftover, key, { watermarkUntil: t0 }).reason,
    'not-newer-than-watermark',
  );
  assert.equal(leftover[key], undefined);

  const corrupt = { [key]: '{not-json' };
  assert.equal(applyCompareAndDelete(corrupt, key, { watermarkUntil: t0 }).reason, 'unparseable');
});

test('EVAL command builders carry the shared Lua and compare args', () => {
  const record = buildCooldownRecord({
    now: 1_700_000_000_000,
    cooldownMs: 90_000,
    account: 'abc',
    recordedBy: 'ais-relay',
  });
  const setCmd = maxDeadlineSetCommand(OPENSKY_COOLDOWN_KEY, record, 150);
  assert.equal(setCmd[0], 'EVAL');
  assert.equal(setCmd[1], OPENSKY_MAX_DEADLINE_SET_LUA);
  assert.equal(setCmd[3], OPENSKY_COOLDOWN_KEY);
  assert.equal(JSON.parse(setCmd[4]).until, record.until);
  assert.equal(setCmd[6], String(record.until));

  const delCmd = compareAndDelCommand(OPENSKY_COOLDOWN_KEY, {
    expectedJson: JSON.stringify(record),
    expectedRevision: record.revision,
    watermarkUntil: record.recordedAt,
  });
  assert.equal(delCmd[1], OPENSKY_COMPARE_AND_DEL_LUA);
  assert.equal(delCmd[4], JSON.stringify(record));
  assert.equal(delCmd[5], String(record.revision));
  assert.equal(delCmd[6], String(record.recordedAt));
});

test('relay and seeder wire the shared atomic helpers instead of SET/DEL', () => {
  const relay = readFileSync(join(here, '../scripts/ais-relay.cjs'), 'utf8');
  const seeder = readFileSync(join(here, '../scripts/seed-military-flights.mjs'), 'utf8');
  assert.match(relay, /maxDeadlineSetCommand/);
  assert.match(relay, /OPENSKY_MAX_DEADLINE_SET_LUA/);
  assert.doesNotMatch(relay, /upstashSet\(OPENSKY_COOLDOWN_KEY/);
  assert.match(seeder, /maxDeadlineSetCommand/);
  assert.match(seeder, /compareAndDelCommand/);
  assert.doesNotMatch(seeder, /redisSet\(\s*[\s\S]*OPENSKY_COOLDOWN_KEY/);
  assert.doesNotMatch(seeder, /redisDel\(\s*[\s\S]*OPENSKY_COOLDOWN_KEY/);
});
