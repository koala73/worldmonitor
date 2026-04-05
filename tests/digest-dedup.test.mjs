/**
 * Test: digest fuzzy deduplication merges near-duplicate stories.
 *
 * Run: node --test tests/digest-dedup.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '..', 'scripts', 'seed-digest-notifications.mjs'),
  'utf-8',
);

// ── Extract the dedup functions via dynamic evaluation ────────────────────────
// We extract the pure functions (no side-effects, no imports) to test them.

const STOP_WORDS_BLOCK = src.match(/const STOP_WORDS = new Set\(\[[\s\S]*?\]\);/)?.[0];
const stripSourceSuffix = src.match(/function stripSourceSuffix\(title\) \{[\s\S]*?\n\}/)?.[0];
const extractTitleWords = src.match(/function extractTitleWords\(title\) \{[\s\S]*?\n\}/)?.[0];
const jaccardSimilarity = src.match(/function jaccardSimilarity\(setA, setB\) \{[\s\S]*?\n\}/)?.[0];
const deduplicateStories = src.match(/function deduplicateStories\(stories\) \{[\s\S]*?\n\}/)?.[0];

assert.ok(STOP_WORDS_BLOCK, 'STOP_WORDS not found in source');
assert.ok(stripSourceSuffix, 'stripSourceSuffix not found in source');
assert.ok(extractTitleWords, 'extractTitleWords not found in source');
assert.ok(jaccardSimilarity, 'jaccardSimilarity not found in source');
assert.ok(deduplicateStories, 'deduplicateStories not found in source');

const mod = {};
new Function('mod', `
  ${STOP_WORDS_BLOCK}
  ${stripSourceSuffix}
  ${extractTitleWords}
  ${jaccardSimilarity}
  ${deduplicateStories}
  mod.stripSourceSuffix = stripSourceSuffix;
  mod.extractTitleWords = extractTitleWords;
  mod.jaccardSimilarity = jaccardSimilarity;
  mod.deduplicateStories = deduplicateStories;
`)(mod);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('stripSourceSuffix', () => {
  it('strips "- reuters.com"', () => {
    assert.equal(
      mod.stripSourceSuffix('US fighter jet shot down over Iran - reuters.com'),
      'US fighter jet shot down over Iran',
    );
  });

  it('strips "- Reuters"', () => {
    assert.equal(
      mod.stripSourceSuffix('Downed planes spell new peril for Trump - Reuters'),
      'Downed planes spell new peril for Trump',
    );
  });

  it('strips "- AP News"', () => {
    assert.equal(
      mod.stripSourceSuffix('US military jets hit in Iran war - AP News'),
      'US military jets hit in Iran war',
    );
  });

  it('strips "- apnews.com"', () => {
    assert.equal(
      mod.stripSourceSuffix('US military jets hit in Iran war - apnews.com'),
      'US military jets hit in Iran war',
    );
  });

  it('preserves titles without source suffix', () => {
    assert.equal(
      mod.stripSourceSuffix('Myanmar coup leader elected president'),
      'Myanmar coup leader elected president',
    );
  });
});

describe('deduplicateStories', () => {
  function story(title, score = 10, mentions = 1, hash = undefined) {
    return { title, currentScore: score, mentionCount: mentions, sources: [], severity: 'critical', hash: hash ?? title.slice(0, 8) };
  }

  it('merges near-duplicate Reuters headlines about downed jet', () => {
    const stories = [
      story('US fighter jet shot down over Iran, search underway for crew, US official says - reuters.com', 90),
      story('US fighter jet shot down over Iran, search underway for crew, US officials say - reuters.com', 85),
      story('US fighter jet shot down over Iran, search under way for crew member, US officials say - reuters.com', 80),
      story('US fighter jet shot down over Iran, search under way for crew member, US officials say - Reuters', 75),
      story('US fighter jet shot down over Iran, search underway for crew member, US officials say - Reuters', 70),
    ];
    const result = mod.deduplicateStories(stories);
    assert.equal(result.length, 1, `Expected 1 cluster, got ${result.length}: ${result.map(r => r.title).join(' | ')}`);
    assert.equal(result[0].currentScore, 90);
    assert.equal(result[0].mentionCount, 5);
  });

  it('keeps genuinely different stories separate', () => {
    const stories = [
      story('US fighter jet shot down over Iran', 90),
      story('Myanmar coup leader Min Aung Hlaing elected president', 80),
      story('Brent oil spot price soars to $141', 70),
    ];
    const result = mod.deduplicateStories(stories);
    assert.equal(result.length, 3);
  });

  it('merges same story reported by different outlets with different suffixes', () => {
    const stories = [
      story('Downed planes spell new peril for Trump as Tehran hunts missing US pilot - Reuters', 90),
      story('Downed planes spell new peril for Trump as Tehran hunts missing US pilot - reuters.com', 85),
    ];
    const result = mod.deduplicateStories(stories);
    assert.equal(result.length, 1);
    assert.equal(result[0].currentScore, 90);
  });

  it('merges stories with minor wording differences', () => {
    const stories = [
      story('US rescues airman whose F-15 was downed in Iran, US officials say - Reuters', 90),
      story('Iran says several enemy aircraft destroyed during US pilot rescue mission - Reuters', 80),
      story('Trump, Israel pressure Iran ahead of deadline as search continues for missing US airman - Reuters', 70),
    ];
    const result = mod.deduplicateStories(stories);
    // These are different enough events/angles that they should stay separate
    assert.ok(result.length >= 2, `Expected at least 2 clusters, got ${result.length}`);
  });

  it('carries mergedHashes from all clustered stories for source lookup', () => {
    const stories = [
      story('US fighter jet shot down - reuters.com', 90, 1, 'hash_a'),
      story('US fighter jet shot down - Reuters', 80, 1, 'hash_b'),
      story('US fighter jet shot down - AP News', 70, 1, 'hash_c'),
    ];
    const result = mod.deduplicateStories(stories);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].mergedHashes, ['hash_a', 'hash_b', 'hash_c']);
  });

  it('preserves single stories without modification', () => {
    const stories = [story('Only one story here', 50, 3)];
    const result = mod.deduplicateStories(stories);
    assert.equal(result.length, 1);
    assert.equal(result[0].mentionCount, 3);
    assert.deepEqual(result[0].mergedHashes, [stories[0].hash]);
  });
});
