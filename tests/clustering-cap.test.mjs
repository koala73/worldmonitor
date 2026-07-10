import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const analysisCoreSrc = readFileSync(resolve(root, 'src/services/analysis-core.ts'), 'utf8');
const clusteringSrc = readFileSync(resolve(root, 'src/services/clustering.ts'), 'utf8');
const workerSrc = readFileSync(resolve(root, 'src/workers/analysis.worker.ts'), 'utf8');

describe('news clustering caps unbounded input work', () => {
  it('caps the shared clustering input before O(n^2) dedupe work', () => {
    assert.match(
      analysisCoreSrc,
      /export const MAX_CLUSTER_NEWS_ITEMS = \d+;/,
      'analysis-core must expose the shared clustering input cap',
    );
    const capIdx = analysisCoreSrc.indexOf('const boundedItems = items.length > MAX_CLUSTER_NEWS_ITEMS');
    const worksetIdx = analysisCoreSrc.indexOf('const itemsWithTier: NewsItemWithTier[] = boundedItems.map');
    assert.ok(capIdx !== -1, 'clusterNewsCore must build a bounded input set');
    assert.ok(worksetIdx !== -1, 'clusterNewsCore must cluster from boundedItems');
    assert.ok(capIdx < worksetIdx, 'clusterNewsCore must cap input before tokenization/dedupe work starts');
    assert.match(workerSrc, /const clusters = clusterNewsCore\(items, getSourceTier\);/);
  });

  it('caps ML semantic-refinement input and preserves overflow clusters', () => {
    assert.match(
      clusteringSrc,
      /export const MAX_SEMANTIC_CLUSTER_INPUT = \d+;/,
      'clustering.ts must expose the semantic refinement cap',
    );
    assert.match(
      clusteringSrc,
      /function compareClustersForSemanticCandidate\(a: ClusteredEvent, b: ClusteredEvent\): number \{[\s\S]*?b\.sourceCount - a\.sourceCount[\s\S]*?getSourceTier\(a\.primarySource\) - getSourceTier\(b\.primarySource\)[\s\S]*?b\.lastUpdated\.getTime\(\) - a\.lastUpdated\.getTime\(\)/,
      'clusterNewsHybrid must rank semantic candidates by signal strength before capping',
    );
    assert.match(
      clusteringSrc,
      /const rankedSemanticInput = \[\.\.\.jaccardClusters\]\.sort\(compareClustersForSemanticCandidate\);/,
      'clusterNewsHybrid must sort the semantic candidate pool before slicing',
    );
    assert.match(
      clusteringSrc,
      /const semanticCandidates = rankedSemanticInput\.slice\(0, MAX_SEMANTIC_CLUSTER_INPUT\);/,
      'clusterNewsHybrid must cap the ranked clusters sent to semantic refinement',
    );
    assert.match(
      clusteringSrc,
      /const overflowClusters = rankedSemanticInput\.slice\(MAX_SEMANTIC_CLUSTER_INPUT\);/,
      'clusterNewsHybrid must retain clusters beyond the semantic cap',
    );
    assert.match(
      clusteringSrc,
      /return \[\.\.\.mergedSemanticClusters, \.\.\.overflowClusters\]/,
      'clusterNewsHybrid must append uncapped overflow clusters after semantic refinement',
    );
  });
});
