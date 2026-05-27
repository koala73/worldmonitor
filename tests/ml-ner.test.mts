import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTokenClassificationOutput } from '../src/workers/ml-ner.ts';

describe('normalizeTokenClassificationOutput', () => {
  it('normalizes Hugging Face v4 token-classification output into worker NER entities', () => {
    const entities = normalizeTokenClassificationOutput([
      { entity: 'B-PER', score: 0.99, index: 1, word: 'B' },
      { entity: 'B-PER', score: 0.97, index: 2, word: '##iden' },
      { entity: 'B-PER', score: 0.98, index: 4, word: 'Xi' },
      { entity: 'B-LOC', score: 0.99, index: 6, word: 'Tokyo' },
    ], 'Biden met Xi in Tokyo');

    assert.deepEqual(entities.map(({ text, type, start, end }) => ({ text, type, start, end })), [
      { text: 'Biden', type: 'PER', start: 0, end: 5 },
      { text: 'Xi', type: 'PER', start: 10, end: 12 },
      { text: 'Tokyo', type: 'LOC', start: 16, end: 21 },
    ]);
    assert.ok(entities[0]!.confidence > 0.97 && entities[0]!.confidence < 0.99);
  });

  it('preserves grouped output with explicit spans', () => {
    assert.deepEqual(normalizeTokenClassificationOutput([
      { entity_group: 'ORG', score: 0.93, word: 'NATO', start: 0, end: 4 },
    ], 'NATO ministers meet'), [
      { text: 'NATO', type: 'ORG', confidence: 0.93, start: 0, end: 4 },
    ]);
  });

  it('infers spans when v4 token-classification output omits start and end offsets', () => {
    assert.deepEqual(normalizeTokenClassificationOutput([
      { entity: 'B-PER', score: 0.98, word: 'John' },
      { entity: 'I-PER', score: 0.97, word: 'Doe' },
      { entity: 'B-LOC', score: 0.96, word: 'New' },
      { entity: 'I-LOC', score: 0.95, word: 'York' },
    ], 'John Doe moved to New York'), [
      { text: 'John Doe', type: 'PER', confidence: 0.975, start: 0, end: 8 },
      { text: 'New York', type: 'LOC', confidence: 0.955, start: 18, end: 26 },
    ]);
  });

  it('normalizes BIOES tags while preserving singleton entity boundaries', () => {
    const entities = normalizeTokenClassificationOutput([
      { entity: 'S-PER', score: 0.99, word: 'Obama' },
      { entity: 'B-PER', score: 0.96, word: 'John' },
      { entity: 'I-PER', score: 0.94, word: 'Fitzgerald' },
      { entity: 'E-PER', score: 0.95, word: 'Kennedy' },
    ], 'Obama met John Fitzgerald Kennedy');

    assert.deepEqual(entities.map(({ text, type, start, end }) => ({ text, type, start, end })), [
      { text: 'Obama', type: 'PER', start: 0, end: 5 },
      { text: 'John Fitzgerald Kennedy', type: 'PER', start: 10, end: 33 },
    ]);
    assert.equal(entities[0]!.confidence, 0.99);
    assert.ok(entities[1]!.confidence > 0.949 && entities[1]!.confidence < 0.951);
  });
});
