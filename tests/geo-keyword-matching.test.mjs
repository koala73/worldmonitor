import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for tokenization-based keyword matching in geo-tagging.
 *
 * The geo-hub-index and hotspot systems match article titles to geographic
 * locations using keywords. Tokenization splits titles into word Sets for
 * O(1) lookups, eliminating substring false positives by design.
 *
 * Reproduces: https://github.com/koala73/worldmonitor/issues/324
 */

// Replicate the tokenization logic from src/utils/keyword-match.ts
function tokenizeForMatch(title) {
  const ordered = title.toLowerCase().split(/[^a-z0-9'-]+/).filter(w => w.length > 0);
  return { words: new Set(ordered), ordered };
}

function matchKeyword(tokens, keyword) {
  const parts = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (parts.length === 0) return false;
  if (parts.length === 1) return tokens.words.has(parts[0]);

  const { ordered } = tokens;
  for (let i = 0; i <= ordered.length - parts.length; i++) {
    let match = true;
    for (let j = 0; j < parts.length; j++) {
      if (ordered[i + j] !== parts[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function matchesAnyKeyword(title, keywords) {
  const tokens = tokenizeForMatch(title);
  return keywords.some(kw => matchKeyword(tokens, kw));
}

function findMatchingKeywords(title, keywords) {
  const tokens = tokenizeForMatch(title);
  return keywords.filter(kw => matchKeyword(tokens, kw));
}

// Syria/Damascus keywords (matching geo-hub-index.ts and geo.ts)
const SYRIA_KEYWORDS = ['syria', 'syrian', 'assad', 'damascus', 'idlib', 'aleppo'];
const DAMASCUS_HOTSPOT_KEYWORDS = ['syria', 'damascus', 'assad', 'syrian', 'hts', 'tahrir al-sham', 'hayat tahrir'];

// France/Paris keywords
const PARIS_KEYWORDS = ['paris', 'france', 'french', 'macron', 'elysee'];

// DC keywords (cleaned up — no trailing-space hack, no bare 'house')
const DC_KEYWORDS = ['pentagon', 'white house', 'congress', 'cia', 'nsa', 'washington', 'biden', 'trump', 'senate', 'supreme court', 'vance', 'elon'];

describe('tokenizeForMatch', () => {
  it('splits title into lowercase word set', () => {
    const tokens = tokenizeForMatch('Assad Regime Forces Advance');
    assert.deepEqual(tokens.ordered, ['assad', 'regime', 'forces', 'advance']);
    assert.equal(tokens.words.has('assad'), true);
    assert.equal(tokens.words.has('regime'), true);
  });

  it('strips punctuation and special characters', () => {
    const tokens = tokenizeForMatch('U.S. announces $5B aid — details inside!');
    assert.equal(tokens.words.has('u'), true);
    assert.equal(tokens.words.has('s'), true);
    assert.equal(tokens.words.has('5b'), true);
    assert.equal(tokens.words.has('announces'), true);
  });

  it('preserves hyphens and apostrophes within words', () => {
    const tokens = tokenizeForMatch("al-Sham's forces counter-attack");
    assert.equal(tokens.words.has("al-sham's"), true);
    assert.equal(tokens.words.has('counter-attack'), true);
  });

  it('handles empty and whitespace-only titles', () => {
    assert.equal(tokenizeForMatch('').words.size, 0);
    assert.equal(tokenizeForMatch('   ').words.size, 0);
  });
});

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

  describe('"hts" keyword is safe with tokenization', () => {
    it('"hts" does NOT match "rights" (tokenized as separate word)', () => {
      assert.equal(matchesAnyKeyword('human rights debate in parliament', ['hts']), false);
    });

    it('"hts" does NOT match "fights", "flights", "insights"', () => {
      assert.equal(matchesAnyKeyword('Opposition fights pension reform bill', ['hts']), false);
      assert.equal(matchesAnyKeyword('Flights delayed across European airports', ['hts']), false);
      assert.equal(matchesAnyKeyword('New insights from EU economic report', ['hts']), false);
    });

    it('"hts" DOES match "HTS forces advance in Idlib"', () => {
      assert.equal(matchesAnyKeyword('HTS forces advance in Idlib', ['hts']), true);
    });

    it('"hts" DOES match "HTS seizes control of key border crossing"', () => {
      assert.equal(matchesAnyKeyword('HTS seizes control of key border crossing', ['hts']), true);
    });
  });

  describe('multi-word keywords match as contiguous phrases', () => {
    it('"white house" matches "White House announces new policy"', () => {
      assert.equal(matchesAnyKeyword('White House announces new policy', ['white house']), true);
    });

    it('"white house" does NOT match "The house is painted white"', () => {
      assert.equal(matchesAnyKeyword('The house is painted white', ['white house']), false);
    });

    it('"tahrir al-sham" matches the full phrase', () => {
      assert.equal(
        matchesAnyKeyword("Tahrir al-Sham consolidates control in northwest Syria", ['tahrir al-sham']),
        true
      );
    });

    it('"supreme court" matches as phrase, not individual words', () => {
      assert.equal(matchesAnyKeyword('Supreme Court strikes down executive order', ['supreme court']), true);
      assert.equal(matchesAnyKeyword('The court ruled supreme authority applies', ['supreme court']), false);
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
      assert.equal(matchesAnyKeyword('Ukrainian forces advance near Kharkiv', ['iran']), false);
    });

    it('"iran" should match "Iran sanctions tightened"', () => {
      assert.equal(matchesAnyKeyword('Iran sanctions tightened by US', ['iran']), true);
    });

    it('"us" should not match "focus" or "thus"', () => {
      assert.equal(matchesAnyKeyword('EU leaders focus on trade reform', ['us']), false);
      assert.equal(matchesAnyKeyword('Thus begins a new chapter in diplomacy', ['us']), false);
    });

    it('"us" should match "US announces new policy"', () => {
      assert.equal(matchesAnyKeyword('US announces new tariff policy', ['us']), true);
    });

    it('"ai" should not match "said" or "wait"', () => {
      assert.equal(matchesAnyKeyword('Officials said the deal is off', ['ai']), false);
      assert.equal(matchesAnyKeyword('Markets wait for Fed decision', ['ai']), false);
    });

    it('"ai" should match "AI startup raises $1B"', () => {
      assert.equal(matchesAnyKeyword('AI startup raises $1B in Series D', ['ai']), true);
    });
  });

  describe('DC keywords — cleaned up', () => {
    it('"house" alone does not match generic housing articles', () => {
      // With 'house' removed from DC keywords, this shouldn't match
      assert.equal(matchesAnyKeyword('Housing market faces new challenges', DC_KEYWORDS), false);
    });

    it('"white house" still matches as a phrase', () => {
      assert.equal(matchesAnyKeyword('White House announces infrastructure plan', DC_KEYWORDS), true);
    });

    it('no false positives from old "us " trailing-space hack', () => {
      // "us" is removed from DC keywords; no longer matches via trailing space
      assert.equal(matchesAnyKeyword('Let us know the results', DC_KEYWORDS), false);
      assert.equal(matchesAnyKeyword('Focus on domestic issues', DC_KEYWORDS), false);
    });
  });
});

describe('integration — inferGeoHubsFromTitle keyword flow', () => {
  // Simulates the full flow: title → tokenize → match against hub keyword index

  const MOCK_HUBS = [
    { id: 'damascus', keywords: ['syria', 'damascus', 'assad', 'syrian', 'hts', 'tahrir al-sham', 'hayat tahrir'] },
    { id: 'washington', keywords: ['washington', 'white house', 'pentagon', 'congress', 'biden', 'trump'] },
    { id: 'moscow', keywords: ['moscow', 'kremlin', 'putin', 'russia', 'russian'] },
    { id: 'tehran', keywords: ['iran', 'iranian', 'tehran', 'khamenei'] },
  ];

  function inferHubs(title) {
    const tokens = tokenizeForMatch(title);
    const matched = [];
    for (const hub of MOCK_HUBS) {
      const kws = hub.keywords.filter(kw => matchKeyword(tokens, kw));
      if (kws.length > 0) matched.push({ hubId: hub.id, matchedKeywords: kws });
    }
    return matched;
  }

  it('ambassador article does NOT geo-tag to Damascus', () => {
    const result = inferHubs('French Ambassador outlines new diplomatic strategy for EU');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('damascus'), false);
  });

  it('genuine Syria article geo-tags to Damascus', () => {
    const result = inferHubs('Assad regime forces advance in northern Syria');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('damascus'), true);
  });

  it('HTS headline geo-tags to Damascus', () => {
    const result = inferHubs('HTS forces seize key town near Aleppo');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('damascus'), true);
  });

  it('human rights article does NOT geo-tag to Damascus', () => {
    const result = inferHubs('Human rights groups condemn new legislation');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('damascus'), false);
  });

  it('White House article geo-tags to Washington, not Damascus', () => {
    const result = inferHubs('White House announces Syria sanctions review');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('washington'), true);
    // Also matches Damascus via "syria" — which is correct behavior
    assert.equal(hubIds.includes('damascus'), true);
  });

  it('Ukrainian article does NOT geo-tag to Tehran', () => {
    const result = inferHubs('Ukrainian forces advance near Kharkiv');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('tehran'), false);
  });

  it('tokenizes title once, reuses across all hub checks', () => {
    // Verify that tokenization works correctly for multi-hub matching
    const result = inferHubs('Putin meets Assad in Moscow to discuss Syria');
    const hubIds = result.map(r => r.hubId);
    assert.equal(hubIds.includes('damascus'), true);
    assert.equal(hubIds.includes('moscow'), true);
  });
});
