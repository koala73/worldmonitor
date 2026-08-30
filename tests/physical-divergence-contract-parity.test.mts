import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizePhysicalDivergenceSnapshot } from '../server/_shared/physical-divergence-snapshot.ts';
import { buildProducerBackedPhysicalComparisonFixture } from './helpers/mcp-producer-fixtures.mjs';

const STATES = ['ok', 'insufficient_history', 'stale_input', 'missing_input'] as const;

describe('physical divergence producer and consumer parity', () => {
  for (const state of STATES) {
    it(`derives the producer composite for ${state} readings`, () => {
      const { divergence } = buildProducerBackedPhysicalComparisonFixture(state);
      const normalized = normalizePhysicalDivergenceSnapshot(
        divergence,
        Date.parse(divergence.evaluatedAt),
      );

      assert.deepEqual(normalized.composite, divergence.composite);
    });
  }
});
