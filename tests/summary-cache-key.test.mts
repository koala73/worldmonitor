import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummaryCacheKey,
  selectUniqueHeadlinePairs,
} from '../src/utils/summary-cache-key.ts';

const HEADLINES = ['Inflation rises to 3.5%', 'Fed holds rates steady', 'Markets react'];

describe('buildSummaryCacheKey', () => {
  it('produces consistent keys for same inputs', () => {
    const a = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const b = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.equal(a, b);
  });

  it('includes systemAppend suffix when provided', () => {
    const withoutSA = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const withSA = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'PMESII-PT analysis');
    assert.notEqual(withoutSA, withSA);
  });

  it('different systemAppend values produce different keys', () => {
    const keyA = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'Framework A');
    const keyB = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'Framework B');
    assert.notEqual(keyA, keyB);
  });

  it('empty systemAppend produces same key as omitting it', () => {
    const withEmpty = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', '');
    const withUndefined = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.equal(withEmpty, withUndefined);
  });

  it('systemAppend suffix does not break existing namespace', () => {
    const base = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    // v8 → v9 on 2026-08-01 (#5969 prompt/cache selection parity);
    // v7 → v8 on 2026-07-06 (#4944 DeepSeek cutover).
    assert.match(base, /^summary:v9:/);
    assert.doesNotMatch(base, /:fw/);
  });

  it('systemAppend key contains :fw suffix', () => {
    const key = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'some framework');
    assert.match(key, /:fw[0-9a-z]+$/);
  });

  // ── bodies (U6) ─────────────────────────────────────────────────────────

  it('omitting bodies produces no :b segment (byte-identical to today for headline-only callers)', () => {
    const k = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.doesNotMatch(k, /:bd[0-9a-z]+/, 'no bodies → no :b segment');
  });

  it('empty bodies array produces no :b segment', () => {
    const k = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, []);
    assert.doesNotMatch(k, /:bd[0-9a-z]+/, 'empty bodies → no :b segment');
  });

  it('all-empty-string bodies produce no :b segment', () => {
    const k = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, ['', '', '']);
    assert.doesNotMatch(k, /:bd[0-9a-z]+/, 'no non-empty body → no :b segment');
  });

  it('non-empty bodies append a :b segment', () => {
    const bodies = ['Body of inflation story', 'Body about Fed holding rates', 'Body about market reaction'];
    const k = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, bodies);
    assert.match(k, /:bd[0-9a-z]+/);
  });

  it('bodies change busts the cache', () => {
    const baseBodies = ['Body A', 'Body B', 'Body C'];
    const shiftedBodies = ['Body A changed', 'Body B', 'Body C'];
    const keyA = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, baseBodies);
    const keyB = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, shiftedBodies);
    assert.notEqual(keyA, keyB, 'body drift must produce a distinct key');
  });

  it('bodies are paired 1:1 with headlines — swapping bodies between stories produces a different key', () => {
    // The headlines themselves are unchanged; only the body pairing flips.
    // A naive "sort bodies independently" would collide these; pair-wise
    // sort keeps identity correct.
    const bodiesA = ['First story body', 'Second story body', 'Third story body'];
    const bodiesB = ['Second story body', 'First story body', 'Third story body'];
    const keyA = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, bodiesA);
    const keyB = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, bodiesB);
    assert.notEqual(keyA, keyB, 'pair-wise sort must distinguish shuffled bodies');
  });

  it('bodies.length < headlines.length is padded (no crash)', () => {
    const k = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, ['only first']);
    assert.ok(k.startsWith('summary:v9:brief:'));
  });

  it('translate mode ignores bodies (no :b segment)', () => {
    const k = buildSummaryCacheKey(['Translate this'], 'translate', '', 'fr', 'en', undefined, ['body1']);
    assert.doesNotMatch(k, /:bd[0-9a-z]+/, 'translate mode is headline[0]-only; bodies must not shift identity');
  });

  it('bodies longer than 400 chars hash on their first 400 chars only', () => {
    const bodyA = 'A'.repeat(400);
    const bodyB = 'A'.repeat(400) + 'different tail';
    const keyA = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, [bodyA, '', '']);
    const keyB = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, [bodyB, '', '']);
    assert.equal(keyA, keyB, 'canonicalizeSummaryInputs clips to 400 before hashing — tails must not shift identity');
  });
});

describe('duplicate-composition stability (#4914)', () => {
  // Prompt generation and key construction share first-arrival headline
  // deduplication, so duplicate composition cannot change only one side.
  it('same unique headline set with different duplicate composition produces the same key', () => {
    const base = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const dupFirst = buildSummaryCacheKey([HEADLINES[0], ...HEADLINES], 'brief', 'US', 'full', 'en');
    const dupSecond = buildSummaryCacheKey([HEADLINES[0], HEADLINES[1], HEADLINES[1], HEADLINES[2]], 'brief', 'US', 'full', 'en');
    assert.equal(dupFirst, base, 'a duplicated first headline must not shift identity');
    assert.equal(dupSecond, base, 'a duplicated middle headline must not shift identity');
  });

  it('duplicates must not displace unique headlines from the top-5 key window', () => {
    const uniques = ['Alpha story', 'Beta story', 'Gamma story', 'Delta story', 'Epsilon story'];
    const padded = ['Alpha story', 'Alpha story', 'Alpha story', ...uniques];
    assert.equal(
      buildSummaryCacheKey(padded, 'brief', 'US', 'full', 'en'),
      buildSummaryCacheKey(uniques, 'brief', 'US', 'full', 'en'),
      'headline dedup must run before the slice so dups cannot crowd out unique stories',
    );
  });

  it('a later body for a repeated headline is ignored by both prompt and key', () => {
    const withTwoBodies = buildSummaryCacheKey(['Same headline', 'Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body one', 'body two']);
    const withOneBody = buildSummaryCacheKey(['Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body one']);
    assert.equal(withTwoBodies, withOneBody, 'the prompt keeps only the first body, so the key must do the same');
  });

  it('the first body for a repeated headline remains cache-relevant', () => {
    const firstBodyOne = buildSummaryCacheKey(['Same headline', 'Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body one', 'body two']);
    const firstBodyTwo = buildSummaryCacheKey(['Same headline', 'Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body two', 'body one']);
    assert.notEqual(firstBodyOne, firstBodyTwo, 'changing the first body changes prompt content and must bust the key');
  });

  it('different fifth prompt stories cannot collide after dedup-before-limit (#5969)', () => {
    const zuluPairs = [
      { h: 'Alpha', b: '' },
      { h: 'Alpha', b: '' },
      { h: 'Beta', b: '' },
      { h: 'Charlie', b: '' },
      { h: 'Delta', b: '' },
      { h: 'Zulu', b: '' },
      { h: 'Echo', b: '' },
    ];
    const yankeePairs = zuluPairs.map((pair) => (
      pair.h === 'Zulu' ? { h: 'Yankee', b: '' } : pair
    ));

    assert.deepEqual(
      selectUniqueHeadlinePairs(zuluPairs).map((pair) => pair.h),
      ['Alpha', 'Beta', 'Charlie', 'Delta', 'Zulu'],
    );
    assert.deepEqual(
      selectUniqueHeadlinePairs(yankeePairs).map((pair) => pair.h),
      ['Alpha', 'Beta', 'Charlie', 'Delta', 'Yankee'],
    );
    assert.notEqual(
      buildSummaryCacheKey(zuluPairs.map((pair) => pair.h), 'brief', 'US', 'full', 'en'),
      buildSummaryCacheKey(yankeePairs.map((pair) => pair.h), 'brief', 'US', 'full', 'en'),
      'a different fifth selected story must change the cache key',
    );
  });
});

describe('cache-key collisions (#5969 review)', () => {
  it('a headline containing the join delimiter cannot collide with a different window', () => {
    // No sanitizer strips '|', so a bare join made ['A|B','C'] and
    // ['A','B|C'] flatten to the same string — two different story sets, one
    // key, either servable to the other.
    assert.notEqual(
      buildSummaryCacheKey(['Alpha|Bravo', 'Charlie'], 'brief', 'US', 'full', 'en'),
      buildSummaryCacheKey(['Alpha', 'Bravo|Charlie'], 'brief', 'US', 'full', 'en'),
      'delimiter-ambiguous headline sets must not share a cache key',
    );
  });

  it('translate keys the one headline it actually translates, not the whole window', () => {
    // The translate prompt interpolates headlines[0] only. Hashing the sorted
    // window made the key order-insensitive while the prompt is order-
    // sensitive, so a hit could return the other headline's translation.
    assert.notEqual(
      buildSummaryCacheKey(['Alpha', 'Beta'], 'translate', '', 'fr', 'en'),
      buildSummaryCacheKey(['Beta', 'Alpha'], 'translate', '', 'fr', 'en'),
      'reordering translate headlines changes what is translated and must change the key',
    );
    assert.equal(
      buildSummaryCacheKey(['Alpha', 'Beta'], 'translate', '', 'fr', 'en'),
      buildSummaryCacheKey(['Alpha', 'Zulu', 'Yankee'], 'translate', '', 'fr', 'en'),
      'trailing headlines are never translated and must not fragment translate identity',
    );
  });

  it('stays order-invariant at or below the selection cap', () => {
    // Every current caller passes <= MAX_SUMMARY_HEADLINES; this is the
    // property their cache-hit rate depends on. Dropping the trailing sort in
    // buildSummaryCacheKey would silently break it.
    assert.equal(
      buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en'),
      buildSummaryCacheKey([...HEADLINES].reverse(), 'brief', 'US', 'full', 'en'),
      'reordering a within-cap headline set must not change the key',
    );
  });
});
