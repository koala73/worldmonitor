/**
 * Regression tests for `scripts/lib/digest-only-user.mjs`.
 *
 * The DIGEST_ONLY_USER flag was flagged in review as a sticky
 * production footgun: if an operator set it for a one-off validation
 * and forgot to unset, the cron would silently filter every other user
 * out indefinitely while still completing normally (exit 0), creating
 * a prolonged partial outage with "green" runs.
 *
 * The mitigation is a mandatory `|until=<ISO8601>` suffix within a 48h
 * hard cap. These tests pin the parser's accept/reject boundary so a
 * future "helpful" refactor that reverses any of these rules fails
 * loudly in CI rather than silently in prod.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIGEST_ONLY_USER_MAX_HORIZON_MS,
  parseDigestOnlyUser,
} from '../scripts/lib/digest-only-user.mjs';

// Fixed "now" for deterministic tests. 2026-04-21 18:00Z is a realistic
// Railway-set clock during a test session.
const NOW = Date.parse('2026-04-21T18:00:00Z');

describe('parseDigestOnlyUser — kind:unset', () => {
  it('empty string → unset', () => {
    assert.deepEqual(parseDigestOnlyUser('', NOW), { kind: 'unset' });
  });
  it('non-string → unset', () => {
    assert.deepEqual(parseDigestOnlyUser(undefined, NOW), { kind: 'unset' });
    assert.deepEqual(parseDigestOnlyUser(null, NOW), { kind: 'unset' });
    assert.deepEqual(parseDigestOnlyUser(123, NOW), { kind: 'unset' });
  });
});

describe('parseDigestOnlyUser — kind:reject (prevents sticky footgun)', () => {
  it('rejects the legacy bare-userId format from PR #3255', () => {
    const out = parseDigestOnlyUser('user_3BovQ1tYlaz2YIGYAdDPXGFBgKy', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /missing mandatory "\|until=<ISO8601>" suffix/);
  });

  it('rejects pipe with no suffix', () => {
    const out = parseDigestOnlyUser('user_xxx|', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /suffix must be "until=<ISO8601>"/);
  });

  it('rejects suffix that is not "until="', () => {
    const out = parseDigestOnlyUser('user_xxx|expires=2026-04-22T18:00Z', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /suffix must be "until=<ISO8601>"/);
  });

  it('rejects garbage in the ISO8601 slot', () => {
    const out = parseDigestOnlyUser('user_xxx|until=NOT-A-DATE', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /not a parseable ISO8601/);
  });

  it('rejects empty userId before pipe', () => {
    const out = parseDigestOnlyUser('|until=2026-04-22T18:00Z', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /empty userId before "\|"/);
  });

  it('rejects expiry in the past (auto-disable)', () => {
    const out = parseDigestOnlyUser('user_xxx|until=2026-04-20T18:00Z', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /is in the past/);
  });

  it('rejects expiry exactly equal to now (strict future requirement)', () => {
    const out = parseDigestOnlyUser(`user_xxx|until=${new Date(NOW).toISOString()}`, NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /is in the past/);
  });

  it('rejects expiry more than 48h in the future (hard cap)', () => {
    const beyondHorizon = new Date(NOW + DIGEST_ONLY_USER_MAX_HORIZON_MS + 60_000).toISOString();
    const out = parseDigestOnlyUser(`user_xxx|until=${beyondHorizon}`, NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /exceeds the 48h hard cap/);
  });

  it('rejects expiry a year out (the classic forever-test mistake)', () => {
    const out = parseDigestOnlyUser('user_xxx|until=2027-04-21T18:00Z', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /exceeds the 48h hard cap/);
  });

  it('rejects multiple pipes with a SPECIFIC reason (not the misleading "missing suffix")', () => {
    // Regression pin: earlier the reason incorrectly pointed the
    // operator toward adding a suffix that was already present.
    const out = parseDigestOnlyUser('user_xxx|until=2026-04-22T18:00Z|extra', NOW);
    assert.equal(out.kind, 'reject');
    assert.match(out.reason, /expected exactly one "\|" separator, got 2/);
    assert.doesNotMatch(out.reason, /missing mandatory/);
  });

  it('rejects non-ISO8601 formats that V8 Date.parse would accept', () => {
    // V8's Date.parse is lenient (RFC 2822, locale-formatted, etc.).
    // The documented contract is strict ISO 8601 — enforce by shape,
    // not just by the 48h cap catching a random valid date.
    const cases = [
      'April 22, 2026 18:00',
      '22 Apr 2026 18:00:00 GMT',
      '04/22/2026',
      '2026/04/22 18:00',
      'tomorrow',
      '1717200000',           // numeric epoch, accepted by some parsers
    ];
    for (const c of cases) {
      const out = parseDigestOnlyUser(`user_xxx|until=${c}`, NOW);
      assert.equal(out.kind, 'reject', `should reject non-ISO "${c}"`);
      assert.match(out.reason, /not a parseable ISO8601 timestamp/);
    }
  });
});

describe('parseDigestOnlyUser — kind:active (valid path)', () => {
  it('accepts an expiry 30 min in the future', () => {
    const until = new Date(NOW + 30 * 60_000).toISOString();
    const out = parseDigestOnlyUser(`user_3Bo|until=${until}`, NOW);
    assert.equal(out.kind, 'active');
    if (out.kind === 'active') {
      assert.equal(out.userId, 'user_3Bo');
      assert.equal(out.untilMs, Date.parse(until));
    }
  });

  it('accepts an expiry at the 48h boundary (inclusive)', () => {
    const until = new Date(NOW + DIGEST_ONLY_USER_MAX_HORIZON_MS).toISOString();
    const out = parseDigestOnlyUser(`user_xxx|until=${until}`, NOW);
    assert.equal(out.kind, 'active');
  });

  it('accepts all three ISO8601 flavors the spec permits', () => {
    const expires = NOW + 60 * 60_000; // +1h
    // Node's Date.parse is lenient; cover the Railway-friendly variants
    // operators are likely to type.
    const variants = [
      new Date(expires).toISOString(),                 // 2026-04-21T19:00:00.000Z
      new Date(expires).toISOString().replace('.000', ''), // 2026-04-21T19:00:00Z
      new Date(expires).toISOString().slice(0, 16) + 'Z',  // 2026-04-21T19:00Z
    ];
    for (const v of variants) {
      const out = parseDigestOnlyUser(`user_xxx|until=${v}`, NOW);
      assert.equal(out.kind, 'active', `should parse ISO variant: ${v}`);
    }
  });

  it('tolerates surrounding whitespace inside the pipe-split parts', () => {
    const until = new Date(NOW + 60 * 60_000).toISOString();
    const out = parseDigestOnlyUser(`  user_xxx | until=${until}  `, NOW);
    // Note: the outer trim is done by the caller; we test post-trim semantics.
    // Parser still splits on '|' and trims each part, so inner whitespace tolerates.
    assert.equal(out.kind, 'active');
    if (out.kind === 'active') assert.equal(out.userId, 'user_xxx');
  });
});

describe('DIGEST_ONLY_USER_MAX_HORIZON_MS', () => {
  it('is exactly 48 hours', () => {
    assert.equal(DIGEST_ONLY_USER_MAX_HORIZON_MS, 48 * 60 * 60 * 1000);
  });
});
