// Pure-function tests for the historical-retrospective downgrade in
// classifyByKeyword (server/worldmonitor/news/v1/_classifier.ts).
//
// The classifier was shipping anniversary / "this day in history" pieces as
// CRITICAL because their headlines contain trigger words like "meltdown" or
// "invasion". Brief 2026-04-26-1302 surfaced "Science history: Chernobyl
// nuclear power plant melts down... — April 26, 1986 - Live Science" — a
// 40-year retrospective ranking like a current crisis. The downgrade
// catches headline-shape markers (retrospective prefix, "X years ago",
// "anniversary", a CLEARLY-PAST full date in title) and forces level=info
// on CRITICAL/HIGH matches.
//
// LOW/MEDIUM matches are intentionally NOT downgraded — they don't clear
// brief thresholds anyway and the over-aggression cost outweighs the
// signal.
//
// Markers are NARROW by design — bare "Today in" / "This day in" were
// removed after PR #3429 review (round 2) because they have legitimate
// current-event uses ("Today in Ukraine: Russian missile strikes Kyiv").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyByKeyword,
  hasHistoricalMarker,
} from '../server/worldmonitor/news/v1/_classifier';

// All marker checks that depend on year-vs-now use NOW pinned to mid-April
// 2026 so tests don't depend on wall-clock time. The "current year" derived
// from this is 2026.
const NOW = Date.UTC(2026, 3, 15, 0, 0, 0);

describe('hasHistoricalMarker — predicate matrix', () => {
  describe('retrospective prefixes (true) — narrowed set', () => {
    it('Live Science "Science history:" prefix', () => {
      assert.equal(
        hasHistoricalMarker(
          'Science history: Chernobyl nuclear power plant melts down — April 26, 1986',
          NOW,
        ),
        true,
      );
    });

    it('"On this day in YYYY" with explicit year', () => {
      assert.equal(
        hasHistoricalMarker('On this day in 1969: The moon landing', NOW),
        true,
      );
    });

    it('"This day in history" exact phrase', () => {
      assert.equal(
        hasHistoricalMarker('This day in history: Berlin Wall falls', NOW),
        true,
      );
    });

    it('"Throwback" / "Flashback" prefixes', () => {
      assert.equal(hasHistoricalMarker('Throwback Thursday: 9/11 reflections', NOW), true);
      assert.equal(hasHistoricalMarker('Flashback: 1986 Iran-Contra disclosure', NOW), true);
    });

    it('case-insensitive', () => {
      assert.equal(
        hasHistoricalMarker('SCIENCE HISTORY: Chernobyl meltdown', NOW),
        true,
      );
      assert.equal(
        hasHistoricalMarker('on this day in 2003: invasion of Iraq', NOW),
        true,
      );
    });
  });

  describe('SAFETY: bare "Today in" / "This day in" / "On this day" do NOT trigger (P2 reviewer fix)', () => {
    it('"Today in Ukraine: Russian missile strikes Kyiv" — current event, MUST not be marked', () => {
      // Reviewer-flagged false positive. Bare "Today in" is too broad —
      // legitimate ongoing-conflict reporting uses this prefix.
      assert.equal(
        hasHistoricalMarker('Today in Ukraine: Russian missile strikes Kyiv', NOW),
        false,
      );
    });

    it('"This day in: Iran fires missile" — bare "This day in" is current-event-friendly', () => {
      assert.equal(
        hasHistoricalMarker('This day in: Iran fires missile at Tel Aviv', NOW),
        false,
      );
    });

    it('"On this day, Iran invasion begins" — bare "On this day" without YEAR does not trigger', () => {
      assert.equal(
        hasHistoricalMarker('On this day, Iran invasion begins', NOW),
        false,
      );
    });

    it('"Today in tech: Apple unveils new iPhone" — bare "Today in" current event', () => {
      assert.equal(
        hasHistoricalMarker('Today in tech: Apple unveils new iPhone', NOW),
        false,
      );
    });
  });

  describe('historical phrases (true)', () => {
    it('"X years ago" / "X decades ago"', () => {
      assert.equal(hasHistoricalMarker('Iraq invasion: 5 years ago today', NOW), true);
      assert.equal(hasHistoricalMarker('Cuban missile crisis 6 decades ago', NOW), true);
    });

    it('"X years after" / "X years later"', () => {
      assert.equal(hasHistoricalMarker('Vietnam war 50 years after withdrawal', NOW), true);
      assert.equal(hasHistoricalMarker('Genocide trial 30 years later', NOW), true);
    });

    it('"anniversary"', () => {
      assert.equal(
        hasHistoricalMarker('40th anniversary of the Chernobyl disaster', NOW),
        true,
      );
    });

    it('"remembering" / "in memoriam" / "commemoration"', () => {
      assert.equal(hasHistoricalMarker('Remembering 9/11 attacks', NOW), true);
      assert.equal(
        hasHistoricalMarker('In memoriam: victims of the Bhopal disaster', NOW),
        true,
      );
      assert.equal(hasHistoricalMarker('Commemoration of the Holocaust', NOW), true);
    });

    it('"retrospective"', () => {
      assert.equal(hasHistoricalMarker('Iraq war retrospective', NOW), true);
    });
  });

  describe('full-date markers — only triggers when year is ≥ 2 years past', () => {
    it('"Month Day, 1986" (40 years past) → marker fires', () => {
      assert.equal(
        hasHistoricalMarker('Chernobyl meltdown - April 26, 1986', NOW),
        true,
      );
    });

    it('"Month Day, 2024" (2 years past) → marker fires', () => {
      assert.equal(
        hasHistoricalMarker('Looking back at events of January 6, 2024', NOW),
        true,
      );
    });

    it('SAFETY: "Month Day, 2026" (current year) → marker does NOT fire (P2 reviewer fix)', () => {
      // Reviewer-flagged false positive. Current-year dates appear in
      // current-event headlines: court rulings, regulatory deadlines,
      // scheduled events.
      assert.equal(
        hasHistoricalMarker('Missile launch reported on April 26, 2026', NOW),
        false,
      );
    });

    it('SAFETY: "Month Day, 2025" (last year) → marker does NOT fire — could be current context', () => {
      assert.equal(
        hasHistoricalMarker('Court ruling on April 15, 2025 takes effect', NOW),
        false,
      );
    });

    it('SAFETY: "Month Day, 2027" (future date — clock skew or scheduled event) → does NOT fire', () => {
      assert.equal(
        hasHistoricalMarker('Election scheduled for November 3, 2027', NOW),
        false,
      );
    });

    it('ISO date "1986-04-26" (past) → marker fires', () => {
      assert.equal(
        hasHistoricalMarker('Disaster on 1986-04-26 changed nuclear policy', NOW),
        true,
      );
    });

    it('SAFETY: ISO date "2026-04-26" (current year) → marker does NOT fire', () => {
      assert.equal(
        hasHistoricalMarker('Brief published 2026-04-26 covers the day', NOW),
        false,
      );
    });

    it('case-insensitive month names', () => {
      assert.equal(hasHistoricalMarker('Falklands war APRIL 2, 1982', NOW), true);
    });
  });

  describe('current-event headlines (false)', () => {
    it('plain critical headline with no markers', () => {
      assert.equal(hasHistoricalMarker('Iran fires missile at Tel Aviv', NOW), false);
    });

    it('headline with current year (no full date)', () => {
      // Year alone is too noisy — current-event headlines often mention
      // "2026 budget" or "2026 elections". Predicate must NOT trigger
      // unless year is paired with month/day or other historical phrase.
      assert.equal(
        hasHistoricalMarker('Russia warns of 2026 nuclear escalation', NOW),
        false,
      );
      assert.equal(
        hasHistoricalMarker('2026 Iran tensions reach new high', NOW),
        false,
      );
    });

    it('numeric token that LOOKS like year but is in different context', () => {
      assert.equal(
        hasHistoricalMarker('Stock down to 1986 points after crash', NOW),
        false,
      );
    });

    it('historical-sounding word but not a marker phrase', () => {
      assert.equal(
        hasHistoricalMarker('History repeats: Iran threatens war', NOW),
        false,
      );
    });
  });
});

describe('classifyByKeyword — historical downgrade integration', () => {
  describe('CRITICAL keyword + historical marker → info', () => {
    it('"meltdown" (single word, hits CRITICAL) + "Science history:" prefix → downgrade', () => {
      // Note: the actual brief 2026-04-26-1302 headline reads "melts
      // down" (two words), which does NOT match the "meltdown" keyword
      // — that case is caught at the LLM-cache-application layer in
      // enrichWithAiCache (see news-classifier-llm-historical-guard
      // tests), not here. This test covers titles whose keyword
      // classifier DOES claim CRITICAL.
      const r = classifyByKeyword('Chernobyl meltdown anniversary - April 26, 1986');
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
      assert.equal(r.category, 'general');
    });

    it('"meltdown" + "On this day in 1979"', () => {
      const r = classifyByKeyword('On this day in 1979: Three Mile Island partial meltdown');
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
    });

    it('"invasion" + "5 years ago"', () => {
      const r = classifyByKeyword('Iraq invasion 5 years ago today');
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
    });

    it('"genocide" + "anniversary"', () => {
      const r = classifyByKeyword('40th anniversary of the Rwandan genocide');
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
    });
  });

  describe('HIGH keyword + historical marker → info', () => {
    it('"war" + "Throwback"', () => {
      const r = classifyByKeyword('Throwback: Vietnam war ended decades ago');
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
    });

    it('"missile" + "anniversary"', () => {
      const r = classifyByKeyword('Cuban missile crisis 60th anniversary');
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
    });
  });

  describe('SAFETY: current critical/high events MUST still ship at full severity (P2 reviewer fix)', () => {
    it('"Today in Ukraine: Russian missile strikes Kyiv" → MISSILE keyword preserved at HIGH', () => {
      // The exact reviewer-flagged regression: bare "Today in" used to
      // downgrade this to info. Must now preserve.
      const r = classifyByKeyword('Today in Ukraine: Russian missile strikes Kyiv');
      assert.equal(r.level, 'high', 'current-event missile alert must NOT be downgraded');
      assert.equal(r.source, 'keyword');
    });

    it('"Missile launch reported on April 26, 2026" → MISSILE keyword preserved at HIGH', () => {
      // Second reviewer regression: current-year full date used to
      // mark as retrospective. Must now preserve.
      const r = classifyByKeyword('Missile launch reported on April 26, 2026');
      assert.equal(r.level, 'high');
      assert.equal(r.source, 'keyword');
    });

    it('current-event critical: nuclear strike threat', () => {
      const r = classifyByKeyword('Iran threatens nuclear strike on Tel Aviv');
      assert.equal(r.level, 'critical');
      assert.equal(r.source, 'keyword');
    });

    it('current-event high: missile launch (no markers)', () => {
      const r = classifyByKeyword('North Korea launches missile over Japan');
      assert.equal(r.level, 'high');
      assert.equal(r.source, 'keyword');
    });

    it('current-event critical: meltdown not anniversary', () => {
      const r = classifyByKeyword('Reactor meltdown at Fukushima continues');
      assert.equal(r.level, 'critical');
      assert.equal(r.source, 'keyword');
    });
  });

  describe('LOW/MEDIUM keyword with historical marker → unchanged (not downgraded)', () => {
    it('"election" (LOW) + anniversary → still low', () => {
      const r = classifyByKeyword('5th anniversary of historic 2020 election');
      assert.equal(r.level, 'low');
      assert.equal(r.source, 'keyword');
    });

    it('"protest" (MEDIUM) + retrospective prefix → still medium', () => {
      const r = classifyByKeyword('Throwback: 1968 student protests');
      assert.equal(r.level, 'medium');
      assert.equal(r.source, 'keyword');
    });
  });

  describe('confidence levels distinguish downgrade from no-match', () => {
    it('downgrade returns confidence 0.85 (intermediate — LLM cache can override)', () => {
      const r = classifyByKeyword('Science history: Chernobyl meltdown - April 26, 1986');
      assert.equal(r.confidence, 0.85);
    });

    it('no-match info returns confidence 0.3 (separate signal for telemetry)', () => {
      const r = classifyByKeyword('A completely benign announcement about pickleball');
      assert.equal(r.level, 'info');
      assert.equal(r.confidence, 0.3);
      assert.equal(r.source, 'keyword');
    });
  });
});
