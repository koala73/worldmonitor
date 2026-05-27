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
});
