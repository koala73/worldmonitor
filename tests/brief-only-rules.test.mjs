// Paid users with no digest rule get a default in-app brief (2026-10-27: the
// owner's Latest Brief panel said "composing" all day because no rule existed).
// The default rule must compose like a real one, never count as due (so it
// reuses prose instead of paying for a synthesis every 30-min tick), and never
// shadow a user who already has rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildBriefOnlyRules, briefCandidateDue, groupEligibleRulesByUser, rotateBriefOnlyRules } from '../scripts/lib/brief-compose.mjs';

describe('rotateBriefOnlyRules', () => {
  const rules = ['a', 'b', 'c', 'd', 'e'].map((userId) => ({ userId }));
  const TICK = 30 * 60 * 1000;

  it('keeps every rule exactly once', () => {
    const out = rotateBriefOnlyRules(rules, 7 * TICK);
    assert.deepEqual([...out.map((r) => r.userId)].sort(), ['a', 'b', 'c', 'd', 'e']);
  });

  // The default-brief pass runs under a time budget; a fixed order would
  // starve the users at the tail every tick. Consecutive ticks start at
  // different users so each one is reached within a few ticks.
  it('starts consecutive ticks at different users and reaches every user first', () => {
    const firsts = new Set();
    for (let tick = 0; tick < rules.length; tick++) firsts.add(rotateBriefOnlyRules(rules, tick * TICK)[0].userId);
    assert.equal(firsts.size, rules.length);
  });

  it('returns the input for zero or one rule', () => {
    assert.deepEqual(rotateBriefOnlyRules([], TICK), []);
    assert.deepEqual(rotateBriefOnlyRules([{ userId: 'a' }], TICK), [{ userId: 'a' }]);
  });
});

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
