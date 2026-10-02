import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashString } from '../src/utils/hash.ts';
import {
  CACHE_VERSION,
  buildSummaryCacheKey,
  selectUniqueHeadlinePairs,
} from '../src/utils/summary-cache-key.ts';

const HEADLINES = ['Inflation rises to 3.5%', 'Fed holds rates steady', 'Markets react'];

// Identity is 128 bits of SHA-256, so the digest is 32 lowercase hex chars.
// Built from CACHE_VERSION so a future bump does not need a test sweep.
const DIGEST = '[0-9a-f]{32}';
const BRIEF_SHAPE = new RegExp(`^summary:${CACHE_VERSION}:brief:full:en:${DIGEST}$`);

describe('buildSummaryCacheKey', () => {
  it('produces consistent keys for same inputs', async () => {
    const a = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const b = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.equal(a, b);
  });

  it('includes systemAppend suffix when provided', async () => {
    const withoutSA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const withSA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'PMESII-PT analysis');
    assert.notEqual(withoutSA, withSA);
  });

  it('different systemAppend values produce different keys', async () => {
    const keyA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'Framework A');
    const keyB = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'Framework B');
    assert.notEqual(keyA, keyB);
  });

  it('empty systemAppend produces same key as omitting it', async () => {
    const withEmpty = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', '');
    const withUndefined = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.equal(withEmpty, withUndefined);
  });

  it('key carries the current namespace and the documented shape', async () => {
    const base = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    // v9 → v10 on 2026-09-02 (GHSA-9gp4-366w-pcq3): FNV-1a 52-bit identity
    // replaced by truncated SHA-256, retiring every poisonable v9 row.
    // v8 → v9 on 2026-08-01 (#5969 prompt/cache selection parity);
    // v7 → v8 on 2026-07-06 (#4944 DeepSeek cutover).
    assert.match(base, BRIEF_SHAPE);
  });

  it('systemAppend reaches identity without changing the key shape', async () => {
    const key = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'some framework');
    const withoutSA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.notEqual(key, withoutSA, 'systemAppend must reach cache identity');
    assert.match(key, BRIEF_SHAPE);
  });

  // ── bodies (U6) ─────────────────────────────────────────────────────────

  it('every no-body spelling agrees: omitted, empty array, all-empty strings', async () => {
    // Under the old key these asserted the absence of a `:bd` segment. With a
    // single digest there is no segment to look for, and the absence check
    // would pass against any key at all. The real invariant is that the three
    // spellings a caller might use are one cache row, not three.
    const omitted = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const emptyArray = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, []);
    const emptyStrings = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, ['', '', '']);
    assert.equal(emptyArray, omitted, 'empty bodies array must key like omitting bodies');
    assert.equal(emptyStrings, omitted, 'all-empty bodies must key like omitting bodies');
  });

  it('non-empty bodies reach identity', async () => {
    const bodies = ['Body of inflation story', 'Body about Fed holding rates', 'Body about market reaction'];
    const withBodies = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, bodies);
    const withoutBodies = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    assert.notEqual(withBodies, withoutBodies, 'bodies must change cache identity');
    assert.match(withBodies, BRIEF_SHAPE);
  });

  it('bodies change busts the cache', async () => {
    const baseBodies = ['Body A', 'Body B', 'Body C'];
    const shiftedBodies = ['Body A changed', 'Body B', 'Body C'];
    const keyA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, baseBodies);
    const keyB = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, shiftedBodies);
    assert.notEqual(keyA, keyB, 'body drift must produce a distinct key');
  });

  it('bodies are paired 1:1 with headlines — swapping bodies between stories produces a different key', async () => {
    // The headlines themselves are unchanged; only the body pairing flips.
    // A naive "sort bodies independently" would collide these; pair-wise
    // sort keeps identity correct.
    const bodiesA = ['First story body', 'Second story body', 'Third story body'];
    const bodiesB = ['Second story body', 'First story body', 'Third story body'];
    const keyA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, bodiesA);
    const keyB = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, bodiesB);
    assert.notEqual(keyA, keyB, 'pair-wise sort must distinguish shuffled bodies');
  });

  it('bodies.length < headlines.length is padded (no crash)', async () => {
    const k = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, ['only first']);
    assert.ok(k.startsWith(`summary:${CACHE_VERSION}:brief:`));
  });

  it('translate mode ignores bodies', async () => {
    const withBody = await buildSummaryCacheKey(['Translate this'], 'translate', '', 'fr', 'en', undefined, ['body1']);
    const withoutBody = await buildSummaryCacheKey(['Translate this'], 'translate', '', 'fr', 'en');
    assert.equal(withBody, withoutBody, 'translate mode is headline[0]-only; bodies must not shift identity');
  });

  it('bodies longer than 400 chars hash on their first 400 chars only', async () => {
    const bodyA = 'A'.repeat(400);
    const bodyB = 'A'.repeat(400) + 'different tail';
    const keyA = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, [bodyA, '', '']);
    const keyB = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', undefined, [bodyB, '', '']);
    assert.equal(keyA, keyB, 'canonicalizeSummaryInputs clips to 400 before hashing — tails must not shift identity');
  });
});

describe('duplicate-composition stability (#4914)', () => {
  // Prompt generation and key construction share first-arrival headline
  // deduplication, so duplicate composition cannot change only one side.
  it('same unique headline set with different duplicate composition produces the same key', async () => {
    const base = await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en');
    const dupFirst = await buildSummaryCacheKey([HEADLINES[0], ...HEADLINES], 'brief', 'US', 'full', 'en');
    const dupSecond = await buildSummaryCacheKey([HEADLINES[0], HEADLINES[1], HEADLINES[1], HEADLINES[2]], 'brief', 'US', 'full', 'en');
    assert.equal(dupFirst, base, 'a duplicated first headline must not shift identity');
    assert.equal(dupSecond, base, 'a duplicated middle headline must not shift identity');
  });

  it('duplicates must not displace unique headlines from the top-5 key window', async () => {
    const uniques = ['Alpha story', 'Beta story', 'Gamma story', 'Delta story', 'Epsilon story'];
    const padded = ['Alpha story', 'Alpha story', 'Alpha story', ...uniques];
    assert.equal(
      await buildSummaryCacheKey(padded, 'brief', 'US', 'full', 'en'),
      await buildSummaryCacheKey(uniques, 'brief', 'US', 'full', 'en'),
      'headline dedup must run before the slice so dups cannot crowd out unique stories',
    );
  });

  it('a later body for a repeated headline is ignored by both prompt and key', async () => {
    const withTwoBodies = await buildSummaryCacheKey(['Same headline', 'Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body one', 'body two']);
    const withOneBody = await buildSummaryCacheKey(['Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body one']);
    assert.equal(withTwoBodies, withOneBody, 'the prompt keeps only the first body, so the key must do the same');
  });

  it('the first body for a repeated headline remains cache-relevant', async () => {
    const firstBodyOne = await buildSummaryCacheKey(['Same headline', 'Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body one', 'body two']);
    const firstBodyTwo = await buildSummaryCacheKey(['Same headline', 'Same headline'], 'brief', 'US', 'full', 'en', undefined, ['body two', 'body one']);
    assert.notEqual(firstBodyOne, firstBodyTwo, 'changing the first body changes prompt content and must bust the key');
  });

  it('different fifth prompt stories cannot collide after dedup-before-limit (#5969)', async () => {
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
      await buildSummaryCacheKey(zuluPairs.map((pair) => pair.h), 'brief', 'US', 'full', 'en'),
      await buildSummaryCacheKey(yankeePairs.map((pair) => pair.h), 'brief', 'US', 'full', 'en'),
      'a different fifth selected story must change the cache key',
    );
  });
});

describe('cache-key collisions (#5969 review)', () => {
  it('a headline containing the join delimiter cannot collide with a different window', async () => {
    // No sanitizer strips '|', so a bare join made ['A|B','C'] and
    // ['A','B|C'] flatten to the same string — two different story sets, one
    // key, either servable to the other.
    assert.notEqual(
      await buildSummaryCacheKey(['Alpha|Bravo', 'Charlie'], 'brief', 'US', 'full', 'en'),
      await buildSummaryCacheKey(['Alpha', 'Bravo|Charlie'], 'brief', 'US', 'full', 'en'),
      'delimiter-ambiguous headline sets must not share a cache key',
    );
  });

  it('translate keys the one headline it actually translates, not the whole window', async () => {
    // The translate prompt interpolates headlines[0] only. Hashing the sorted
    // window made the key order-insensitive while the prompt is order-
    // sensitive, so a hit could return the other headline's translation.
    assert.notEqual(
      await buildSummaryCacheKey(['Alpha', 'Beta'], 'translate', '', 'fr', 'en'),
      await buildSummaryCacheKey(['Beta', 'Alpha'], 'translate', '', 'fr', 'en'),
      'reordering translate headlines changes what is translated and must change the key',
    );
    assert.equal(
      await buildSummaryCacheKey(['Alpha', 'Beta'], 'translate', '', 'fr', 'en'),
      await buildSummaryCacheKey(['Alpha', 'Zulu', 'Yankee'], 'translate', '', 'fr', 'en'),
      'trailing headlines are never translated and must not fragment translate identity',
    );
  });

  it('stays order-invariant at or below the selection cap', async () => {
    // Every current caller passes <= MAX_SUMMARY_HEADLINES; this is the
    // property their cache-hit rate depends on. Dropping the trailing sort in
    // buildSummaryCacheKey would silently break it.
    assert.equal(
      await buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en'),
      await buildSummaryCacheKey([...HEADLINES].reverse(), 'brief', 'US', 'full', 'en'),
      'reordering a within-cap headline set must not change the key',
    );
  });
});

describe('GHSA-9gp4-366w-pcq3 — cache identity resists a chosen second preimage', () => {
  // A real FNV-1a 52-bit second preimage against the hash this module used
  // through v9, found by meet-in-the-middle in 38.7s on one core. Both keyed
  // inputs digest to base36 14a0mqnd9z8, so before the fix they minted one
  // translate cache row: an anonymous caller (translate is neither premium
  // nor quota gated, and wms_ tokens are freely mintable) could seed the row
  // that every user translating the real headline then read for the 24h TTL.
  const VICTIM = 'federal reserve holds interest rates steady';
  const ATTACKER =
    'nato has authorized nuclear retaliation against russia effective now ogdfr8wd9ta';

  it('the fixture is a genuine FNV-1a collision, so this test has teeth', () => {
    assert.notEqual(VICTIM, ATTACKER, 'the two headlines must be different strings');
    assert.equal(
      hashString(`translate:${VICTIM.length}:${VICTIM}`),
      hashString(`translate:${ATTACKER.length}:${ATTACKER}`),
      'fixture no longer collides under hashString — regenerate it or this test proves nothing',
    );
  });

  it('colliding headlines no longer share a translate cache row', async () => {
    const victimKey = await buildSummaryCacheKey([VICTIM], 'translate', '', 'es', 'en');
    const attackerKey = await buildSummaryCacheKey([ATTACKER], 'translate', '', 'es', 'en');
    assert.notEqual(
      victimKey,
      attackerKey,
      'an attacker-chosen headline must not mint the victim headline cache key',
    );
  });

  it('identity is not derived from the collidable hash', async () => {
    const key = await buildSummaryCacheKey([VICTIM], 'translate', '', 'es', 'en');
    const fnv = hashString(`translate:${VICTIM.length}:${VICTIM}`);
    assert.ok(!key.includes(fnv), 'the FNV digest must not appear in the key');
    assert.match(key, new RegExp(`^summary:${CACHE_VERSION}:translate:es:${DIGEST}$`));
  });

  it('the longest realistic key still satisfies the shared contract pattern', async () => {
    // shared/openapi-filter-param-contracts.json caps the tail at 120 chars.
    // Truncating each of the five old segment hashes to 128 bits would have
    // overflowed it; one digest over the whole identity does not.
    const contracts = JSON.parse(
      readFileSync(new URL('../shared/openapi-filter-param-contracts.json', import.meta.url), 'utf8'),
    );
    const pattern = new RegExp(contracts.newsSummarizeArticleCacheKeyPattern);
    // No options suffix here on purpose. generateSummary appends one
    // (`:optsCB`) for its circuit-breaker key only; the key that travels to
    // getSummarizeArticleCache, and so the one the contract governs, is the
    // bare builder output. The suffix carries uppercase and would not match
    // this pattern, which is why the two keys must stay separate.
    const worstCase = await buildSummaryCacheKey(
      ['A'.repeat(500), 'B'.repeat(500), 'C'.repeat(500), 'D'.repeat(500), 'E'.repeat(500)],
      'analysis',
      'X'.repeat(2000),
      'commodity',
      'zh-tw',
      'Y'.repeat(500),
      ['b1', 'b2', 'b3', 'b4', 'b5'],
    );
    assert.match(worstCase, pattern, `contract rejected ${worstCase.length}-char key: ${worstCase}`);
  });
});
