import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const clusteringSrc = readFileSync(resolve(root, 'src/services/clustering.ts'), 'utf8');

describe('clusterNewsHybrid semantic clustering cap', () => {
  it('caps the ML semantic-refinement input and preserves overflow clusters', () => {
    assert.match(
      clusteringSrc,
      /export const MAX_SEMANTIC_CLUSTER_INPUT = \d+;/,
      'clustering.ts must expose the semantic refinement cap',
    );
    assert.match(
      clusteringSrc,
      /const semanticCandidates = jaccardClusters\.slice\(0, MAX_SEMANTIC_CLUSTER_INPUT\);/,
      'clusterNewsHybrid must cap the clusters sent to semantic refinement',
    );
    assert.match(
      clusteringSrc,
      /const overflowClusters = jaccardClusters\.slice\(MAX_SEMANTIC_CLUSTER_INPUT\);/,
      'clusterNewsHybrid must retain clusters beyond the semantic cap',
    );
    assert.match(
      clusteringSrc,
      /return \[\.\.\.mergedSemanticClusters, \.\.\.overflowClusters\]/,
      'clusterNewsHybrid must append uncapped overflow clusters after semantic refinement',
    );
  });
});
