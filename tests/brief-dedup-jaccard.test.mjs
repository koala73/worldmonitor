/**
 * Regression tests for the permanent Jaccard fallback path.
 *
 * The earlier harness parsed scripts/seed-digest-notifications.mjs
 * with regexes to extract the dedup helpers into a Function() sandbox.
 * Now that the logic lives in its own module we import directly — no
 * regex fragility, no drift when the seed script is refactored.
 *
 * Run: node --test tests/brief-dedup-jaccard.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deduplicateStoriesJaccard,
  extractTitleWords,
  jaccardSimilarity,
  stripSourceSuffix,
} from '../scripts/lib/brief-dedup-jaccard.mjs';
import {
  CACHE_KEY_PREFIX,
  JACCARD_MERGE_THRESHOLD,
} from '../scripts/lib/brief-dedup-consts.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

describe('brief-dedup-consts', () => {
  it('exposes the Jaccard merge threshold as a pure constant', () => {
    assert.equal(JACCARD_MERGE_THRESHOLD, 0.55);
  });

  it('embedding cache key prefix is namespaced + versioned', () => {
    // Bump when the embed model or dimension changes — silent threshold
    // drift on model upgrade is the #1 documented regression mode.
    assert.equal(CACHE_KEY_PREFIX, 'brief:emb:v1:text-3-small-512');
  });
});

// ── stripSourceSuffix ─────────────────────────────────────────────────────────

describe('stripSourceSuffix', () => {
  it('strips "- reuters.com"', () => {
    assert.equal(
      stripSourceSuffix('US fighter jet shot down over Iran - reuters.com'),
      'US fighter jet shot down over Iran',
    );
  });

  it('strips "- Reuters"', () => {
    assert.equal(
      stripSourceSuffix('Downed planes spell new peril for Trump - Reuters'),
      'Downed planes spell new peril for Trump',
    );
  });

  it('strips "- AP News"', () => {
    assert.equal(
      stripSourceSuffix('US military jets hit in Iran war - AP News'),
      'US military jets hit in Iran war',
    );
  });

  it('strips "- apnews.com"', () => {
    assert.equal(
      stripSourceSuffix('US military jets hit in Iran war - apnews.com'),
      'US military jets hit in Iran war',
    );
  });

  it('preserves titles without source suffix', () => {
    assert.equal(
      stripSourceSuffix('Myanmar coup leader elected president'),
      'Myanmar coup leader elected president',
    );
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('extractTitleWords', () => {
  it('drops stop-words and 1-2 char tokens', () => {
    const words = extractTitleWords('The US is at war with Iran');
    // 'the', 'us', 'is', 'at', 'with' all drop. Remaining content
    // words: 'war', 'iran'.
    assert.ok(words.has('war'));
    assert.ok(words.has('iran'));
    assert.ok(!words.has('the'));
    assert.ok(!words.has('us'));
    assert.ok(!words.has('is'));
    assert.ok(!words.has('at'));
  });

  it('applies stripSourceSuffix before tokenising', () => {
    const words = extractTitleWords('Iran closes Hormuz - Reuters');
    assert.ok(words.has('iran'));
    assert.ok(words.has('closes'));
    assert.ok(words.has('hormuz'));
    assert.ok(!words.has('reuters'));
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical Sets', () => {
    const a = new Set(['iran', 'hormuz', 'strait']);
    assert.equal(jaccardSimilarity(a, new Set(a)), 1);
  });

  it('returns 0 when either Set is empty', () => {
    assert.equal(jaccardSimilarity(new Set(), new Set(['x'])), 0);
    assert.equal(jaccardSimilarity(new Set(['x']), new Set()), 0);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    assert.equal(jaccardSimilarity(a, b), jaccardSimilarity(b, a));
  });
});

// ── deduplicateStoriesJaccard ─────────────────────────────────────────────────

function story(title, score = 10, mentions = 1, hash = undefined) {
  return {
    title,
    currentScore: score,
    mentionCount: mentions,
    sources: [],
    severity: 'critical',
    hash: hash ?? title.slice(0, 8),
  };
}

describe('deduplicateStoriesJaccard', () => {
  it('merges near-duplicate Reuters headlines about downed jet', () => {
    const stories = [
      story('US fighter jet shot down over Iran, search underway for crew, US official says - reuters.com', 90),
      story('US fighter jet shot down over Iran, search underway for crew, US officials say - reuters.com', 85),
      story('US fighter jet shot down over Iran, search under way for crew member, US officials say - reuters.com', 80),
      story('US fighter jet shot down over Iran, search under way for crew member, US officials say - Reuters', 75),
      story('US fighter jet shot down over Iran, search underway for crew member, US officials say - Reuters', 70),
    ];
    const result = deduplicateStoriesJaccard(stories);
    assert.equal(result.length, 1, `Expected 1 cluster, got ${result.length}: ${result.map((r) => r.title).join(' | ')}`);
    assert.equal(result[0].currentScore, 90);
    assert.equal(result[0].mentionCount, 5);
  });

  it('keeps genuinely different stories separate', () => {
    const stories = [
      story('US fighter jet shot down over Iran', 90),
      story('Myanmar coup leader Min Aung Hlaing elected president', 80),
      story('Brent oil spot price soars to $141', 70),
    ];
    const result = deduplicateStoriesJaccard(stories);
    assert.equal(result.length, 3);
  });

  it('merges same story reported by different outlets with different suffixes', () => {
    const stories = [
      story('Downed planes spell new peril for Trump as Tehran hunts missing US pilot - Reuters', 90),
      story('Downed planes spell new peril for Trump as Tehran hunts missing US pilot - reuters.com', 85),
    ];
    const result = deduplicateStoriesJaccard(stories);
    assert.equal(result.length, 1);
    assert.equal(result[0].currentScore, 90);
  });

  it('merges stories with minor wording differences', () => {
    const stories = [
      story('US rescues airman whose F-15 was downed in Iran, US officials say - Reuters', 90),
      story('Iran says several enemy aircraft destroyed during US pilot rescue mission - Reuters', 80),
      story('Trump, Israel pressure Iran ahead of deadline as search continues for missing US airman - Reuters', 70),
    ];
    const result = deduplicateStoriesJaccard(stories);
    // These are different enough events/angles that they should stay separate.
    assert.ok(result.length >= 2, `Expected at least 2 clusters, got ${result.length}`);
  });

  it('carries mergedHashes from all clustered stories for source lookup', () => {
    const stories = [
      story('US fighter jet shot down - reuters.com', 90, 1, 'hash_a'),
      story('US fighter jet shot down - Reuters', 80, 1, 'hash_b'),
      story('US fighter jet shot down - AP News', 70, 1, 'hash_c'),
    ];
    const result = deduplicateStoriesJaccard(stories);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].mergedHashes, ['hash_a', 'hash_b', 'hash_c']);
  });

  it('preserves single stories without modification', () => {
    const stories = [story('Only one story here', 50, 3)];
    const result = deduplicateStoriesJaccard(stories);
    assert.equal(result.length, 1);
    assert.equal(result[0].mentionCount, 3);
    assert.deepEqual(result[0].mergedHashes, [stories[0].hash]);
  });
});

// ── Orchestrator kill-switch path ────────────────────────────────────────────

describe('brief-dedup orchestrator — jaccard kill switch', () => {
  it('DIGEST_DEDUP_MODE=jaccard routes straight through the fallback', async () => {
    const { deduplicateStories } = await import('../scripts/lib/brief-dedup.mjs');
    let embedCalls = 0;
    const stubEmbed = async () => {
      embedCalls++;
      throw new Error('embedBatch must NOT be called under MODE=jaccard');
    };
    const stories = [
      story('Iran closes Strait of Hormuz', 90, 1, 'h1'),
      story('Iran shuts Strait of Hormuz - Reuters', 85, 1, 'h2'),
      story('Myanmar coup leader elected president', 80, 1, 'h3'),
    ];
    const out = await deduplicateStories(stories, {
      env: { DIGEST_DEDUP_MODE: 'jaccard' },
      embedBatch: stubEmbed,
    });
    assert.equal(embedCalls, 0);
    const expected = deduplicateStoriesJaccard(stories);
    assert.equal(out.length, expected.length);
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i].hash, expected[i].hash);
      assert.deepEqual(out[i].mergedHashes, expected[i].mergedHashes);
      assert.equal(out[i].mentionCount, expected[i].mentionCount);
    }
  });

  it('returns [] for empty input without invoking Jaccard', async () => {
    const { deduplicateStories } = await import('../scripts/lib/brief-dedup.mjs');
    let jaccardCalls = 0;
    const stubJaccard = (s) => {
      jaccardCalls++;
      return deduplicateStoriesJaccard(s);
    };
    const out = await deduplicateStories([], {
      env: { DIGEST_DEDUP_MODE: 'jaccard' },
      jaccard: stubJaccard,
    });
    assert.deepEqual(out, []);
    assert.equal(jaccardCalls, 0);
  });
});
