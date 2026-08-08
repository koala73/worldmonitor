import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DATASETS, buildMarketSnapshot, marketSnapshotToMarkdown, normalizeDataset } from '../api/_market-snapshot.js';

describe('market snapshot export', () => {
  const def = { id: 'x', key: 'x', domain: 'gold', source: 'test', cadenceMin: 5, staleAfterMin: 30 };
  it('never invents a value for missing/error inputs', () => {
    assert.deepEqual(normalizeDataset(def, { result: null }, 1), { ...def, status: 'missing', data: null, fetchedAt: null, observedAt: null, ageMin: null, quality: ['missing'] });
    assert.equal(normalizeDataset(def, { error: 'down' }, 1).data, null);
  });
  it('uses envelope metadata for freshness and marks stale data', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const entry = { result: JSON.stringify({ _seed: { fetchedAt: now - 31 * 60000 }, data: { value: 7 } }) };
    const out = normalizeDataset(def, entry, now);
    assert.equal(out.status, 'stale');
    assert.equal(out.ageMin, 31);
    assert.deepEqual(out.data, { value: 7 });
  });
  it('builds JSON and Markdown from the same snapshot object', () => {
    const entries = DATASETS.map(() => ({ result: null }));
    const snapshot = buildMarketSnapshot(entries, Date.parse('2026-08-08T00:00:00Z'));
    assert.equal(snapshot.summary.missing, DATASETS.length);
    const markdown = marketSnapshotToMarkdown(snapshot);
    assert.match(markdown, /Not a prediction, predictive score/);
    assert.match(markdown, /Status: missing/);
    assert.doesNotMatch(markdown, /undefined/);
  });
});
