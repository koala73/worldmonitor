import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLayerRegistry } from '../scripts/docs-stats.mjs';

function source(entries) {
  return `
export const LAYER_REGISTRY = {
${entries}
};
export const V1_LAYER_EXPLANATION_KEYS = [];
`;
}

describe('docs stats layer-registry extraction', () => {
  it('derives every key across single-line and multiline definitions', () => {
    assert.deepEqual(
      parseLayerRegistry(source(`
  alpha: def('alpha', 'A'),
  beta:
    def('beta', 'B'),
`)).keys,
      ['alpha', 'beta'],
    );
  });

  it('fails closed on a partial or mismatched extraction', () => {
    assert.throws(
      () => parseLayerRegistry(source(`
  alpha: def('alpha', 'A'),
  beta: makeLayer('beta', 'B'),
`)),
      /every LAYER_REGISTRY property must be a matching def/,
    );
    assert.throws(
      () => parseLayerRegistry(source("  alpha: def('beta', 'B'),")),
      /mismatched: alpha -> beta/,
    );
  });
});
