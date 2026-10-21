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
    const parsed = parseLayerRegistry(source(`
  alpha: def('alpha', 'A'),
  beta:
    def('beta', 'B'),
  premium: def('premium', 'P', 'premium', 'Premium', ['flat'], 'locked'),
  desktopPremium: def('desktopPremium', 'D', 'desktopPremium', 'Desktop', ['flat'], desktop ? 'locked' : undefined),
`));
    assert.deepEqual(parsed.keys, ['alpha', 'beta', 'desktopPremium', 'premium']);
    assert.deepEqual(parsed.lockedKeys, ['premium']);
  });

  it('ignores commented-out definitions and locked markers', () => {
    const parsed = parseLayerRegistry(source(`
  alpha: def('alpha', 'A'),
  // retiredLine: def('retiredLine', 'R', 'retired', 'Retired', ['flat'], 'locked'),
  /*
  retiredBlock: def('retiredBlock', 'R', 'retired', 'Retired', ['flat'], 'locked'),
  */
`));
    assert.deepEqual(parsed.keys, ['alpha']);
    assert.deepEqual(parsed.lockedKeys, []);
  });

  it('ignores definition-shaped text inside template literals', () => {
    const parsed = parseLayerRegistry(source(`
  alpha: def('alpha', 'A'),
  copy: def('copy', 'C', 'copy', \`\n  retiredTemplate: def('retiredTemplate', 'R'),\`),
`));
    assert.deepEqual(parsed.keys, ['alpha', 'copy']);
  });

  it('supports static quoted keys and rejects unsupported property forms', () => {
    assert.deepEqual(parseLayerRegistry(source("  'alpha': def('alpha', 'A'),")).keys, ['alpha']);
    for (const entry of [
      '  ...EXTRA,',
      "  ['alpha']: def('alpha', 'A'),",
      "  alpha() { return def('alpha', 'A'); },",
    ]) {
      assert.throws(() => parseLayerRegistry(source(entry)), /LAYER_REGISTRY/);
    }
  });

  it('fails closed on a partial or mismatched extraction', () => {
    assert.throws(
      () => parseLayerRegistry(source(`
  alpha: def('alpha', 'A'),
  beta: makeLayer('beta', 'B'),
`)),
      /LAYER_REGISTRY property beta must use def/,
    );
    assert.throws(
      () => parseLayerRegistry(source("  alpha: def('beta', 'B'),")),
      /mismatched: alpha -> beta/,
    );
  });
});
