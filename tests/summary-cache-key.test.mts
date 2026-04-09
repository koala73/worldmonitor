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
    assert.match(base, /^summary:v5:/);
    assert.doesNotMatch(base, /:fw/);
  });

  it('systemAppend key contains :fw suffix', () => {
    const key = buildSummaryCacheKey(HEADLINES, 'brief', 'US', 'full', 'en', 'some framework');
    assert.match(key, /:fw[0-9a-z]+$/);
  });
});
