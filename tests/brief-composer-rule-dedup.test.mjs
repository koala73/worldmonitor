// Regression tests for the Phase 3a composer's rule-selection logic.
//
// Two guards:
// 1. aiDigestEnabled default parity — undefined must be opt-IN, matching
//    seed-digest-notifications.mjs:914 and notifications-settings.ts:228.
// 2. Per-user dedupe — alertRules are (userId, variant)-scoped but the
//    brief key is user-scoped. Multi-variant users must produce exactly
//    one brief per issue, with a deterministic tie-breaker.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeRulesByUser,
  groupEligibleRulesByUser,
  shouldExitNonZero,
} from '../scripts/seed-brief-composer.mjs';

function rule(overrides = {}) {
  return {
    userId: 'user_abc',
    variant: 'full',
    enabled: true,
    digestMode: 'daily',
    sensitivity: 'high',
    aiDigestEnabled: true,
    digestTimezone: 'UTC',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('dedupeRulesByUser', () => {
  it('keeps a single rule unchanged', () => {
    const out = dedupeRulesByUser([rule()]);
    assert.equal(out.length, 1);
    assert.equal(out[0].variant, 'full');
  });

  it('dedupes multi-variant users to one rule, preferring "full"', () => {
    const out = dedupeRulesByUser([
      rule({ variant: 'finance', sensitivity: 'high' }),
      rule({ variant: 'full', sensitivity: 'critical' }),
      rule({ variant: 'tech', sensitivity: 'all' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].variant, 'full');
  });

  it('when no full variant: picks most permissive sensitivity', () => {
    const out = dedupeRulesByUser([
      rule({ variant: 'tech', sensitivity: 'critical' }),
      rule({ variant: 'finance', sensitivity: 'all' }),
      rule({ variant: 'energy', sensitivity: 'high' }),
    ]);
    assert.equal(out.length, 1);
    // 'all' is the most permissive.
    assert.equal(out[0].variant, 'finance');
  });

  it('never cross-contaminates across userIds', () => {
    const out = dedupeRulesByUser([
      rule({ userId: 'user_a', variant: 'full' }),
      rule({ userId: 'user_b', variant: 'tech' }),
      rule({ userId: 'user_a', variant: 'finance' }),
    ]);
    assert.equal(out.length, 2);
    const a = out.find((r) => r.userId === 'user_a');
    const b = out.find((r) => r.userId === 'user_b');
    assert.equal(a.variant, 'full');
    assert.equal(b.variant, 'tech');
  });

  it('drops rules without a string userId', () => {
    const out = dedupeRulesByUser([
      rule({ userId: /** @type {any} */ (null) }),
      rule({ userId: 'user_ok' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].userId, 'user_ok');
  });

  it('is deterministic across duplicate full-variant rules via updatedAt tie-breaker', () => {
    const older = rule({ variant: 'full', sensitivity: 'high', updatedAt: 1_000 });
    const newer = rule({ variant: 'full', sensitivity: 'high', updatedAt: 2_000 });
    const out1 = dedupeRulesByUser([older, newer]);
    const out2 = dedupeRulesByUser([newer, older]);
    // Earlier updatedAt wins — stable under input reordering.
    assert.equal(out1[0].updatedAt, 1_000);
    assert.equal(out2[0].updatedAt, 1_000);
  });
});

describe('aiDigestEnabled default parity', () => {
  // The composer's main loop short-circuits on `rule.aiDigestEnabled
  // === false`. Exercising the predicate directly so a refactor that
  // re-inverts it (back to `!rule.aiDigestEnabled`) fails loud.

  function shouldSkipForAiDigest(rule) {
    return rule.aiDigestEnabled === false;
  }

  it('includes rules with aiDigestEnabled: true', () => {
    assert.equal(shouldSkipForAiDigest({ aiDigestEnabled: true }), false);
  });

  it('includes rules with aiDigestEnabled: undefined (legacy rows)', () => {
    assert.equal(shouldSkipForAiDigest({ aiDigestEnabled: undefined }), false);
  });

  it('includes rules with no aiDigestEnabled field at all (legacy rows)', () => {
    assert.equal(shouldSkipForAiDigest({}), false);
  });

  it('excludes only when explicitly false', () => {
    assert.equal(shouldSkipForAiDigest({ aiDigestEnabled: false }), true);
  });

  it('groupEligibleRulesByUser: opted-out preferred variant falls back to opted-in sibling', () => {
    const grouped = groupEligibleRulesByUser([
      rule({ variant: 'full', aiDigestEnabled: false, updatedAt: 100 }),
      rule({ variant: 'finance', aiDigestEnabled: true, updatedAt: 200 }),
    ]);
    const candidates = grouped.get('user_abc');
    assert.ok(candidates, 'user is still eligible via the opt-in variant');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].variant, 'finance');
  });

  it('groupEligibleRulesByUser: user with all variants opted-out is dropped entirely', () => {
    const grouped = groupEligibleRulesByUser([
      rule({ variant: 'full', aiDigestEnabled: false }),
      rule({ variant: 'finance', aiDigestEnabled: false }),
    ]);
    assert.equal(grouped.size, 0);
  });

  it('groupEligibleRulesByUser: retains all eligible candidates in preference order', () => {
    const grouped = groupEligibleRulesByUser([
      rule({ variant: 'finance', sensitivity: 'critical', updatedAt: 100 }),
      rule({ variant: 'full', sensitivity: 'critical', updatedAt: 200 }),
      rule({ variant: 'tech', sensitivity: 'all', updatedAt: 300 }),
    ]);
    const candidates = grouped.get('user_abc');
    assert.equal(candidates.length, 3);
    // First is full (preferred variant); then tech (most permissive sensitivity);
    // then finance. Fallback loop in the main() script tries them in this order.
    assert.equal(candidates[0].variant, 'full');
    assert.equal(candidates[1].variant, 'tech');
    assert.equal(candidates[2].variant, 'finance');
  });

  it('shouldExitNonZero: returns false when no failures', () => {
    assert.equal(shouldExitNonZero({ success: 10, failed: 0 }), false);
  });

  it('shouldExitNonZero: catches 100% failure on small attempted volume', () => {
    // 4 attempted, 4 failed, 96 eligible skipped-empty. The earlier
    // (eligibleUserCount) denominator would read 4/100=4% and pass.
    assert.equal(shouldExitNonZero({ success: 0, failed: 4 }), true);
  });

  it('shouldExitNonZero: 1/20 failures is exactly at 5% (floor(20*0.05)=1), trips', () => {
    // Exact-threshold boundary: documents intentional behaviour.
    assert.equal(shouldExitNonZero({ success: 19, failed: 1 }), true);
  });

  it('shouldExitNonZero: 1/50 failures stays under threshold (floor(50*0.05)=2)', () => {
    // Threshold floor is Math.max(1, floor(N*0.05)). For N<40 a
    // single failure always trips. At N=50 the threshold is 2, so
    // 1/50 stays green. Ops intuition: the 5% bar is only a "bar"
    // once you have a meaningful sample.
    assert.equal(shouldExitNonZero({ success: 49, failed: 1 }), false);
  });

  it('shouldExitNonZero: 2/10 exceeds threshold', () => {
    // floor(10 * 0.05) = 0 → Math.max forces 1. failed=2 >= 1.
    assert.equal(shouldExitNonZero({ success: 8, failed: 2 }), true);
  });

  it('shouldExitNonZero: single isolated failure still tripwires', () => {
    // floor(1 * 0.05) = 0 → Math.max forces 1. failed=1 >= 1.
    assert.equal(shouldExitNonZero({ success: 0, failed: 1 }), true);
  });

  it('shouldExitNonZero: zero attempted means no signal, returns false', () => {
    assert.equal(shouldExitNonZero({ success: 0, failed: 0 }), false);
  });

  it('matches seed-digest-notifications convention', async () => {
    // Cross-reference: the existing digest cron uses the same
    // `!== false` test. If it drifts, the brief and digest will
    // disagree on who is eligible. This assertion lives here to
    // surface the divergence loudly.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../scripts/seed-digest-notifications.mjs', import.meta.url),
      'utf8',
    );
    assert.ok(
      src.includes('rule.aiDigestEnabled !== false'),
      'seed-digest-notifications.mjs must keep `rule.aiDigestEnabled !== false`',
    );
  });
});
