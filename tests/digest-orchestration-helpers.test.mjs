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
  digestWindowStartMs,
  pickWinningCandidateWithPool,
  readTimeAgeCutoffMs,
  runSynthesisWithFallback,
  shouldDropTrackByAge,
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

    const digestFor = async (c) => {
      if (c.rule === fullCritical) return [];  // empty pool
      if (c.rule === regionalHigh) return [{ hash: 'h2', title: 'Story from regional' }];
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

  it('passes the FULL annotated candidate to digestFor (not just the rule) so callers can derive a per-candidate window from cand.lastSentAt', async () => {
    // Regression guard for the canonical-vs-send window divergence.
    // digestFor needs lastSentAt to compute its windowStart via
    // digestWindowStartMs; passing only the rule strips that signal
    // and forces a fixed-24h fallback that the email/Slack body
    // doesn't honour.
    const dueRule = rule({ variant: 'full' });
    const passedArgs = [];
    const digestFor = async (cand) => { passedArgs.push(cand); return [{ hash: 'h' }]; };
    await pickWinningCandidateWithPool(
      [annotated(dueRule, true, 1_700_000_000_000)],
      digestFor,
      () => {},
      'u1',
    );
    assert.equal(passedArgs.length, 1);
    assert.equal(passedArgs[0].rule, dueRule);
    assert.equal(passedArgs[0].lastSentAt, 1_700_000_000_000);
    assert.equal(passedArgs[0].due, true);
  });

  it('walks past a filter-rejected top-priority candidate to a lower-priority candidate that composes successfully (Risk 2 regression guard)', async () => {
    // Pre-fix behaviour: helper returned the first NON-EMPTY pool as
    // winner. If composer then dropped every story (URL/headline/shape
    // filters), the caller bailed without trying lower-priority rules.
    // Fix: tryCompose callback lets the helper continue walking when
    // a candidate's pool survives buildDigest but compose returns null.
    const fullCritical = rule({ variant: 'full', sensitivity: 'critical', updatedAt: 100 });
    const regionalHigh = rule({ variant: 'regional', sensitivity: 'high', updatedAt: 50 });
    const annotatedList = [annotated(fullCritical, true), annotated(regionalHigh, true)];
    const digestFor = async () => [{ hash: 'h', title: 'pool member' }];
    // tryCompose: top candidate gets filtered to nothing (returns null);
    // lower-priority survives.
    const tryCompose = (cand) => {
      if (cand.rule === fullCritical) return null;        // simulate URL/headline filter dropping all
      if (cand.rule === regionalHigh) return { envelope: 'ok' };
      return null;
    };
    const lines = [];
    const result = await pickWinningCandidateWithPool(
      annotatedList,
      digestFor,
      (l) => lines.push(l),
      'u1',
      tryCompose,
    );
    assert.ok(result, 'lower-priority candidate must still win after top-priority filter-rejection');
    assert.equal(result.winner.rule, regionalHigh);
    assert.deepEqual(result.composeResult, { envelope: 'ok' });
    assert.ok(
      lines.some((l) => l.includes('outcome=filter-rejected') && l.includes('variant=full')),
      'filter-rejected line must be logged for the skipped top candidate',
    );
  });

  it('returns null when EVERY candidate is rejected by tryCompose (no fallthrough has a survivor)', async () => {
    const a = rule({ variant: 'a' });
    const b = rule({ variant: 'b' });
    const annotatedList = [annotated(a, true), annotated(b, true)];
    const digestFor = async () => [{ hash: 'h' }];
    const tryCompose = () => null;  // nothing ever composes
    const result = await pickWinningCandidateWithPool(
      annotatedList,
      digestFor,
      () => {},
      'u1',
      tryCompose,
    );
    assert.equal(result, null);
  });

  it('forwards tryCompose return value as composeResult on success (lets caller skip a redundant compose call)', async () => {
    const r = rule({ variant: 'full' });
    const composedEnvelope = { data: { stories: [{ hash: 'h' }] } };
    const result = await pickWinningCandidateWithPool(
      [annotated(r, true)],
      async () => [{ hash: 'h' }],
      () => {},
      'u1',
      () => composedEnvelope,
    );
    assert.ok(result);
    assert.equal(result.composeResult, composedEnvelope);
  });

  it('without tryCompose, preserves legacy "first non-empty pool wins" semantics (existing callers/tests unaffected)', async () => {
    const r = rule({ variant: 'full' });
    const result = await pickWinningCandidateWithPool(
      [annotated(r, true)],
      async () => [{ hash: 'h' }],
      () => {},
      'u1',
      // no tryCompose
    );
    assert.ok(result);
    assert.equal(result.winner.rule, r);
    assert.equal(result.composeResult, undefined);
  });
});

// ── digestWindowStartMs — Risk 1 (canonical vs send window parity) ────────

describe('digestWindowStartMs — single source of truth for compose + send window', () => {
  it('returns lastSentAt verbatim when present (rule has shipped before)', () => {
    const lastSentAt = 1_700_000_000_000;
    assert.equal(digestWindowStartMs(lastSentAt, 1_700_086_400_000, 24 * 60 * 60 * 1000), lastSentAt);
  });

  it('falls back to nowMs - defaultLookbackMs when lastSentAt is null (first send)', () => {
    const nowMs = 1_700_086_400_000;
    const lookback = 24 * 60 * 60 * 1000;
    assert.equal(digestWindowStartMs(null, nowMs, lookback), nowMs - lookback);
  });

  it('falls back when lastSentAt is undefined', () => {
    const nowMs = 1_700_086_400_000;
    const lookback = 24 * 60 * 60 * 1000;
    assert.equal(digestWindowStartMs(undefined, nowMs, lookback), nowMs - lookback);
  });

  it('weekly user (lastSentAt = 7d ago) → window covers exactly the prior 7d', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const nowMs = 2_000_000_000_000;
    const lastSentAt = nowMs - sevenDaysMs;
    const windowStart = digestWindowStartMs(lastSentAt, nowMs, 24 * 60 * 60 * 1000);
    // The compose-path brief lead and the send-loop email body both
    // call buildDigest(rule, windowStart) with this same value, so a
    // weekly user's lead now summarizes the same 7-day pool that
    // ships in the email body. Pre-fix, the lead came from a 24h pool
    // while the email shipped 7d.
    assert.equal(windowStart, lastSentAt);
    assert.equal(nowMs - windowStart, sevenDaysMs);
  });

  it('twice-daily user (lastSentAt = 12h ago) → 12h window matches what ships', () => {
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const nowMs = 2_000_000_000_000;
    const lastSentAt = nowMs - twelveHoursMs;
    const windowStart = digestWindowStartMs(lastSentAt, nowMs, 24 * 60 * 60 * 1000);
    assert.equal(windowStart, lastSentAt);
    assert.equal(nowMs - windowStart, twelveHoursMs);
  });

  it('zero is a valid lastSentAt (epoch — exotic but legal); does not fall through to default', () => {
    // ?? operator is explicit about this; guards against regressions
    // toward `||` which would treat 0 as missing.
    const nowMs = 1_700_000_000_000;
    assert.equal(digestWindowStartMs(0, nowMs, 24 * 60 * 60 * 1000), 0);
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

// ── readTimeAgeCutoffMs / shouldDropTrackByAge — buildDigest READ-time floor ──

describe('readTimeAgeCutoffMs — window-aware cutoff', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('daily user (24h window) → 48h-ago cutoff', () => {
    const now = Date.UTC(2026, 3, 26, 8, 0, 0);
    const windowStart = now - 1 * DAY;
    const cutoff = readTimeAgeCutoffMs(windowStart);
    // Cutoff = windowStart - 24h buffer = now - 48h
    assert.equal(now - cutoff, 2 * DAY);
  });

  it('weekly user (7d window) → 8d-ago cutoff', () => {
    const now = Date.UTC(2026, 3, 26, 8, 0, 0);
    const windowStart = now - 7 * DAY;
    const cutoff = readTimeAgeCutoffMs(windowStart);
    assert.equal(now - cutoff, 8 * DAY);
  });

  it('twice-daily user (12h window) → 36h-ago cutoff', () => {
    const now = Date.UTC(2026, 3, 26, 8, 0, 0);
    const windowStart = now - 12 * HOUR;
    const cutoff = readTimeAgeCutoffMs(windowStart);
    assert.equal(now - cutoff, 36 * HOUR);
  });
});

describe('shouldDropTrackByAge — predicate matrix', () => {
  const cutoff = Date.UTC(2026, 3, 24, 0, 0, 0); // arbitrary fixed cutoff

  it('drops row with publishedAt strictly before cutoff', () => {
    assert.equal(
      shouldDropTrackByAge({ publishedAt: String(cutoff - 1) }, cutoff),
      true,
    );
  });

  it('keeps row with publishedAt exactly at cutoff (>= boundary)', () => {
    assert.equal(
      shouldDropTrackByAge({ publishedAt: String(cutoff) }, cutoff),
      false,
    );
  });

  it('keeps row with publishedAt after cutoff', () => {
    assert.equal(
      shouldDropTrackByAge({ publishedAt: String(cutoff + 1) }, cutoff),
      false,
    );
  });

  it('keeps row with missing publishedAt (legacy back-compat)', () => {
    assert.equal(shouldDropTrackByAge({}, cutoff), false);
  });

  it('keeps row with empty-string publishedAt (defensive write from non-finite item)', () => {
    assert.equal(shouldDropTrackByAge({ publishedAt: '' }, cutoff), false);
  });

  it('keeps row with unparseable publishedAt (e.g. literal "undefined")', () => {
    assert.equal(shouldDropTrackByAge({ publishedAt: 'undefined' }, cutoff), false);
  });

  it('keeps row with zero or negative publishedAt (sentinel guard)', () => {
    assert.equal(shouldDropTrackByAge({ publishedAt: '0' }, cutoff), false);
    assert.equal(shouldDropTrackByAge({ publishedAt: '-1' }, cutoff), false);
  });

  it('handles null/undefined track defensively', () => {
    assert.equal(shouldDropTrackByAge(null, cutoff), false);
    assert.equal(shouldDropTrackByAge(undefined, cutoff), false);
  });

  it('integration: weekly user with 5d-old story is KEPT (window-aware vs naive 48h)', () => {
    // Regression guard against the pre-fix behavior where the floor was a
    // hardcoded 48h. A weekly user's 5-day-old story SHOULD survive because
    // it's well within their 7d digest window.
    const now = Date.UTC(2026, 3, 26, 8, 0, 0);
    const weeklyWindowStart = now - 7 * 24 * 60 * 60 * 1000;
    const weeklyCutoff = readTimeAgeCutoffMs(weeklyWindowStart); // = now - 8d
    const fiveDaysAgo = now - 5 * 24 * 60 * 60 * 1000;
    assert.equal(
      shouldDropTrackByAge({ publishedAt: String(fiveDaysAgo) }, weeklyCutoff),
      false,
      '5d-old story must survive a weekly user\'s window — naive 48h would have dropped it',
    );
  });

  it('integration: residue case (4-month-old Pentagon item) is dropped for daily user', () => {
    const now = Date.UTC(2026, 3, 26, 8, 0, 0);
    const dailyWindowStart = now - 24 * 60 * 60 * 1000;
    const dailyCutoff = readTimeAgeCutoffMs(dailyWindowStart); // = now - 48h
    const fourMonthsAgo = Date.UTC(2026, 0, 9, 0, 0, 0); // 2026-01-09
    assert.equal(
      shouldDropTrackByAge({ publishedAt: String(fourMonthsAgo) }, dailyCutoff),
      true,
      'Months-old residue with a real publishedAt must be dropped',
    );
  });
});
