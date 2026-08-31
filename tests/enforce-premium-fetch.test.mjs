import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasValidPremiumDelegation } from '../scripts/enforce-premium-fetch.mjs';

const valid = `
  export function proFreshRpcFetch(input, init) {
    if (isPremiumRpcTarget(input)) {
      return premiumFetch(input, init);
    }
    return globalThis.fetch(input, init);
  }
`;

const fixtures = [
  ['valid adapter delegation', valid, true],
  ['negated guard', valid.replace('if (isPremiumRpcTarget(input))', 'if (!isPremiumRpcTarget(input))'), false],
  ['wrong guard argument', valid.replace('isPremiumRpcTarget(input)', 'isPremiumRpcTarget(other)'), false],
  ['wrong fetch input', valid.replace('premiumFetch(input, init)', 'premiumFetch(other, init)'), false],
  ['wrong fetch init', valid.replace('premiumFetch(input, init)', 'premiumFetch(input, other)'), false],
  ['wrong fetch arity', valid.replace('premiumFetch(input, init)', 'premiumFetch(input)'), false],
  [
    'comment-only mention',
    valid.replace('return premiumFetch(input, init);', '// premiumFetch(input, init)\n      return globalThis.fetch(input, init);'),
    false,
  ],
  [
    'else-only delegation',
    valid.replace(
      `if (isPremiumRpcTarget(input)) {
      return premiumFetch(input, init);
    }
    return globalThis.fetch(input, init);`,
      `if (isPremiumRpcTarget(input)) {
      return globalThis.fetch(input, init);
    } else {
      return premiumFetch(input, init);
    }
    `,
    ),
    false,
  ],
];

describe('premium fetch adapter delegation proof', () => {
  for (const [name, source, expected] of fixtures) {
    it(name, () => {
      assert.equal(hasValidPremiumDelegation(source), expected);
    });
  }
});
