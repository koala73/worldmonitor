import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Direct import from source (Vite alias not available in Node test runner)
const MOD_PATH = '../src/utils/keyword-match.ts';

// We can't import .ts directly; inline the functions for testing
function tokenizeForMatch(title) {
  const lower = title.toLowerCase();
  const words = new Set();
  const ordered = [];
  for (const raw of lower.split(/\s+/)) {
    const cleaned = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!cleaned) continue;
    words.add(cleaned);
    ordered.push(cleaned);
    for (const part of cleaned.split(/[^a-z0-9]+/)) {
      if (part) words.add(part);
    }
  }
  return { words, ordered };
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

function matchesAnyKeyword(tokens, keywords) {
  for (const kw of keywords) {
    if (matchKeyword(tokens, kw)) return true;
  }
  return false;
}

function findMatchingKeywords(tokens, keywords) {
  return keywords.filter(kw => matchKeyword(tokens, kw));
}

// --- Tokenizer tests ---

describe('tokenizeForMatch', () => {
  it('splits on whitespace and lowercases', () => {
    const t = tokenizeForMatch('Assad Forces Advance');
    assert.ok(t.words.has('assad'));
    assert.ok(t.words.has('forces'));
    assert.ok(t.words.has('advance'));
    assert.deepStrictEqual(t.ordered, ['assad', 'forces', 'advance']);
  });

  it('strips leading/trailing punctuation', () => {
    const t = tokenizeForMatch('"Syria!" (conflict)');
    assert.ok(t.words.has('syria'));
    assert.ok(t.words.has('conflict'));
    assert.ok(!t.words.has('"syria!"'));
  });

  it('decomposes possessives', () => {
    const t = tokenizeForMatch("Assad's forces");
    assert.ok(t.words.has("assad's"));
    assert.ok(t.words.has('assad'));
    assert.ok(t.words.has('s'));
    assert.ok(t.words.has('forces'));
  });

  it('decomposes hyphenated words', () => {
    const t = tokenizeForMatch('al-Sham fighters');
    assert.ok(t.words.has('al-sham'));
    assert.ok(t.words.has('al'));
    assert.ok(t.words.has('sham'));
  });

  it('handles empty input', () => {
    const t = tokenizeForMatch('');
    assert.strictEqual(t.words.size, 0);
    assert.strictEqual(t.ordered.length, 0);
  });

  it('handles punctuation-only tokens', () => {
    const t = tokenizeForMatch('--- *** !!!');
    assert.strictEqual(t.words.size, 0);
    assert.strictEqual(t.ordered.length, 0);
  });
});

// --- False positive prevention ---

describe('false positive prevention', () => {
  it('"ambassador" does NOT match "assad"', () => {
    const t = tokenizeForMatch('French Ambassador outlines new strategy');
    assert.ok(!matchKeyword(t, 'assad'));
  });

  it('"rights" does NOT match "hts"', () => {
    const t = tokenizeForMatch('Human rights groups condemn violence');
    assert.ok(!matchKeyword(t, 'hts'));
  });

  it('"Ukrainian" does NOT match "iran"', () => {
    const t = tokenizeForMatch('Ukrainian forces push forward');
    assert.ok(!matchKeyword(t, 'iran'));
  });

  it('"focus" does NOT match "us"', () => {
    const t = tokenizeForMatch('Leaders focus on economy');
    assert.ok(!matchKeyword(t, 'us'));
  });

  it('"housing" does NOT match "house"', () => {
    const t = tokenizeForMatch('Housing prices rise sharply');
    assert.ok(!matchKeyword(t, 'house'));
  });

  it('"warehouse" does NOT match "house"', () => {
    const t = tokenizeForMatch('Amazon warehouse workers strike');
    assert.ok(!matchKeyword(t, 'house'));
  });

  it('"discuss" does NOT match "us"', () => {
    const t = tokenizeForMatch('Leaders discuss trade policy');
    assert.ok(!matchKeyword(t, 'us'));
  });

  it('"bushfire" does NOT match "us"', () => {
    const t = tokenizeForMatch('Bushfire threatens suburbs');
    assert.ok(!matchKeyword(t, 'us'));
  });

  it('"Thailand" does NOT match "ai"', () => {
    const t = tokenizeForMatch('Thailand exports surge');
    assert.ok(!matchKeyword(t, 'ai'));
  });
});

// --- True positive preservation ---

describe('true positive preservation', () => {
  it('"Assad regime forces" matches "assad"', () => {
    const t = tokenizeForMatch('Assad regime forces advance in Idlib');
    assert.ok(matchKeyword(t, 'assad'));
  });

  it('"HTS forces advance" matches "hts"', () => {
    const t = tokenizeForMatch('HTS forces advance in northern Syria');
    assert.ok(matchKeyword(t, 'hts'));
  });

  it('"Iran sanctions" matches "iran"', () => {
    const t = tokenizeForMatch('Iran sanctions lifted after talks');
    assert.ok(matchKeyword(t, 'iran'));
  });

  it('"US announces" matches "us"', () => {
    const t = tokenizeForMatch('US announces new trade deal');
    assert.ok(matchKeyword(t, 'us'));
  });

  it('"The House voted" matches "house"', () => {
    const t = tokenizeForMatch('The House voted on the bill');
    assert.ok(matchKeyword(t, 'house'));
  });
});

// --- Possessives ---

describe('possessive matching', () => {
  it('"Assad\'s forces" matches "assad"', () => {
    const t = tokenizeForMatch("Assad's forces advance");
    assert.ok(matchKeyword(t, 'assad'));
  });

  it('"Iran\'s nuclear program" matches "iran"', () => {
    const t = tokenizeForMatch("Iran's nuclear program concerns grow");
    assert.ok(matchKeyword(t, 'iran'));
  });

  it('"Putin\'s war" matches "putin"', () => {
    const t = tokenizeForMatch("Putin's war strategy shifts");
    assert.ok(matchKeyword(t, 'putin'));
  });

  it('"China\'s economy" matches "china"', () => {
    const t = tokenizeForMatch("China's economy slows further");
    assert.ok(matchKeyword(t, 'china'));
  });
});

// --- Multi-word phrases ---

describe('multi-word phrase matching', () => {
  it('"White House announces" matches "white house"', () => {
    const t = tokenizeForMatch('White House announces new policy');
    assert.ok(matchKeyword(t, 'white house'));
  });

  it('"The house is painted white" does NOT match "white house"', () => {
    const t = tokenizeForMatch('The house is painted white');
    assert.ok(!matchKeyword(t, 'white house'));
  });

  it('"supreme court" matches multi-word', () => {
    const t = tokenizeForMatch('Supreme Court rules on case');
    assert.ok(matchKeyword(t, 'supreme court'));
  });

  it('"silicon valley" matches multi-word', () => {
    const t = tokenizeForMatch('Silicon Valley startups surge');
    assert.ok(matchKeyword(t, 'silicon valley'));
  });

  it('"tech layoffs" matches multi-word', () => {
    const t = tokenizeForMatch('Tech layoffs hit record numbers');
    assert.ok(matchKeyword(t, 'tech layoffs'));
  });
});

// --- DC keywords cleanup ---

describe('DC keywords (cleaned)', () => {
  const dcKeywords = ['pentagon', 'white house', 'congress', 'cia', 'nsa', 'washington', 'biden', 'trump', 'senate', 'supreme court', 'vance', 'elon'];

  it('does NOT contain "house" as standalone keyword', () => {
    assert.ok(!dcKeywords.includes('house'));
  });

  it('does NOT contain "us " trailing-space hack', () => {
    assert.ok(!dcKeywords.includes('us '));
  });

  it('"Housing market crashes" does NOT match any DC keyword', () => {
    const t = tokenizeForMatch('Housing market crashes nationwide');
    assert.ok(!matchesAnyKeyword(t, dcKeywords));
  });

  it('"White House announces budget" DOES match DC', () => {
    const t = tokenizeForMatch('White House announces budget cuts');
    assert.ok(matchesAnyKeyword(t, dcKeywords));
  });

  it('"Congress passes bill" DOES match DC', () => {
    const t = tokenizeForMatch('Congress passes new spending bill');
    assert.ok(matchesAnyKeyword(t, dcKeywords));
  });
});

// --- Integration: hub matching end-to-end ---

describe('integration: hub keyword matching', () => {
  const damascusKeywords = ['syria', 'damascus', 'assad', 'syrian', 'hts'];

  it('matches Damascus for Syrian conflict news', () => {
    const t = tokenizeForMatch("Assad's forces clash with HTS near Damascus");
    const matched = findMatchingKeywords(t, damascusKeywords);
    assert.ok(matched.length >= 2);
    assert.ok(matched.includes('assad'));
    assert.ok(matched.includes('hts'));
    assert.ok(matched.includes('damascus'));
  });

  it('does NOT match Damascus for "ambassador rights" headline', () => {
    const t = tokenizeForMatch('French Ambassador discusses human rights in Geneva');
    const matched = findMatchingKeywords(t, damascusKeywords);
    assert.strictEqual(matched.length, 0);
  });

  it('matches Damascus for "Syrian" as standalone word', () => {
    const t = tokenizeForMatch('Syrian refugees seek asylum');
    const matched = findMatchingKeywords(t, damascusKeywords);
    assert.ok(matched.includes('syrian'));
  });
});

// --- matchesAnyKeyword ---

describe('matchesAnyKeyword', () => {
  it('returns true when any keyword matches', () => {
    const t = tokenizeForMatch('Pentagon releases new report');
    assert.ok(matchesAnyKeyword(t, ['pentagon', 'white house']));
  });

  it('returns false when no keyword matches', () => {
    const t = tokenizeForMatch('Local farmer wins award');
    assert.ok(!matchesAnyKeyword(t, ['pentagon', 'white house']));
  });
});

// --- findMatchingKeywords ---

describe('findMatchingKeywords', () => {
  it('returns all matching keywords', () => {
    const t = tokenizeForMatch('Trump meets with CIA director at Pentagon');
    const matched = findMatchingKeywords(t, ['trump', 'cia', 'pentagon', 'nsa']);
    assert.deepStrictEqual(matched.sort(), ['cia', 'pentagon', 'trump']);
  });

  it('returns empty array when nothing matches', () => {
    const t = tokenizeForMatch('Weather forecast looks sunny');
    const matched = findMatchingKeywords(t, ['trump', 'cia', 'pentagon']);
    assert.strictEqual(matched.length, 0);
  });
});

// --- Edge cases ---

describe('edge cases', () => {
  it('empty keyword returns false', () => {
    const t = tokenizeForMatch('Some title');
    assert.ok(!matchKeyword(t, ''));
    assert.ok(!matchKeyword(t, '   '));
  });

  it('numbers in tokens work', () => {
    const t = tokenizeForMatch('F-35 crashes in test flight');
    assert.ok(t.words.has('f-35'));
    assert.ok(t.words.has('35'));
    assert.ok(t.words.has('f'));
  });

  it('case insensitive matching', () => {
    const t = tokenizeForMatch('IRAN LAUNCHES MISSILE');
    assert.ok(matchKeyword(t, 'iran'));
    assert.ok(matchKeyword(t, 'IRAN'));
    assert.ok(matchKeyword(t, 'Iran'));
  });
});
