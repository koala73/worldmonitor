// Sprint 1 / U6 — replay harness tests. Exercises the pure aggregator
// against synthetic fixture timelines; the live-Redis IO path is
// intentionally out of scope (the CLI wrapper requires the real Upstash
// REST endpoint and 14 days of accumulated replay-log records, which
// the test env doesn't have).
//
// The aggregator's contract: simulate cooldown decisions across all
// (ruleId, clusterId) timelines, return histogram counts that match
// the U5 decision module's behavior. If U5 changes the cooldown table
// or reasons, these tests catch the drift via the histogram keys.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateReplayDecisions,
  clusterIdFromRecord,
  parseArgs,
  renderMarkdownSummary,
} from '../scripts/replay-digest-cooldown.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_777_000_000_000; // start of synthetic 14-day window

/** Helper: build a replay-log record with sane defaults. */
function rec(overrides = {}) {
  return {
    storyHash: 'h-default',
    isRep: true,
    mergedHashes: ['h-default'],
    currentScore: 50,
    mentionCount: 1,
    sources: ['Reuters'],
    severity: 'high',
    headline: 'Generic headline',
    sourceUrl: 'https://example.com/x',
    phase: 'sustained',
    ruleId: 'full:en:high',
    tsMs: T0,
    ...overrides,
  };
}

describe('clusterIdFromRecord', () => {
  // Codex PR #3617 P1 — v2 records carry repHash on every record;
  // collapse non-rep records by repHash so the U6 timeline aggregation
  // doesn't split a multi-story cluster across its members.
  it('v2: uses repHash when present (canonical cluster identity)', () => {
    assert.equal(
      clusterIdFromRecord({ storyHash: 'h-x', repHash: 'rep-a', mergedHashes: null }),
      'rep-a',
      'non-rep record should resolve to its rep via repHash',
    );
  });

  it('v2: rep record with repHash + mergedHashes resolves to repHash', () => {
    assert.equal(
      clusterIdFromRecord({ storyHash: 'rep-a', repHash: 'rep-a', mergedHashes: ['rep-a', 'h-x'] }),
      'rep-a',
    );
  });

  it('v1 fallback: uses mergedHashes[0] when present (legacy v1 records still in 30d TTL)', () => {
    assert.equal(clusterIdFromRecord(rec({ storyHash: 'h-x', mergedHashes: ['rep-a', 'h-x'] })), 'rep-a');
  });

  it('v1 fallback: falls back to storyHash when both repHash and mergedHashes are absent', () => {
    assert.equal(clusterIdFromRecord(rec({ storyHash: 'h-singleton', mergedHashes: [] })), 'h-singleton');
  });

  it('returns empty string when all three identity sources are missing (caller filters)', () => {
    assert.equal(clusterIdFromRecord({ tsMs: T0, ruleId: 'r' }), '');
  });
});

describe('headline / sourceUrl reader (Codex PR #3617 P1 v2 alias compat)', () => {
  it('v2 record with sourceUrl: classifier sees the URL via recordSourceUrl path', () => {
    // Indirect test via the aggregator — pass a v2-shaped record where
    // sourceUrl is set but link is absent; expect classifyStub to see
    // the host and route it correctly.
    const records = [
      rec({ storyHash: 'h-1', mergedHashes: ['h-1'], repHash: 'h-1', sourceUrl: 'https://www.usni.org/2026/foo', link: undefined, severity: 'high', tsMs: T0 }),
      rec({ storyHash: 'h-1', mergedHashes: ['h-1'], repHash: 'h-1', sourceUrl: 'https://www.usni.org/2026/foo', link: undefined, severity: 'high', tsMs: T0 + 6 * DAY_MS }),
      rec({ storyHash: 'h-pad', mergedHashes: ['h-pad'], repHash: 'h-pad', tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    // www.usni.org should classify as analysis (Codex PR #3617 P2 fix)
    // and the 6-day re-air sits inside the 7-day hard floor → suppress.
    assert.equal(agg.suppressDecisions, 1);
    assert.equal(agg.reasonHistogram['analysis_7d_hard'], 1);
  });

  it('v1 record with link: harness still reads it via legacy fallback', () => {
    // Pre-Codex-P1 records carry `link` not `sourceUrl`. The harness
    // must still consume them so the 30-day TTL window doesn't get
    // truncated when v2 ships.
    const records = [
      // No `repHash` (v1), no `sourceUrl` (v1) — only legacy fields.
      { storyHash: 'h-x', mergedHashes: ['h-x'], link: 'https://www.usni.org/2026/foo', severity: 'high', ruleId: 'full:en:high', tsMs: T0 },
      { storyHash: 'h-x', mergedHashes: ['h-x'], link: 'https://www.usni.org/2026/foo', severity: 'high', ruleId: 'full:en:high', tsMs: T0 + 6 * DAY_MS },
      { storyHash: 'h-pad', mergedHashes: ['h-pad'], ruleId: 'full:en:high', tsMs: T0 + 14 * DAY_MS },
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    // v1 fallback path still produces the same analysis-domain
    // classification via the link → sourceUrl alias.
    assert.equal(agg.reasonHistogram['analysis_7d_hard'], 1);
  });
});

describe('aggregateReplayDecisions — coverage gate', () => {
  it('throws on empty input (flag may be off)', () => {
    assert.throws(
      () => aggregateReplayDecisions([], { minDaysCovered: 14 }),
      /DIGEST_DEDUP_REPLAY_LOG may be off/,
    );
  });

  it('throws when coverage < minDaysCovered (default 14d)', () => {
    const records = [
      rec({ tsMs: T0 }),
      rec({ tsMs: T0 + 5 * DAY_MS }), // only 5 days of coverage
    ];
    assert.throws(
      () => aggregateReplayDecisions(records, { minDaysCovered: 14 }),
      /coverage 5\.\d+ days < required 14/,
    );
  });

  it('passes the coverage gate when allowShortCoverage=true (test escape hatch)', () => {
    const records = [
      rec({ tsMs: T0 }),
      rec({ tsMs: T0 + 5 * DAY_MS, storyHash: 'h-2', mergedHashes: ['h-2'] }),
    ];
    const agg = aggregateReplayDecisions(records, {
      minDaysCovered: 14,
      allowShortCoverage: true,
    });
    assert.equal(agg.totalRecords, 2);
  });

  it('passes when coverage meets minDaysCovered', () => {
    const records = [
      rec({ tsMs: T0 }),
      rec({ tsMs: T0 + 14 * DAY_MS, storyHash: 'h-2', mergedHashes: ['h-2'] }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.ok(agg.coverage.daysCovered >= 14);
  });
});

describe('aggregateReplayDecisions — single-occurrence timelines (no decision)', () => {
  it('skips timelines with only one occurrence (no cooldown to evaluate)', () => {
    const records = [
      rec({ storyHash: 'h-1', mergedHashes: ['h-1'], tsMs: T0 }),
      rec({ storyHash: 'h-2', mergedHashes: ['h-2'], tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.totalTimelines, 2);
    assert.equal(agg.totalDecisions, 0);
    assert.equal(agg.dropRatePct, 0);
  });
});

describe('aggregateReplayDecisions — multi-occurrence timelines simulate cooldown', () => {
  it('within-floor re-occurrence on a soft type → suppress decision recorded', () => {
    // Two occurrences of the same cluster within the high-event 18h floor,
    // no source-count evolution. Expect: 1 decision, suppress.
    const records = [
      rec({ storyHash: 'h-x', mergedHashes: ['h-x'], severity: 'high', tsMs: T0 }),
      rec({ storyHash: 'h-x', mergedHashes: ['h-x'], severity: 'high', tsMs: T0 + 6 * HOUR_MS }),
      // Second cluster present so the coverage gate passes (2 records over 14d wouldn't satisfy).
      rec({ storyHash: 'h-y', mergedHashes: ['h-y'], severity: 'high', tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.totalDecisions, 1);
    assert.equal(agg.suppressDecisions, 1);
    assert.equal(agg.allowDecisions, 0);
    assert.equal(agg.dropRatePct, 100);
    assert.ok(agg.reasonHistogram['cooldown_floor'] >= 1);
  });

  it('beyond-floor re-occurrence → allow decision recorded', () => {
    const records = [
      rec({ storyHash: 'h-x', mergedHashes: ['h-x'], severity: 'high', tsMs: T0 }),
      rec({ storyHash: 'h-x', mergedHashes: ['h-x'], severity: 'high', tsMs: T0 + 24 * HOUR_MS }), // > 18h floor
      rec({ storyHash: 'h-y', mergedHashes: ['h-y'], severity: 'high', tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.allowDecisions, 1);
    assert.equal(agg.suppressDecisions, 0);
  });

  it('+5 sources within floor → allow / evolution_source_count', () => {
    const records = [
      rec({ storyHash: 'h-x', mergedHashes: ['h-x'], severity: 'high', sources: ['Reuters', 'AP'], tsMs: T0 }), // 2 sources
      rec({ storyHash: 'h-x', mergedHashes: ['h-x'], severity: 'high', sources: ['Reuters', 'AP', 'BBC', 'CNN', 'NPR', 'France 24', 'Al Jazeera'], tsMs: T0 + 6 * HOUR_MS }), // 7 sources, +5
      rec({ storyHash: 'h-y', mergedHashes: ['h-y'], severity: 'high', tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.allowDecisions, 1);
    assert.equal(agg.reasonHistogram['evolution_source_count'], 1);
  });

  it('Analysis domain hard floor: 6d re-air → suppress / analysis_7d_hard', () => {
    const records = [
      rec({ storyHash: 'h-a', mergedHashes: ['h-a'], severity: 'high', sourceUrl: 'https://usni.org/article-x', tsMs: T0 }),
      rec({ storyHash: 'h-a', mergedHashes: ['h-a'], severity: 'high', sourceUrl: 'https://usni.org/article-x', tsMs: T0 + 6 * DAY_MS }),
      rec({ storyHash: 'h-y', mergedHashes: ['h-y'], severity: 'high', tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.suppressDecisions, 1);
    assert.equal(agg.reasonHistogram['analysis_7d_hard'], 1);
    assert.ok(agg.typeHistogram['analysis'] >= 1);
  });

  it('aggregates across multiple distinct timelines independently', () => {
    const records = [
      // Timeline 1: cluster A, 2 occurrences within floor → 1 suppress
      rec({ storyHash: 'h-a', mergedHashes: ['h-a'], severity: 'high', tsMs: T0 }),
      rec({ storyHash: 'h-a', mergedHashes: ['h-a'], severity: 'high', tsMs: T0 + 4 * HOUR_MS }),
      // Timeline 2: cluster B, 2 occurrences beyond floor → 1 allow
      rec({ storyHash: 'h-b', mergedHashes: ['h-b'], severity: 'high', tsMs: T0 + 1 * DAY_MS }),
      rec({ storyHash: 'h-b', mergedHashes: ['h-b'], severity: 'high', tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.totalDecisions, 2);
    assert.equal(agg.suppressDecisions, 1);
    assert.equal(agg.allowDecisions, 1);
    assert.equal(agg.dropRatePct, 50);
  });
});

describe('aggregateReplayDecisions — coverage report shape', () => {
  it('reports startDate, endDate, daysCovered, distinctRuleIds', () => {
    const records = [
      rec({ ruleId: 'full:en:high', tsMs: T0 }),
      rec({ ruleId: 'finance:en:high', storyHash: 'h-2', mergedHashes: ['h-2'], tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.coverage.startDate, new Date(T0).toISOString().slice(0, 10));
    assert.equal(agg.coverage.endDate, new Date(T0 + 14 * DAY_MS).toISOString().slice(0, 10));
    assert.ok(agg.coverage.daysCovered >= 14);
    assert.equal(agg.coverage.distinctRuleIds, 2);
  });
});

describe('aggregateReplayDecisions — Codex PR #3617 round-3 P1 collapse', () => {
  // The replay-log writer emits ONE record per input story (rep + each
  // non-rep member), so a 2-story cluster in one tick yields 2 records
  // at the same tsMs. Pre-fix the harness treated each as a separate
  // occurrence — the second record (same tsMs) saw the first as
  // `lastDeliveredAt` and produced a false 0-hour repeat suppression.
  // Post-fix the harness collapses to one observation per
  // (ruleId, repHash, tsMs).
  it('multi-member cluster in one tick → ONE observation, NOT a 0-hour repeat (suppress)', () => {
    const records = [
      // Tick 1 — cluster {h-rep, h-mem1, h-mem2}, all at the same tsMs.
      { storyHash: 'h-rep', repHash: 'h-rep', mergedHashes: ['h-rep', 'h-mem1', 'h-mem2'], isRep: true,
        severity: 'high', sources: ['A','B','C'], ruleId: 'full:en:high', tsMs: T0 },
      { storyHash: 'h-mem1', repHash: 'h-rep', isRep: false,
        severity: 'high', sources: ['A','B','C'], ruleId: 'full:en:high', tsMs: T0 },
      { storyHash: 'h-mem2', repHash: 'h-rep', isRep: false,
        severity: 'high', sources: ['A','B','C'], ruleId: 'full:en:high', tsMs: T0 },
      // Padding for coverage gate.
      { storyHash: 'h-pad', repHash: 'h-pad', isRep: true, severity: 'high',
        sources: [], ruleId: 'full:en:high', tsMs: T0 + 14 * DAY_MS },
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    // Pre-fix: 3 records at T0 → 1 timeline with 3 records → 2
    // synthetic suppress decisions (cooldown_floor at 0h elapsed).
    // Post-fix: collapses to 1 record at T0 → 1 timeline with 1 record
    // → no decision (single-occurrence timelines are skipped).
    assert.equal(agg.totalDecisions, 0, 'multi-member in one tick must not produce false repeat decisions');
    assert.equal(agg.suppressDecisions, 0);
    assert.equal(agg.dropRatePct, 0);
  });

  it('genuine multi-tick cluster timeline still simulates correctly after collapse', () => {
    const records = [
      // Tick 1: 2-member cluster.
      { storyHash: 'h-rep', repHash: 'h-rep', mergedHashes: ['h-rep', 'h-mem'], isRep: true,
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 },
      { storyHash: 'h-mem', repHash: 'h-rep', isRep: false,
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 },
      // Tick 2: same cluster re-airs 6h later (within 18h floor, no evolution).
      { storyHash: 'h-rep', repHash: 'h-rep', mergedHashes: ['h-rep', 'h-mem'], isRep: true,
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 + 6 * HOUR_MS },
      { storyHash: 'h-mem', repHash: 'h-rep', isRep: false,
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 + 6 * HOUR_MS },
      // Padding.
      { storyHash: 'h-pad', repHash: 'h-pad', isRep: true, severity: 'high',
        sources: [], ruleId: 'full:en:high', tsMs: T0 + 14 * DAY_MS },
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    // After collapse: tick-1 (1 record) + tick-2 (1 record) = 1
    // legitimate within-floor re-air = 1 suppress decision (high-event
    // 18h floor).
    assert.equal(agg.totalDecisions, 1);
    assert.equal(agg.suppressDecisions, 1);
    assert.equal(agg.allowDecisions, 0);
  });

  it('rep record wins over non-rep when collapsing — uses canonical headline/sourceUrl', () => {
    // Two records at the same (ruleId, repHash, tsMs). Verify the rep
    // is the one preserved (it carries the canonical view; non-reps
    // may have nulled-out fields).
    const records = [
      { storyHash: 'h-mem', repHash: 'h-rep', isRep: false, sourceUrl: 'https://reuters.com/x',
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 },
      { storyHash: 'h-rep', repHash: 'h-rep', mergedHashes: ['h-rep', 'h-mem'], isRep: true,
        sourceUrl: 'https://www.usni.org/article', // analysis domain
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 },
      // Re-air 6 days later (within 7d analysis hard floor).
      { storyHash: 'h-rep', repHash: 'h-rep', mergedHashes: ['h-rep'], isRep: true,
        sourceUrl: 'https://www.usni.org/article',
        severity: 'high', sources: ['A','B'], ruleId: 'full:en:high', tsMs: T0 + 6 * DAY_MS },
      { storyHash: 'h-pad', repHash: 'h-pad', isRep: true, severity: 'high',
        sources: [], ruleId: 'full:en:high', tsMs: T0 + 14 * DAY_MS },
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    // The collapsed first-tick record must carry the rep's USNI URL
    // (analysis domain) so the classifier routes correctly to the 7d
    // hard floor. If the non-rep record won the collapse, the
    // sourceUrl would be reuters.com and the classifier would route to
    // high-event (18h soft floor) — the 6d re-air would then be allow
    // (beyond floor) instead of suppress (within hard floor).
    assert.equal(agg.suppressDecisions, 1);
    assert.equal(agg.reasonHistogram['analysis_7d_hard'], 1);
  });
});

describe('aggregateReplayDecisions — top-suppressed timelines', () => {
  it('reports top-10 timelines sorted by suppress count', () => {
    // Build 3 timelines with different suppress counts (3, 2, 1).
    const records = [];
    for (let i = 0; i < 4; i += 1) { // timeline A: 1 first + 3 suppresses
      records.push(rec({ storyHash: 'h-a', mergedHashes: ['h-a'], tsMs: T0 + i * HOUR_MS }));
    }
    for (let i = 0; i < 3; i += 1) { // timeline B: 1 first + 2 suppresses
      records.push(rec({ storyHash: 'h-b', mergedHashes: ['h-b'], tsMs: T0 + i * HOUR_MS }));
    }
    for (let i = 0; i < 2; i += 1) { // timeline C: 1 first + 1 suppress
      records.push(rec({ storyHash: 'h-c', mergedHashes: ['h-c'], tsMs: T0 + i * HOUR_MS }));
    }
    // Coverage padding
    records.push(rec({ storyHash: 'h-pad', mergedHashes: ['h-pad'], tsMs: T0 + 14 * DAY_MS }));

    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.topSuppressed.length, 3);
    assert.equal(agg.topSuppressed[0].clusterId, 'h-a');
    assert.equal(agg.topSuppressed[0].suppressCount, 3);
    assert.equal(agg.topSuppressed[1].clusterId, 'h-b');
    assert.equal(agg.topSuppressed[2].clusterId, 'h-c');
  });

  it('omits never-suppressed timelines from the top list', () => {
    const records = [
      rec({ storyHash: 'h-allow', mergedHashes: ['h-allow'], severity: 'high', tsMs: T0 }),
      rec({ storyHash: 'h-allow', mergedHashes: ['h-allow'], severity: 'high', tsMs: T0 + 24 * HOUR_MS }), // beyond 18h floor → allow
      rec({ storyHash: 'h-pad', mergedHashes: ['h-pad'], tsMs: T0 + 14 * DAY_MS }),
    ];
    const agg = aggregateReplayDecisions(records, { minDaysCovered: 14 });
    assert.equal(agg.topSuppressed.length, 0);
  });
});

describe('renderMarkdownSummary', () => {
  it('produces a paste-ready markdown block with all key sections', () => {
    const agg = {
      totalRecords: 100,
      totalTimelines: 30,
      totalDecisions: 25,
      allowDecisions: 17,
      suppressDecisions: 8,
      dropRatePct: 32,
      reasonHistogram: { cooldown_floor: 6, evolution_source_count: 2 },
      typeHistogram: { 'high-event': 20, 'critical-developing': 5 },
      severityHistogram: { high: 80, critical: 20 },
      topSuppressed: [
        { clusterId: 'cluster-abc-123-def-456', ruleId: 'full:en:high', suppressCount: 3, allowCount: 0, reasons: { cooldown_floor: 3 } },
      ],
      coverage: { startDate: '2026-05-06', endDate: '2026-05-20', daysCovered: 14, distinctRuleIds: 1 },
    };
    const md = renderMarkdownSummary(agg);
    assert.match(md, /Sprint 1 \/ U6 replay results/);
    assert.match(md, /Drop-rate.*32%/);
    assert.match(md, /Reason histogram/);
    assert.match(md, /Type histogram/);
    assert.match(md, /Top-10 most-suppressed/);
    assert.match(md, /full:en:high/);
  });

  it('reports "no suppression" when topSuppressed is empty', () => {
    const agg = {
      totalRecords: 10,
      totalTimelines: 5,
      totalDecisions: 5,
      allowDecisions: 5,
      suppressDecisions: 0,
      dropRatePct: 0,
      reasonHistogram: { cooldown_floor: 5 },
      typeHistogram: { 'high-event': 5 },
      severityHistogram: { high: 10 },
      topSuppressed: [],
      coverage: { startDate: '2026-05-06', endDate: '2026-05-20', daysCovered: 14, distinctRuleIds: 1 },
    };
    const md = renderMarkdownSummary(agg);
    assert.match(md, /No timelines triggered suppression in this window/);
  });
});

describe('parseArgs', () => {
  it('defaults to 14 days, no rule filter', () => {
    const args = parseArgs(['node', 'replay-digest-cooldown.mjs']);
    assert.equal(args.days, 14);
    assert.equal(args.rule, null);
    assert.equal(args.allowShortCoverage, false);
    assert.equal(args.help, false);
  });

  it('parses --days N', () => {
    const args = parseArgs(['node', 'r.mjs', '--days', '30']);
    assert.equal(args.days, 30);
  });

  it('parses --rule <ruleId>', () => {
    const args = parseArgs(['node', 'r.mjs', '--rule', 'full:en:high']);
    assert.equal(args.rule, 'full:en:high');
  });

  it('parses --allow-short-coverage', () => {
    const args = parseArgs(['node', 'r.mjs', '--allow-short-coverage']);
    assert.equal(args.allowShortCoverage, true);
  });

  it('parses --help / -h', () => {
    assert.equal(parseArgs(['node', 'r.mjs', '--help']).help, true);
    assert.equal(parseArgs(['node', 'r.mjs', '-h']).help, true);
  });

  it('throws on unknown flag', () => {
    assert.throws(() => parseArgs(['node', 'r.mjs', '--bogus']), /Unknown argument/);
  });

  it('throws when --days has a non-integer value', () => {
    assert.throws(() => parseArgs(['node', 'r.mjs', '--days', 'forever']), /must be a positive integer/);
  });

  it('throws when --rule is missing its value', () => {
    assert.throws(() => parseArgs(['node', 'r.mjs', '--rule']), /requires a value/);
    assert.throws(() => parseArgs(['node', 'r.mjs', '--rule', '--days']), /requires a value/);
  });
});
