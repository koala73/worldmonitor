import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

const {
  HEALTH_VERDICT_SNAPSHOT_KEY,
  HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY,
  buildCompactVerdictSnapshot,
  healthResponseBody,
  parseHealthVerdictSnapshot,
} = __testing__;

const CHECKED_AT = '2026-07-14T00:00:00.000Z';

/** A verdict shaped like production: a few hundred checks, a handful of problems. */
function fullVerdict(checkCount = 228, problemCount = 5) {
  const checks = {};
  for (let i = 0; i < checkCount - problemCount; i++) {
    checks[`ok_key_${i}`] = { status: 'OK', records: 1234, seedAgeMin: 3 };
  }
  for (let i = 0; i < problemCount; i++) {
    checks[`bad_key_${i}`] = { status: 'STALE_SEED', records: 0, seedAgeMin: 900 };
  }
  return {
    status: 'WARNING',
    summary: { total: checkCount, ok: checkCount - problemCount, warn: problemCount, crit: 0 },
    checkedAt: CHECKED_AT,
    checks,
  };
}

test('the two snapshot keys are distinct', () => {
  assert.notEqual(HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY, HEALTH_VERDICT_SNAPSHOT_KEY);
  assert.match(HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY, /health:verdict:compact:v1$/);
});

// THE POINT OF THE CHANGE. ?compact=1 is the browser poll — every client, every 5
// minutes, ~115k/day. It used to drag the full ~20 KB check map out of Redis to
// render ~1 KB of it: ~2.2 GB/day of egress for bytes the caller discards (#5300).
test('the compact snapshot is a fraction of the full one', () => {
  const full = fullVerdict();
  const compact = buildCompactVerdictSnapshot(full);

  const fullBytes = JSON.stringify(full).length;
  const compactBytes = JSON.stringify(compact).length;

  assert.ok(
    compactBytes < fullBytes / 10,
    `compact snapshot must be an order of magnitude smaller (full ${fullBytes} B, compact ${compactBytes} B)`,
  );
  assert.equal(compact.checks, undefined, 'the compact snapshot must not carry the check map — that omission IS the saving');
});

test('the stored compact snapshot is exactly the body a compact request returns', () => {
  const full = fullVerdict();
  // Derived from the same renderer, so the cached form cannot drift from the live
  // form — and re-rendering a compact snapshot is a no-op.
  assert.deepEqual(buildCompactVerdictSnapshot(full), healthResponseBody(full, true));
  assert.deepEqual(healthResponseBody(buildCompactVerdictSnapshot(full), true), healthResponseBody(full, true));
});

test('a compact response reports the same verdict and problems as the full one', () => {
  const full = fullVerdict();
  const fromFull = healthResponseBody(full, true);
  const fromCompact = healthResponseBody(buildCompactVerdictSnapshot(full), true);

  assert.equal(fromCompact.status, full.status);
  assert.deepEqual(fromCompact.summary, full.summary);
  assert.equal(fromCompact.checkedAt, full.checkedAt);
  assert.deepEqual(Object.keys(fromCompact.problems ?? {}).sort(), Object.keys(fromFull.problems ?? {}).sort());
  // Every problem is carried in full — operators still see records/seedAgeMin.
  for (const [name, check] of Object.entries(fromFull.problems ?? {})) {
    assert.deepEqual(fromCompact.problems[name], check);
  }
});

test('an all-healthy verdict omits `problems` entirely', () => {
  const healthy = { status: 'HEALTHY', summary: { total: 2, ok: 2 }, checkedAt: CHECKED_AT, checks: { a: { status: 'OK' }, b: { status: 'OK_CASCADE' } } };
  const compact = buildCompactVerdictSnapshot(healthy);
  assert.equal(compact.problems, undefined);
  assert.equal(healthResponseBody(compact, true).problems, undefined);
});

// The parse contract. The full snapshot MUST carry `checks` — a truncated write
// would otherwise be served as a valid verdict. The compact one must not.
test('parse requires `checks` on the full snapshot but not the compact one', () => {
  const now = Date.parse(CHECKED_AT) + 1_000;
  const full = fullVerdict();
  const compact = buildCompactVerdictSnapshot(full);

  assert.ok(parseHealthVerdictSnapshot(JSON.stringify(full), now));
  assert.ok(parseHealthVerdictSnapshot(JSON.stringify(compact), now, { requireChecks: false }));

  // A compact snapshot must NOT satisfy a full (operator) read.
  assert.equal(parseHealthVerdictSnapshot(JSON.stringify(compact), now), null);
  // Junk is still rejected on both paths.
  for (const bad of ['', 'not-json', JSON.stringify({ status: 'OK' })]) {
    assert.equal(parseHealthVerdictSnapshot(bad, now, { requireChecks: false }), null);
  }
});

test('a stale snapshot is rejected regardless of shape', () => {
  const full = fullVerdict();
  const compact = buildCompactVerdictSnapshot(full);
  const wayLater = Date.parse(CHECKED_AT) + 10 * 60 * 1000; // past the 60s TTL

  assert.equal(parseHealthVerdictSnapshot(JSON.stringify(full), wayLater), null);
  assert.equal(parseHealthVerdictSnapshot(JSON.stringify(compact), wayLater, { requireChecks: false }), null);
});
