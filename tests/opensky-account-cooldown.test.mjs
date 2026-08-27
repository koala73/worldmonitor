import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const {
  OPENSKY_COOLDOWN_KEY,
  OPENSKY_MAX_COOLDOWN_MS,
  accountFingerprint,
  clampCooldownMs,
  ttlSecondsForCooldown,
  inspectCooldownRecord,
  buildCooldownRecord,
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
});
