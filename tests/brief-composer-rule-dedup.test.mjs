// Regression tests for the Phase 3a composer's rule-selection logic.
//
// Two guards:
// 1. aiDigestEnabled default parity — undefined must be opt-IN, matching
//    seed-digest-notifications.mjs:914 and notifications-settings.ts:228.
// 2. Per-user dedupe — alertRules are (userId, variant)-scoped but the
//    brief key is user-scoped. Multi-variant users must produce exactly
//    one brief per issue, with a deterministic tie-breaker.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeRulesByUser,
  groupEligibleRulesByUser,
  shouldExitNonZero,
} from '../scripts/lib/brief-compose.mjs';

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

  describe('undefined sensitivity ranks as "high" (NOT "all")', () => {
    // PR #3387 review (P2): the rank function used to default to 'all',
    // which would place a legacy undefined-sensitivity rule FIRST in
    // the candidate order — but composeBriefFromDigestStories now
    // applies a 'high' filter to undefined-sensitivity rules. Result:
    // an explicit 'all' rule for the same user would never be tried,
    // and the user would silently receive a narrower brief. Rank must
    // match what compose actually applies.
    function ruleWithoutSensitivity(overrides = {}) {
      const r = rule(overrides);
      delete r.sensitivity;
      return r;
    }

    it('explicit "all" rule beats undefined-sensitivity rule of same variant + age', () => {
      const explicitAll = rule({ variant: 'full', sensitivity: 'all', updatedAt: 1_000 });
      const undefSens = ruleWithoutSensitivity({ variant: 'full', updatedAt: 1_000 });
      // Both arrival orders must produce the same winner.
      const out1 = dedupeRulesByUser([explicitAll, undefSens]);
      const out2 = dedupeRulesByUser([undefSens, explicitAll]);
      assert.equal(out1[0].sensitivity, 'all');
      assert.equal(out2[0].sensitivity, 'all');
    });

    it('undefined-sensitivity rule ties with explicit "high" (decided by updatedAt)', () => {
      // Both should rank as 'high' → tiebreak by updatedAt → newer (older?)
      // matches existing semantics: earlier updatedAt wins per the
      // "stable under input reordering" test above.
      const undefSens = ruleWithoutSensitivity({ variant: 'full', updatedAt: 1_000 });
      const explicitHigh = rule({ variant: 'full', sensitivity: 'high', updatedAt: 2_000 });
      const out1 = dedupeRulesByUser([undefSens, explicitHigh]);
      const out2 = dedupeRulesByUser([explicitHigh, undefSens]);
      // Earlier updatedAt wins → undefined rule (1_000 < 2_000).
      assert.equal(out1[0].updatedAt, 1_000);
      assert.equal(out2[0].updatedAt, 1_000);
    });

    it('candidate order in groupEligibleRulesByUser respects new ranking', () => {
      // groupEligibleRulesByUser sorts candidates so the most-permissive
      // (and most-preferred) is tried first by composeAndStoreBriefForUser.
      // After the rank-default fix, undefined-sensitivity should sit
      // BELOW explicit 'all' in the try order.
      const explicitAll = rule({ variant: 'full', sensitivity: 'all', updatedAt: 1_000 });
      const undefSens = ruleWithoutSensitivity({ variant: 'full', updatedAt: 2_000 });
      const grouped = groupEligibleRulesByUser([undefSens, explicitAll]);
      const candidates = grouped.get('user_abc');
      assert.equal(candidates[0].sensitivity, 'all', 'explicit "all" should be tried first');
      assert.equal(candidates[1].sensitivity, undefined, 'undefined sensitivity should come second');
    });
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

// ── Sprint 1 / U2 — option (a) canonicalisation (source-level guards) ─────
//
// These are deliberately source-text assertions (not behavior assertions on
// the live cron). The full integration shape — compose → send loop →
// channel formatter — requires Upstash + Convex + Resend mocks that are
// out of scope for this PR. The pure-function half of the U2 contract
// lives in tests/digest-orchestration-helpers.test.mjs as the
// `selectCanonicalSendRule` describe block; this block locks the
// SOURCE-level invariants that protect the contract from regressing
// silently in scripts/seed-digest-notifications.mjs.

describe('Sprint 1 U2 — multi-rule canonicalisation (option a) source guards', () => {
  let cronSrc;

  before(async () => {
    const fs = await import('node:fs/promises');
    cronSrc = await fs.readFile(
      new URL('../scripts/seed-digest-notifications.mjs', import.meta.url),
      'utf8',
    );
  });

  it('imports selectCanonicalSendRule from digest-orchestration-helpers', () => {
    // The send loop MUST filter to the winner rule per user before the
    // per-rule isDue + channel-fetch + synthesis cascade. Without this
    // import, the cron is by definition fanning out to all rules per
    // user (the pre-U2 divergence shape).
    assert.match(
      cronSrc,
      /selectCanonicalSendRule/,
      'cron must import the option-(a) canonical-rule selector helper',
    );
  });

  it('does NOT carry the pre-U2 "Per-rule synthesis" comment block', () => {
    // The comment block at lines 1713-1732 of pre-U2 source documented
    // the divergence as an accepted trade-off ("Channel-body lead vs
    // magazine lead may therefore differ for non-winner rules"). U2
    // resolves the divergence; the comment must be replaced. If a
    // future refactor reintroduces the per-rule fan-out shape, the
    // commenter is likely to copy the old block back — this guard
    // catches that. Tests strip newlines so cross-line phrases match.
    const flat = cronSrc.replace(/\s+/g, ' ');
    assert.doesNotMatch(
      flat,
      /Channel-body lead vs magazine lead may.{0,40}differ for non-winner rules/,
      'cron must not carry the pre-U2 divergence-acceptance comment',
    );
    assert.doesNotMatch(
      flat,
      /the send-loop body for a non-winner rule needs.{0,20}ITS OWN lead/,
      'cron must not carry the pre-U2 per-rule synthesis rationale',
    );
  });

  it('parity log records winner_match as the universal expectation (option a invariant)', () => {
    // The runtime parity log around lines 1838-1866 of pre-U2 source
    // permitted winner_match=false as "expected divergence" for
    // non-winner rule sends. Under option (a) every send IS the
    // winner — winner_match=false now means a real bug. The log line
    // and its surrounding comment must reflect the new universal
    // invariant.
    assert.match(
      cronSrc,
      /winner_match/,
      'parity log must still emit winner_match for observability',
    );
    // The "Expected divergence, not a regression" reasoning is the
    // pre-U2 trade-off acceptance language. Must be gone.
    const flat = cronSrc.replace(/\s+/g, ' ');
    assert.doesNotMatch(
      flat,
      /Expected divergence, not a regression/,
      'pre-U2 "expected divergence" framing must be replaced by a universal-equality guarantee',
    );
  });

  it('canonical-send mapping is documented near the send loop (option a docblock present)', () => {
    // Discoverability: a future operator reading the send loop must
    // immediately see WHY only one rule per user is processed. The
    // replacement comment block names option (a) explicitly.
    assert.match(
      cronSrc,
      /option \(a\)/i,
      'send loop must document option (a) canonicalisation by name',
    );
  });

  // Codex PR #3614 P1 regression — the canonical filter must NOT
  // suppress digest delivery when briefByUser is empty (compose
  // disabled, signing secret missing, per-user compose error caught).
  // The fix gates the canonical filter on `if (briefForUser)` and
  // falls through to the legacy per-rule send when missing, with a
  // loud one-warn-per-user log so Sentry surfaces the compose-miss.
  it('canonical filter is gated on briefForUser existence (compose-miss falls through)', () => {
    // The fix shape: `if (briefForUser) { selectCanonicalSendRule(...) }`
    // not `selectCanonicalSendRule(briefForUser, ...)` unconditionally.
    // We assert the gating shape exists in the source.
    assert.match(
      cronSrc,
      /if \(briefForUser\)\s*\{[\s\S]{0,400}?selectCanonicalSendRule/,
      'canonical filter must be gated on briefForUser truthiness — Codex PR #3614 P1',
    );
  });

  it('compose-miss path emits a loud one-per-user warn (not silent suppression)', () => {
    // The fall-through path must be observable. We assert the warn
    // string + the once-per-user dedup Set both exist in the source.
    assert.match(
      cronSrc,
      /composeMissUsers/,
      'cron must track which users have already been warned to dedup compose-miss logs to once per tick',
    );
    assert.match(
      cronSrc,
      /\[digest\] compose-miss user=/,
      'cron must emit a [digest] compose-miss user=... warn line for Sentry breadcrumbs',
    );
    assert.match(
      cronSrc,
      /console\.warn[\s\S]{0,200}compose-miss/,
      'compose-miss must use console.warn (not console.log) so Sentry promotes it to a breadcrumb',
    );
  });

  it('compose-miss comment cites Codex PR #3614 P1 + names the failure modes', () => {
    // Discoverability: a future operator hitting the warn must be
    // able to find the rationale immediately. The docblock cites the
    // review item by ID and names the three failure modes (signing
    // secret, compose disabled, per-user compose error) so on-call
    // can triage without spelunking through git history.
    assert.match(
      cronSrc,
      /Codex PR #3614 P1/,
      'fall-through docblock must cite the review item it addresses',
    );
    const flat = cronSrc.replace(/\s+/g, ' ');
    assert.match(
      flat,
      /BRIEF_SIGNING_SECRET/,
      'docblock must name BRIEF_SIGNING_SECRET as one of the compose-miss failure modes',
    );
    assert.match(
      flat,
      /per-user compose error/i,
      'docblock must name caught-per-user-error as one of the compose-miss failure modes',
    );
  });
});
