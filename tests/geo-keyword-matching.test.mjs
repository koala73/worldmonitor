import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for word-boundary keyword matching in geo-tagging.
 *
 * The geo-hub-index and hotspot systems match article titles to geographic
 * locations using keywords. These tests verify that substring false positives
 * (e.g. "assad" inside "ambassador") are correctly rejected by word-boundary
 * regex matching.
 *
 * Reproduces: https://github.com/koala73/worldmonitor/issues/324
 */

// Replicate the matching logic used across the codebase
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(title, keyword) {
  const escaped = escapeRegex(keyword);
  return new RegExp(`\\b${escaped}\\b`, 'i').test(title);
}

function matchesAnyKeyword(title, keywords) {
  return keywords.some(kw => matchesKeyword(title, kw));
}

// Syria/Damascus keywords from geo-hub-index.ts and geo.ts
const SYRIA_KEYWORDS = ['syria', 'syrian', 'assad', 'damascus', 'idlib', 'aleppo'];
const DAMASCUS_HOTSPOT_KEYWORDS = ['syria', 'damascus', 'assad', 'syrian', 'tahrir al-sham', 'hayat tahrir'];

// France/Paris keywords
const PARIS_KEYWORDS = ['paris', 'france', 'french', 'macron', 'elysee'];

describe('geo-tagging keyword matching — false positive prevention', () => {

  describe('Syria keywords should NOT match unrelated articles', () => {
    const falsePositiveTitles = [
      'French Ambassador outlines new diplomatic strategy for EU',
      'Ambassador warns of growing trade war between US and China',
      'UK Ambassador to Germany discusses bilateral rights',
      'Ambassador recalls tense negotiations over climate deal',
      'New Ambassador appointed to lead UN delegation',
    ];

    for (const title of falsePositiveTitles) {
      it(`should NOT match: "${title}"`, () => {
        assert.equal(
          matchesAnyKeyword(title, SYRIA_KEYWORDS),
          false,
          `"assad" should not match inside "ambassador" in: ${title}`
        );
      });
    }
  });

  describe('Syria keywords SHOULD match genuine Syria articles', () => {
    const trueTitles = [
      'Assad regime forces advance in northern Syria',
      'Syrian refugees face new challenges in Lebanon',
      'Damascus hit by renewed airstrikes overnight',
      'Fighting intensifies near Idlib province',
      'Aleppo reconstruction efforts stall amid sanctions',
      'UN envoy meets Assad to discuss ceasefire',
    ];

    for (const title of trueTitles) {
      it(`should match: "${title}"`, () => {
        assert.equal(
          matchesAnyKeyword(title, SYRIA_KEYWORDS),
          true,
          `Should match genuine Syria article: ${title}`
        );
      });
    }
  });

  describe('"hts" keyword replaced with unambiguous forms', () => {
    const oldKeyword = 'hts';
    const newKeywords = ['tahrir al-sham', 'hayat tahrir'];

    it('old "hts" keyword would false-match "rights"', () => {
      // This is what the OLD code did — plain includes
      assert.equal(
        'human rights debate in parliament'.includes(oldKeyword),
        true,
        '"hts" is a substring of "rights" — this was the bug'
      );
    });

    it('new keywords do NOT match "rights", "fights", etc.', () => {
      const titles = [
        'Human rights debate in French parliament',
        'Opposition fights pension reform bill',
        'New insights from EU economic report',
        'Flights delayed across European airports',
      ];
      for (const title of titles) {
        assert.equal(
          matchesAnyKeyword(title, newKeywords),
          false,
          `New HTS keywords should not match: ${title}`
        );
      }
    });

    it('new keywords DO match actual HTS references', () => {
      const titles = [
        'Hayat Tahrir al-Sham consolidates control in northwest Syria',
        'Tahrir al-Sham forces clash with regime troops',
      ];
      for (const title of titles) {
        assert.equal(
          matchesAnyKeyword(title, newKeywords),
          true,
          `Should match genuine HTS article: ${title}`
        );
      }
    });
  });

  describe('France keywords should match correctly', () => {
    it('matches genuine France articles', () => {
      assert.equal(matchesAnyKeyword('Macron addresses nation on pension reform', PARIS_KEYWORDS), true);
      assert.equal(matchesAnyKeyword('France announces new climate initiative', PARIS_KEYWORDS), true);
      assert.equal(matchesAnyKeyword('Paris hosts international peace summit', PARIS_KEYWORDS), true);
    });

    it('does not cross-match Syria', () => {
      assert.equal(matchesAnyKeyword('Macron addresses nation on pension reform', SYRIA_KEYWORDS), false);
      assert.equal(matchesAnyKeyword('French parliament debates new budget', SYRIA_KEYWORDS), false);
    });
  });

  describe('word boundary edge cases', () => {
    it('"iran" should not match "Ukrainian"', () => {
      assert.equal(matchesKeyword('Ukrainian forces advance near Kharkiv', 'iran'), false);
    });

    it('"iran" should match "Iran sanctions tightened"', () => {
      assert.equal(matchesKeyword('Iran sanctions tightened by US', 'iran'), true);
    });

    it('"us" should not match "focus" or "thus"', () => {
      assert.equal(matchesKeyword('EU leaders focus on trade reform', 'us'), false);
      assert.equal(matchesKeyword('Thus begins a new chapter in diplomacy', 'us'), false);
    });

    it('"us" should match "US announces new policy"', () => {
      assert.equal(matchesKeyword('US announces new tariff policy', 'us'), true);
    });
  });
});
