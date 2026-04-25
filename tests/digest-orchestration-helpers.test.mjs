// Pure-function unit tests for the canonical-synthesis orchestration
// helpers extracted from scripts/seed-digest-notifications.mjs.
//
// Covers plan acceptance criteria:
//   A6.h — three-level synthesis fallback chain
//   A6.i — subject-line correctness ("Intelligence Brief" vs "Digest")
//   A6.l — compose-only tick still works for weekly user (sortedAll fallback)
//   A6.m — winner walks past empty-pool top-priority candidate
//
// Acceptance criteria A6.a-d (multi-rule, twice_daily, weekly window
// parity, all-channel reads) require a full mock of the cron's main()
// loop with Upstash + Convex stubs — out of scope for this PR's
// pure-function coverage. They are exercised via the parity log line
// (A5) in production observability instead.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickWinningCandidateWithPool,
  runSynthesisWithFallback,
  subjectForBrief,
} from '../scripts/lib/digest-orchestration-helpers.mjs';

// ── subjectForBrief — A6.i ────────────────────────────────────────────────

describe('subjectForBrief — synthesis-level → email subject', () => {
  it('synthesis level 1 + non-empty briefLead → Intelligence Brief', () => {
    assert.equal(
      subjectForBrief({ briefLead: 'A real lead', synthesisLevel: 1, shortDate: 'Apr 25' }),
      'WorldMonitor Intelligence Brief — Apr 25',
    );
  });

  it('synthesis level 2 + non-empty briefLead → Intelligence Brief (L2 still editorial)', () => {
    assert.equal(
      subjectForBrief({ briefLead: 'A degraded lead', synthesisLevel: 2, shortDate: 'Apr 25' }),
      'WorldMonitor Intelligence Brief — Apr 25',
    );
  });

  it('synthesis level 3 → Digest (stub fallback ships less editorial subject)', () => {
    assert.equal(
      subjectForBrief({ briefLead: 'a stub', synthesisLevel: 3, shortDate: 'Apr 25' }),
      'WorldMonitor Digest — Apr 25',
    );
  });

  it('null briefLead → Digest regardless of level (no signal for editorial subject)', () => {
    assert.equal(
      subjectForBrief({ briefLead: null, synthesisLevel: 1, shortDate: 'Apr 25' }),
      'WorldMonitor Digest — Apr 25',
    );
  });

  it('empty-string briefLead → Digest', () => {
    assert.equal(
      subjectForBrief({ briefLead: '', synthesisLevel: 1, shortDate: 'Apr 25' }),
      'WorldMonitor Digest — Apr 25',
    );
  });
});

// ── pickWinningCandidateWithPool — A6.l + A6.m ────────────────────────────

function rule(overrides) {
  return {
    userId: 'u1',
    variant: 'full',
    sensitivity: 'all',
    aiDigestEnabled: true,
    updatedAt: 1,
    ...overrides,
  };
}

function annotated(rule, due, lastSentAt = null) {
  return { rule, lastSentAt, due };
}

describe('pickWinningCandidateWithPool — winner walk', () => {
  it('A6.l — picks ANY eligible rule when none are due (compose-only tick)', async () => {
    // Weekly user on a non-due tick: no rules due, but the dashboard
    // contract says we still compose a brief from the user's
    // preferred rule. sortedAll fallback covers this.
    const weeklyRule = rule({ variant: 'full', digestMode: 'weekly' });
    const annotatedList = [annotated(weeklyRule, false)];
    const digestFor = async () => [{ hash: 'h1', title: 'A story' }];
    const lines = [];
    const result = await pickWinningCandidateWithPool(
      annotatedList,
      digestFor,
      (l) => lines.push(l),
      'u1',
    );
    assert.ok(result, 'compose-only tick must still pick a winner');
    assert.equal(result.winner.rule, weeklyRule);
    assert.equal(result.winner.due, false);
    assert.equal(result.stories.length, 1);
  });

  it('A6.m — walks past empty-pool top-priority due rule to lower-priority due rule with stories', async () => {
    // A user with two due rules: full:critical (top priority by
    // compareRules) has empty pool; regional:high (lower priority)
    // has stories. Winner must be regional:high — not null.
    const fullCritical = rule({ variant: 'full', sensitivity: 'critical', updatedAt: 100 });
    const regionalHigh = rule({ variant: 'regional', sensitivity: 'high', updatedAt: 50 });
    const annotatedList = [annotated(fullCritical, true), annotated(regionalHigh, true)];

    const digestFor = async (r) => {
      if (r === fullCritical) return [];  // empty pool
      if (r === regionalHigh) return [{ hash: 'h2', title: 'Story from regional' }];
      return [];
    };
    const lines = [];
    const result = await pickWinningCandidateWithPool(
      annotatedList,
      digestFor,
      (l) => lines.push(l),
      'u1',
    );
    assert.ok(result, 'lower-priority candidate with stories must still win');
    assert.equal(result.winner.rule, regionalHigh);
    // Empty-pool log emitted for the skipped top-priority candidate
    assert.ok(
      lines.some((l) => l.includes('outcome=empty-pool') && l.includes('variant=full')),
      'empty-pool line must be logged for the skipped candidate',
    );
  });

  it('prefers DUE rules over not-due rules even when not-due is higher priority', async () => {
    // Higher-priority rule isn't due; lower-priority rule IS due.
    // Plan rule: pick from due candidates first. Codex Round-3 High #1.
    const higherPriorityNotDue = rule({ variant: 'full', sensitivity: 'critical', updatedAt: 100 });
    const lowerPriorityDue = rule({ variant: 'regional', sensitivity: 'high', updatedAt: 50 });
    const annotatedList = [
      annotated(higherPriorityNotDue, false),  // higher priority, NOT due
      annotated(lowerPriorityDue, true),       // lower priority, DUE
    ];
    const digestFor = async () => [{ hash: 'h', title: 'X' }];
    const result = await pickWinningCandidateWithPool(
      annotatedList,
      digestFor,
      () => {},
      'u1',
    );
    assert.ok(result);
    assert.equal(result.winner.rule, lowerPriorityDue, 'due rule wins over higher-priority not-due');
  });

  it('returns null when EVERY candidate has an empty pool', async () => {
    const annotatedList = [annotated(rule({ variant: 'a' }), true), annotated(rule({ variant: 'b' }), false)];
    const digestFor = async () => [];
    const result = await pickWinningCandidateWithPool(
      annotatedList,
      digestFor,
      () => {},
      'u1',
    );
    assert.equal(result, null);
  });

  it('returns null on empty annotated list (no rules for user)', async () => {
    const result = await pickWinningCandidateWithPool([], async () => [{ hash: 'h' }], () => {}, 'u1');
    assert.equal(result, null);
  });

  it('does not call digestFor twice for the same rule (dedup across passes)', async () => {
    // A rule that's due appears in BOTH sortedDue and sortedAll —
    // walk must dedupe so digestFor (Upstash GET) only fires once.
    const dueRule = rule({ variant: 'full' });
    const annotatedList = [annotated(dueRule, true)];
    let calls = 0;
    const digestFor = async () => { calls++; return [{ hash: 'h' }]; };
    await pickWinningCandidateWithPool(annotatedList, digestFor, () => {}, 'u1');
    assert.equal(calls, 1, 'same rule must not be tried twice');
  });
});

// ── runSynthesisWithFallback — A6.h ───────────────────────────────────────

const validProse = {
  lead: 'A long-enough executive lead about Hormuz and the Gaza humanitarian crisis, written in editorial tone.',
  threads: [{ tag: 'Energy', teaser: 'Hormuz tensions resurface today.' }],
  signals: ['Watch for naval redeployment.'],
};

function makeDeps(callLLM) {
  const cache = new Map();
  return {
    callLLM,
    cacheGet: async (k) => cache.has(k) ? cache.get(k) : null,
    cacheSet: async (k, v) => { cache.set(k, v); },
  };
}

describe('runSynthesisWithFallback — three-level chain', () => {
  it('L1 success — canonical synthesis returned, level=1', async () => {
    const deps = makeDeps(async () => JSON.stringify(validProse));
    const trace = [];
    const result = await runSynthesisWithFallback(
      'u1',
      [{ hash: 'h1', headline: 'Story 1', threatLevel: 'critical' }],
      'all',
      { profile: 'Watching: oil', greeting: 'Good morning' },
      deps,
      (level, kind) => trace.push({ level, kind }),
    );
    assert.ok(result.synthesis);
    assert.equal(result.level, 1);
    assert.match(result.synthesis.lead, /editorial tone/);
    assert.deepEqual(trace, [{ level: 1, kind: 'success' }]);
  });

  it('L1 LLM down → L2 succeeds, level=2', async () => {
    // Note: generateDigestProse internally absorbs callLLM throws and
    // returns null (its return-null-on-failure contract). So
    // runSynthesisWithFallback sees the L1 attempt as a "fall" event,
    // not a "throw". Test verifies the BEHAVIOR (L2 wins) rather than
    // the trace event kind.
    let firstCall = true;
    const deps = makeDeps(async () => {
      if (firstCall) { firstCall = false; throw new Error('L1 LLM down'); }
      return JSON.stringify(validProse);
    });
    const trace = [];
    const result = await runSynthesisWithFallback(
      'u1',
      [{ hash: 'h1', headline: 'Story 1', threatLevel: 'critical' }],
      'all',
      { profile: 'Watching: oil', greeting: 'Good morning' },
      deps,
      (level, kind) => trace.push({ level, kind }),
    );
    assert.ok(result.synthesis);
    assert.equal(result.level, 2);
    // Trace: L1 fell (callLLM throw absorbed → null), L2 succeeded.
    assert.equal(trace[0].level, 1);
    assert.equal(trace[0].kind, 'fall');
    assert.equal(trace[1].level, 2);
    assert.equal(trace[1].kind, 'success');
  });

  it('L1 returns null + L2 returns null → L3 stub, level=3', async () => {
    const deps = makeDeps(async () => null);  // both calls return null
    const trace = [];
    const result = await runSynthesisWithFallback(
      'u1',
      [{ hash: 'h1', headline: 'Story 1', threatLevel: 'critical' }],
      'all',
      { profile: null, greeting: null },
      deps,
      (level, kind) => trace.push({ level, kind }),
    );
    assert.equal(result.synthesis, null);
    assert.equal(result.level, 3);
    // Trace shows L1 fell, L2 fell, L3 success (synthesis=null is the
    // stub path's contract).
    assert.deepEqual(trace.map((t) => `${t.level}:${t.kind}`), [
      '1:fall',
      '2:fall',
      '3:success',
    ]);
  });

  it('cache.cacheGet throws — generateDigestProse swallows it, L1 still succeeds via LLM call', async () => {
    // generateDigestProse's cache try/catch catches ALL throws (not
    // just misses), so a cache-layer outage falls through to a fresh
    // LLM call and returns successfully. Documented contract: cache
    // is best-effort. This test locks the contract — if a future
    // refactor narrows the catch, fallback semantics change.
    const deps = {
      callLLM: async () => JSON.stringify(validProse),
      cacheGet: async () => { throw new Error('cache outage'); },
      cacheSet: async () => {},
    };
    const result = await runSynthesisWithFallback(
      'u1',
      [{ hash: 'h1', headline: 'Story 1', threatLevel: 'critical' }],
      'all',
      { profile: null, greeting: null },
      deps,
    );
    assert.ok(result.synthesis);
    assert.equal(result.level, 1);
  });

  it('callLLM down on every call → L3 stub, no exception escapes', async () => {
    const deps = makeDeps(async () => { throw new Error('LLM totally down'); });
    const result = await runSynthesisWithFallback(
      'u1',
      [{ hash: 'h1', headline: 'Story 1', threatLevel: 'critical' }],
      'all',
      { profile: null, greeting: null },
      deps,
    );
    // generateDigestProse absorbs each callLLM throw → returns null;
    // fallback chain reaches L3 stub. The brief still ships.
    assert.equal(result.synthesis, null);
    assert.equal(result.level, 3);
  });

  it('omits trace callback safely (defensive — production callers may not pass one)', async () => {
    const deps = makeDeps(async () => JSON.stringify(validProse));
    // No trace argument
    const result = await runSynthesisWithFallback(
      'u1',
      [{ hash: 'h1', headline: 'Story 1', threatLevel: 'critical' }],
      'all',
      { profile: null, greeting: null },
      deps,
    );
    assert.equal(result.level, 1);
    assert.ok(result.synthesis);
  });
});
