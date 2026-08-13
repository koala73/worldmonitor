import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  buildSnapshotMethodology,
  computeResilienceMethodologyMetadataFromSource,
} from '../scripts/freeze-resilience-ranking.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCORER_PATH = resolve(here, '../server/worldmonitor/resilience/v1/_dimension-scorers.ts');
const sourceText = readFileSync(SCORER_PATH, 'utf8');

describe('freeze-resilience-ranking methodology metadata', () => {
  it('derives the active dimension count from the scorer registries', () => {
    const metadata = computeResilienceMethodologyMetadataFromSource(sourceText);

    // 2026-08-10: +1 serialized / +1 active for the flag-dark `education` dim.
    assert.equal(metadata.domainCount, 6);
    assert.equal(metadata.serializedDimensionCount, 23);
    assert.equal(metadata.retiredDimensionCount, 2);
    assert.equal(metadata.activeDimensionCount, 21);
  });

  it('builds frozen snapshot methodology with the live active dimension count', () => {
    const metadata = computeResilienceMethodologyMetadataFromSource(sourceText);
    const methodology = buildSnapshotMethodology(
      { overallScoreFormula: 'test formula' },
      metadata,
    );

    assert.equal(methodology.dimensionCount, metadata.activeDimensionCount);
    assert.match(methodology.coverageLabel, /21 per-dimension coverage values/);
  });
});
