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
  // given the cache hit + title combinations. The integration coverage
  // for the actual side-effecting code path lives in the
  // ingest-pipeline e2e suite (not present in this test file's scope).

  it('CRITICAL+marker → downgraded to info (the case this PR closes)', () => {
    const cappedLevel = 'critical';
    const title = 'Science history: nuclear meltdown - April 26, 1986';
    const finalLevel =
      (cappedLevel === 'critical' || cappedLevel === 'high') && hasHistoricalMarker(title, NOW)
        ? 'info'
        : cappedLevel;
    assert.equal(finalLevel, 'info');
  });

  it('HIGH+marker → downgraded to info', () => {
    const cappedLevel = 'high';
    const title = '40th anniversary of WWII airstrike on London';
    const finalLevel =
      (cappedLevel === 'critical' || cappedLevel === 'high') && hasHistoricalMarker(title, NOW)
        ? 'info'
        : cappedLevel;
    assert.equal(finalLevel, 'info');
  });

  it('MEDIUM+marker → unchanged (only CRITICAL/HIGH get the guard)', () => {
    const cappedLevel = 'medium';
    const title = '5-year anniversary of historic protests';
    const finalLevel =
      (cappedLevel === 'critical' || cappedLevel === 'high') && hasHistoricalMarker(title, NOW)
        ? 'info'
        : cappedLevel;
    assert.equal(finalLevel, 'medium', 'only CRITICAL/HIGH trip the guard; MEDIUM is left alone');
  });

  it('CRITICAL without marker → unchanged (current-event still ships)', () => {
    const cappedLevel = 'critical';
    const title = 'Reactor melts down at active plant — operators evacuating';
    const finalLevel =
      (cappedLevel === 'critical' || cappedLevel === 'high') && hasHistoricalMarker(title, NOW)
        ? 'info'
        : cappedLevel;
    assert.equal(finalLevel, 'critical', 'current events with no markers must still ship');
  });
});
