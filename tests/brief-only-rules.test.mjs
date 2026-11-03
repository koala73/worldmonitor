// Paid users with no digest rule get a default in-app brief (2026-10-27: the
// owner's Latest Brief panel said "composing" all day because no rule existed).
// The default rule must compose like a real one, never count as due (so it
// reuses prose instead of paying for a synthesis every 30-min tick), and never
// shadow a user who already has rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  briefComposeTimesFromPointerCells,
  buildBriefOnlyRules,
  briefCandidateDue,
  groupEligibleRulesByUser,
  orderBriefOnlyRulesByStaleness,
} from '../scripts/lib/brief-compose.mjs';

// The pass orders by each user's last compose time, read from the
// brief:latest pointer. Not synthesizedAt: a compose that reuses prose keeps
// the old synthesizedAt, so warm users would stay "stalest" and take the
// budget every tick (#9759 review).
describe('briefComposeTimesFromPointerCells', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const cell = (ptr) => ({ result: JSON.stringify(ptr) });

  it('reads composedAt from each pointer', () => {
    const out = briefComposeTimesFromPointerCells(ids, [
      cell({ issueSlot: '2026-10-27-2000', synthesizedAt: 1, composedAt: 50 }),
      cell({ issueSlot: '2026-10-27-2000', composedAt: 40 }),
      cell({ issueSlot: '2026-10-27-2000', composedAt: 30 }),
      cell({ issueSlot: '2026-10-27-2000', composedAt: 20 }),
    ]);
    assert.deepEqual([...out.entries()], [['a', 50], ['b', 40], ['c', 30], ['d', 20]]);
  });

  it('leaves out missing, legacy (no composedAt) and malformed pointers, which order first', () => {
    const out = briefComposeTimesFromPointerCells(ids, [
      { result: null },
      cell({ issueSlot: '2026-10-27-2000', synthesizedAt: 99 }),
      { result: '{not json' },
      cell({ issueSlot: '2026-10-27-2000', composedAt: 7 }),
    ]);
    assert.deepEqual([...out.entries()], [['d', 7]]);
  });

  it('returns null when any read failed or the pipeline failed, so the caller keeps Convex order', () => {
    assert.equal(briefComposeTimesFromPointerCells(ids, [cell({ composedAt: 1 }), { error: 'ERR' }, { result: null }, { result: null }]), null);
    assert.equal(briefComposeTimesFromPointerCells(ids, null), null);
    assert.equal(briefComposeTimesFromPointerCells(ids, [{ result: null }]), null);
  });
});

// The default-brief pass runs under a time budget. The first production run
// (2026-10-27 20:01Z) composed 99 of 251 users and deferred 152; a rotation
// that shifts the start by one user per tick would recompose nearly the same
// 99 every tick and leave the rest without a brief for days. Ordering by
// staleness reaches every deferred user on the next ticks.
describe('orderBriefOnlyRulesByStaleness', () => {
  const rules = ['a', 'b', 'c', 'd'].map((userId) => ({ userId }));

  it('puts users with no brief first, then the oldest synthesis', () => {
    const out = orderBriefOnlyRulesByStaleness(rules, new Map([['a', 300], ['b', 100], ['d', 200]]));
    assert.deepEqual(out.map((r) => r.userId), ['c', 'b', 'd', 'a']);
  });

  it('treats a missing or non-numeric time as no brief', () => {
    const out = orderBriefOnlyRulesByStaleness(rules, new Map([['a', 5], ['b', 'x'], ['c', null]]));
    assert.deepEqual(out.map((r) => r.userId), ['b', 'c', 'd', 'a']);
  });

  // Every compose (fresh or reused prose) stamps composedAt, so a warm pass
  // keeps cycling through everyone instead of re-picking the same users.
  it('a warm, budget-limited pass keeps cycling: every user is recomposed within ceil(n/k) ticks', () => {
    const n = 251;
    const k = 99;
    const all = Array.from({ length: n }, (_, i) => ({ userId: `u${i}` }));
    const composedAt = new Map(all.map((r, i) => [r.userId, i])); // all warm
    const lastSeen = new Map();
    for (let tick = 1; tick <= 6; tick++) {
      for (const r of orderBriefOnlyRulesByStaleness(all, composedAt).slice(0, k)) {
        composedAt.set(r.userId, 1_000 + tick);
        lastSeen.set(r.userId, tick);
      }
    }
    for (const r of all) assert.ok(6 - (lastSeen.get(r.userId) ?? -99) < Math.ceil(n / k), `${r.userId} starved`);
  });

  it('a budget that covers k users per tick reaches all n users in ceil(n/k) ticks', () => {
    const n = 251;
    const k = 99;
    const all = Array.from({ length: n }, (_, i) => ({ userId: `u${i}` }));
    const synthesizedAt = new Map();
    let tick = 0;
    while (all.some((r) => !synthesizedAt.has(r.userId)) && tick < 10) {
      tick++;
      for (const r of orderBriefOnlyRulesByStaleness(all, synthesizedAt).slice(0, k)) synthesizedAt.set(r.userId, tick);
    }
    assert.equal(tick, Math.ceil(n / k));
  });

  it('does not mutate its input', () => {
    const input = [...rules];
    orderBriefOnlyRulesByStaleness(input, new Map([['d', 1]]));
    assert.deepEqual(input, rules);
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
