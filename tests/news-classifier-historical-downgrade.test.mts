// Pure-function tests for the historical-retrospective downgrade in
// classifyByKeyword (server/worldmonitor/news/v1/_classifier.ts).
//
// The classifier was shipping anniversary / "this day in history" pieces as
// CRITICAL because their headlines contain trigger words like "meltdown" or
// "invasion". Brief 2026-04-26-1302 surfaced "Science history: Chernobyl
// nuclear power plant melts down... — April 26, 1986 - Live Science" — a
// 40-year retrospective ranking like a current crisis. The downgrade
// catches headline-shape markers (retrospective prefix, "X years ago",
// "anniversary", a full date in title) and forces level=info on
// CRITICAL/HIGH matches.
//
// LOW/MEDIUM matches are intentionally NOT downgraded — they don't clear
// brief thresholds anyway and the over-aggression cost outweighs the
// signal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyByKeyword,
  hasHistoricalMarker,
} from '../server/worldmonitor/news/v1/_classifier';

describe('hasHistoricalMarker — predicate matrix', () => {
  describe('retrospective prefixes (true)', () => {
    it('Live Science "Science history:" prefix', () => {
      assert.equal(
        hasHistoricalMarker('Science history: Chernobyl nuclear power plant melts down — April 26, 1986'),
        true,
      );
    });

    it('"On this day" prefix', () => {
      assert.equal(hasHistoricalMarker('On this day: The 1969 moon landing'), true);
    });

    it('"Today in" / "This day in" / "Throwback" / "Flashback" prefixes', () => {
      assert.equal(hasHistoricalMarker('Today in tech: Apple unveils iPhone'), true);
      assert.equal(hasHistoricalMarker('This day in history: Berlin Wall falls'), true);
      assert.equal(hasHistoricalMarker('Throwback Thursday: 9/11 reflections'), true);
      assert.equal(hasHistoricalMarker('Flashback: 1986 Iran-Contra disclosure'), true);
    });

    it('case-insensitive', () => {
      assert.equal(hasHistoricalMarker('SCIENCE HISTORY: Chernobyl meltdown'), true);
      assert.equal(hasHistoricalMarker('on this day: invasion of Iraq'), true);
    });
  });

  describe('historical phrases (true)', () => {
    it('"X years ago" / "X decades ago"', () => {
      assert.equal(hasHistoricalMarker('Iraq invasion: 5 years ago today'), true);
      assert.equal(hasHistoricalMarker('Cuban missile crisis 6 decades ago'), true);
    });

    it('"X years after" / "X years later"', () => {
      assert.equal(hasHistoricalMarker('Vietnam war 50 years after withdrawal'), true);
      assert.equal(hasHistoricalMarker('Genocide trial 30 years later'), true);
    });

    it('"anniversary"', () => {
      assert.equal(hasHistoricalMarker('40th anniversary of the Chernobyl disaster'), true);
    });

    it('"remembering" / "in memoriam" / "commemoration"', () => {
      assert.equal(hasHistoricalMarker('Remembering 9/11 attacks'), true);
      assert.equal(hasHistoricalMarker('In memoriam: victims of the Bhopal disaster'), true);
      assert.equal(hasHistoricalMarker('Commemoration of the Holocaust'), true);
    });

    it('"retrospective"', () => {
      assert.equal(hasHistoricalMarker('Iraq war retrospective'), true);
    });
  });

  describe('full-date markers (true)', () => {
    it('"Month Day, Year" format', () => {
      assert.equal(hasHistoricalMarker('Chernobyl meltdown - April 26, 1986'), true);
      assert.equal(hasHistoricalMarker('JFK assassinated November 22, 1963'), true);
    });

    it('ISO date "YYYY-MM-DD"', () => {
      assert.equal(hasHistoricalMarker('Disaster on 1986-04-26 changed nuclear policy'), true);
    });

    it('case-insensitive month names', () => {
      assert.equal(hasHistoricalMarker('Falklands war APRIL 2, 1982'), true);
    });
  });

  describe('current-event headlines (false)', () => {
    it('plain critical headline with no markers', () => {
      assert.equal(hasHistoricalMarker('Iran fires missile at Tel Aviv'), false);
    });

    it('headline with current year (no full date)', () => {
      // Year alone is too noisy — current-event headlines often mention
      // "2026 budget" or "2026 elections". Predicate must NOT trigger
      // unless year is paired with month/day or other historical phrase.
      assert.equal(hasHistoricalMarker('Russia warns of 2026 nuclear escalation'), false);
      assert.equal(hasHistoricalMarker('2026 Iran tensions reach new high'), false);
    });

    it('numeric token that LOOKS like year but is in different context', () => {
      assert.equal(hasHistoricalMarker('Stock down to 1986 points after crash'), false);
    });

    it('historical-sounding word but not a marker phrase', () => {
      // "history" alone doesn't trigger; only the prefix forms do.
      assert.equal(hasHistoricalMarker('History repeats: Iran threatens war'), false);
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
      // tests below), not here. This test covers titles whose keyword
      // classifier DOES claim CRITICAL.
      const r = classifyByKeyword(
        'Chernobyl meltdown anniversary - April 26, 1986',
      );
      assert.equal(r.level, 'info');
      assert.equal(r.source, 'keyword-historical-downgrade');
      assert.equal(r.category, 'general');
    });

    it('"meltdown" + "On this day"', () => {
      const r = classifyByKeyword('On this day: Three Mile Island partial meltdown');
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

  describe('CRITICAL/HIGH keyword without markers → unchanged', () => {
    it('current-event critical: nuclear strike threat', () => {
      const r = classifyByKeyword('Iran threatens nuclear strike on Tel Aviv');
      assert.equal(r.level, 'critical');
      assert.equal(r.source, 'keyword');
    });

    it('current-event high: missile launch', () => {
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
    // Intentional design choice: only CRITICAL/HIGH get the downgrade.
    // LOW/MEDIUM don't clear brief thresholds anyway.
    it('"election" (LOW) + anniversary → still low', () => {
      const r = classifyByKeyword('5th anniversary of historic 2020 election');
      assert.equal(r.level, 'low');
      assert.equal(r.source, 'keyword');
    });

    it('"protest" (MEDIUM) + retrospective prefix → still medium', () => {
      const r = classifyByKeyword('On this day: 1968 student protests');
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
