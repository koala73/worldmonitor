import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryCacheKey } from '../src/utils/summary-cache-key.ts';

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
    // v5 → v6 on 2026-04-24 (RSS-description grounding fix, U6).
    assert.match(base, /^summary:v6:/);
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
    assert.ok(k.startsWith('summary:v6:brief:'));
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
