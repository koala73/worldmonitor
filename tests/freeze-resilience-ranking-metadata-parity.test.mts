import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DOMAIN_ORDER,
  RESILIENCE_RETIRED_DIMENSIONS,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { computeResilienceMethodologyMetadataFromSource } from '../scripts/freeze-resilience-ranking.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCORER_PATH = resolve(here, '../server/worldmonitor/resilience/v1/_dimension-scorers.ts');
const sourceText = readFileSync(SCORER_PATH, 'utf8');

describe('freeze-resilience-ranking methodology parser parity', () => {
  it('matches the runtime scorer registries used by the resilience scorer', () => {
    const expectedActiveDimensionCount = RESILIENCE_DIMENSION_ORDER
      .filter((dimensionId) => !RESILIENCE_RETIRED_DIMENSIONS.has(dimensionId))
      .length;

    assert.deepEqual(computeResilienceMethodologyMetadataFromSource(sourceText), {
      domainCount: RESILIENCE_DOMAIN_ORDER.length,
      serializedDimensionCount: RESILIENCE_DIMENSION_ORDER.length,
      retiredDimensionCount: RESILIENCE_RETIRED_DIMENSIONS.size,
      activeDimensionCount: expectedActiveDimensionCount,
    });
  });
});
