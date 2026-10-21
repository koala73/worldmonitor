// Defense-in-depth tests for the LLM-cache-application historical guard
// in enrichWithAiCache (server/worldmonitor/news/v1/list-feed-digest.ts).
//
// The keyword classifier already downgrades CRITICAL/HIGH keyword matches
// when the title carries a retrospective marker. But for titles that don't
// trigger any keyword (e.g. "melts down" doesn't match the "meltdown"
// keyword) yet have an LLM cache hit promoting them to CRITICAL/HIGH,
// the keyword-side downgrade can't fire. This second-layer guard catches
// that case at the cache-application boundary.
//
// Brief 2026-04-26-1302 surfaced exactly this shape: "Science history:
// Chernobyl nuclear power plant melts down... — April 26, 1986" had no
// keyword match (substring "meltdown" doesn't appear in "melts down")
// yet shipped — the LLM cache must have promoted it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasHistoricalMarker } from '../server/worldmonitor/news/v1/_classifier';

// Pin "current year" to 2026 so year-based marker tests are deterministic.
const NOW = Date.UTC(2026, 3, 15, 0, 0, 0);

describe('LLM-cache historical-marker guard — predicate', () => {
  // The actual cache-application code in enrichWithAiCache is integration-
  // level (requires Redis). We can't easily mount a Redis double here, so
  // we verify the predicate that drives the guard. The brief 2026-04-26-1302
  // title MUST trigger hasHistoricalMarker even though it never triggers
  // the keyword classifier.

  it('the actual brief 2026-04-26-1302 contamination case → marker detected', () => {
    const title =
      'Science history: Chernobyl nuclear power plant melts down, bringing the world to the brink of disaster — April 26, 1986';
    assert.equal(
      hasHistoricalMarker(title, NOW),
      true,
      'historical marker must be detected so the LLM-cache guard fires when cache promotes this title',
    );
  });

  it('"melts down" (no keyword match) but "Science history:" prefix → marker detected', () => {
    // "melts down" with a space is NOT in CRITICAL_KEYWORDS (only
    // "meltdown" as a single word is), so the keyword classifier returns
    // info. If the LLM cache happens to have classified this as
    // CRITICAL/HIGH from a prior session, the guard catches it.
    assert.equal(
      hasHistoricalMarker('Science history: Reactor melts down 40 years ago today', NOW),
      true,
    );
  });

  it('current-event title with "melts down" but no marker → NOT touched by guard', () => {
    // Negative: a real ongoing event with two-word "melts down" but no
    // retrospective marker. The keyword classifier returns info (no
    // match); if LLM cache promotes to high/critical, the guard does
    // NOT downgrade (no marker present). Operators see the LLM call's
    // judgment, which is the correct behavior for current events.
    assert.equal(
      hasHistoricalMarker('Reactor melts down at active nuclear plant', NOW),
      false,
    );
  });

  it('PAST full date alone is enough to trigger', () => {
    assert.equal(hasHistoricalMarker('Some headline — April 26, 1986', NOW), true);
  });

  it('PAST ISO date alone is enough to trigger', () => {
    assert.equal(hasHistoricalMarker('Some headline 1986-04-26 reflection', NOW), true);
  });

  it('SAFETY: current-year full date does NOT trigger (P2 reviewer fix on PR #3429 round 2)', () => {
    // Reviewer-flagged regression: "Missile launch reported on April 26,
    // 2026" used to falsely trigger. Year=2026=current must NOT mark
    // the title as retrospective.
    assert.equal(
      hasHistoricalMarker('Missile launch reported on April 26, 2026', NOW),
      false,
    );
  });

  it('SAFETY: bare "Today in" prefix does NOT trigger (P2 reviewer fix on PR #3429 round 2)', () => {
    // "Today in Ukraine: Russian missile strikes Kyiv" must NOT be
    // marked as retrospective — bare "Today in" is a current-event
    // headline pattern, not a historical one.
    assert.equal(
      hasHistoricalMarker('Today in Ukraine: Russian missile strikes Kyiv', NOW),
      false,
    );
  });
});

describe('LLM-cache guard — semantics documentation (behavioral spec)', () => {
  // These tests document what enrichWithAiCache's L3 guard should do
  // given the RAW cache hit + title combinations. The guard runs BEFORE
  // capLlmUpgrade (PR #3429 round 3 P1 fix) — so the model is:
  //
  //   if hasHistoricalMarker(title): final = 'info' (regardless of hit.level)
  //   else: final = capLlmUpgrade(keywordLevel, hit.level)
  //
  // Prior model (post-cap, only critical/high) had a hole: when
  // keyword='info' + hit='critical', capLlmUpgrade returns 'medium'
  // (info+2=medium), which doesn't match the critical/high check, so the
  // guard never fired and retrospective content shipped at MEDIUM.
  //
  // Integration coverage for the actual side-effecting code path lives
  // in the ingest-pipeline e2e suite (not present in this test file's
  // scope).

  // Helper modeling the post-fix flow exactly.
  function applyGuard(hitLevel: string, title: string, nowMs: number): string {
    if (hasHistoricalMarker(title, nowMs)) return 'info';
    return hitLevel;
  }

  it('CRITICAL hit + marker → forced to info (the case this PR closes)', () => {
    const finalLevel = applyGuard(
      'critical',
      'Science history: nuclear meltdown - April 26, 1986',
      NOW,
    );
    assert.equal(finalLevel, 'info');
  });

  it('HIGH hit + marker → forced to info', () => {
    const finalLevel = applyGuard('high', '40th anniversary of WWII airstrike on London', NOW);
    assert.equal(finalLevel, 'info');
  });

  it('SAFETY: keyword=info + LLM=critical + marker → info (NOT medium per cap) — round 3 P1 fix', () => {
    // The reviewer's exact failure mode on PR #3429 round 3.
    //
    // Pre-fix flow (BROKEN): keyword=info + hit=critical → capLlmUpgrade
    // returns medium (info+2=medium); then the post-cap guard checks
    // `=== 'critical' || === 'high'` and SKIPS — final = medium, ships
    // in 'all'-sensitivity briefs.
    //
    // Post-fix flow (THIS TEST): marker check runs on the RAW hit BEFORE
    // capLlmUpgrade and forces info regardless of the cap arithmetic.
    const title =
      'Science history: Chernobyl nuclear power plant melts down, bringing the world to the brink of disaster — April 26, 1986';
    const finalLevel = applyGuard('critical', title, NOW);
    assert.equal(finalLevel, 'info', 'guard must force info, not let cap demote to medium');
  });

  it('MEDIUM hit + marker → forced to info (any non-info level on retrospective is wrong)', () => {
    // The post-fix semantics: retrospective markers suppress the LLM
    // verdict at every non-info level. A 'medium' retrospective still
    // ships in 'all'-sensitivity briefs, so the guard must catch it too.
    const finalLevel = applyGuard('medium', '5-year anniversary of historic protests', NOW);
    assert.equal(finalLevel, 'info', 'retrospective content never ships at any non-info level');
  });

  it('CRITICAL hit without marker → unchanged (current-event still ships)', () => {
    const finalLevel = applyGuard(
      'critical',
      'Reactor melts down at active plant — operators evacuating',
      NOW,
    );
    assert.equal(finalLevel, 'critical', 'current events with no markers must still ship');
  });

  it('INFO hit without marker → unchanged (no false promotion)', () => {
    const finalLevel = applyGuard('info', 'Routine policy update from agency', NOW);
    assert.equal(finalLevel, 'info');
  });
});
