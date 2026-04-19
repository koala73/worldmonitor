/**
 * Regression tests for scripts/tools/shadow-sample.mjs's pure
 * enumeration path. The real tool reads archives via Upstash SCAN;
 * this suite drives enumeratePairs() directly with synthesised
 * archive objects so the logic is deterministic.
 *
 * Run: node --test tests/brief-dedup-shadow-sample.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { enumeratePairs } from '../scripts/tools/shadow-sample.mjs';

// ── Fixture builder ───────────────────────────────────────────────────────────

function archive({ ts, ids, embedClusters, jaccardClusters, titles }) {
  return {
    timestamp: ts,
    storyIds: ids,
    normalizedTitles: titles ?? ids.map((h) => `title for ${h}`),
    embeddingClusters: embedClusters,
    jaccardClusters: jaccardClusters,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('enumeratePairs — disagreements mode', () => {
  it('includes a pair that disagrees in later batch even when a prior batch agreed', () => {
    // This is the bias bug: earlier implementations added pairs to a
    // dedup Set BEFORE checking agreement, so the agreeing batch X
    // silently claimed the slot and the disagreeing batch Y got
    // dropped. Under unspecified SCAN order the sampler could omit
    // real disagreements.
    const agreeingFirst = archive({
      ts: 1000,
      ids: ['a', 'b'],
      embedClusters: [['a', 'b']],   // merged
      jaccardClusters: [['a', 'b']], // merged — AGREE
    });
    const disagreeingSecond = archive({
      ts: 2000,
      ids: ['a', 'b'],
      embedClusters: [['a', 'b']],   // merged
      jaccardClusters: [['a'], ['b']], // split — DISAGREE
    });

    const pairs = enumeratePairs([agreeingFirst, disagreeingSecond], 'disagreements');
    assert.equal(pairs.size, 1, 'the (a,b) pair must be included');
    const rec = [...pairs.values()][0];
    assert.equal(rec.embedMerged, true);
    assert.equal(rec.jaccardMerged, false);
    assert.equal(rec.batchTs, 2000, 'representative record is the disagreeing batch');
  });

  it('reversing the archive order still includes the disagreement', () => {
    // Symmetry check: with the bug, one order drops the
    // disagreement, the other keeps it. After the fix, both orders
    // include the pair.
    const agreeing = archive({
      ts: 1000,
      ids: ['a', 'b'],
      embedClusters: [['a', 'b']],
      jaccardClusters: [['a', 'b']],
    });
    const disagreeing = archive({
      ts: 2000,
      ids: ['a', 'b'],
      embedClusters: [['a', 'b']],
      jaccardClusters: [['a'], ['b']],
    });

    for (const archives of [[agreeing, disagreeing], [disagreeing, agreeing]]) {
      const pairs = enumeratePairs(archives, 'disagreements');
      assert.equal(pairs.size, 1);
      const rec = [...pairs.values()][0];
      assert.notEqual(rec.embedMerged, rec.jaccardMerged);
    }
  });

  it('omits pairs that always agreed across all batches', () => {
    const both = archive({
      ts: 1000,
      ids: ['a', 'b', 'c'],
      // Embed and Jaccard agree on (a,b) and (a,c) throughout.
      embedClusters: [['a', 'b', 'c']],
      jaccardClusters: [['a', 'b', 'c']],
    });
    const pairs = enumeratePairs([both], 'disagreements');
    assert.equal(pairs.size, 0);
  });
});

describe('enumeratePairs — population mode', () => {
  it('includes every co-occurring pair uniquely across batches', () => {
    const b1 = archive({
      ts: 1000,
      ids: ['a', 'b'],
      embedClusters: [['a', 'b']],
      jaccardClusters: [['a'], ['b']],
    });
    const b2 = archive({
      ts: 2000,
      ids: ['b', 'c'],
      embedClusters: [['b'], ['c']],
      jaccardClusters: [['b'], ['c']],
    });
    const pairs = enumeratePairs([b1, b2], 'population');
    // (a,b) and (b,c) — two unique pairs.
    assert.equal(pairs.size, 2);
    assert.ok(pairs.has('a|b'));
    assert.ok(pairs.has('b|c'));
  });

  it('dedupes when the same pair co-occurs in multiple batches', () => {
    const batchX = archive({
      ts: 1000,
      ids: ['a', 'b', 'c'],
      embedClusters: [['a', 'b'], ['c']],
      jaccardClusters: [['a'], ['b'], ['c']],
    });
    const batchY = archive({
      ts: 2000,
      ids: ['a', 'b', 'd'],
      embedClusters: [['a', 'b'], ['d']],
      jaccardClusters: [['a', 'b'], ['d']],
    });
    const pairs = enumeratePairs([batchX, batchY], 'population');
    // Unique pairs across both batches: a-b, a-c, b-c, a-d, b-d.
    assert.equal(pairs.size, 5);
  });
});
