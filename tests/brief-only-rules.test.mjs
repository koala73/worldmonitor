// Paid users with no digest rule get a default in-app brief (2026-10-27: the
// owner's Latest Brief panel said "composing" all day because no rule existed).
// The default rule must compose like a real one, never count as due (so it
// reuses prose instead of paying for a synthesis every 30-min tick), and never
// shadow a user who already has rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildBriefOnlyRules, briefCandidateDue, groupEligibleRulesByUser } from '../scripts/lib/brief-compose.mjs';

describe('buildBriefOnlyRules', () => {
  it('builds one full/high/daily in-app rule per user, with no channels', () => {
    const [rule] = buildBriefOnlyRules(['user_a'], []);
    assert.deepEqual(rule, {
      userId: 'user_a',
      variant: 'full',
      enabled: true,
      digestMode: 'daily',
      sensitivity: 'high',
      aiDigestEnabled: true,
      channels: [],
      eventTypes: [],
      updatedAt: 0,
      briefOnly: true,
    });
  });

  it('skips users who already have a digest rule, non-string ids, and duplicates', () => {
    const rules = buildBriefOnlyRules(['user_a', 'user_b', 'user_a', 7, ''], [{ userId: 'user_b', variant: 'full' }]);
    assert.deepEqual(rules.map((r) => r.userId), ['user_a']);
  });

  it('tolerates a non-array response', () => {
    assert.deepEqual(buildBriefOnlyRules(null, []), []);
    assert.deepEqual(buildBriefOnlyRules({ error: 'x' }, []), []);
  });

  it('is eligible for compose like any other rule', () => {
    const byUser = groupEligibleRulesByUser(buildBriefOnlyRules(['user_a'], []));
    assert.equal(byUser.get('user_a')?.length, 1);
  });
});

describe('briefCandidateDue', () => {
  it('never marks a brief-only rule due, so its prose is reused between ticks', () => {
    let called = false;
    const due = briefCandidateDue({ userId: 'u', briefOnly: true }, null, () => { called = true; return true; });
    assert.equal(due, false);
    assert.equal(called, false);
  });

  it('defers to isDue for real rules', () => {
    assert.equal(briefCandidateDue({ userId: 'u' }, 5, (_r, last) => last === 5), true);
    assert.equal(briefCandidateDue({ userId: 'u' }, 5, () => false), false);
  });
});
