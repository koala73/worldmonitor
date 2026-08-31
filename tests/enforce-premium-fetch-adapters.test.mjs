import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DELEGATING_ADAPTERS,
  PREMIUM_FETCH_SRC,
  assertDelegatingAdapters,
} from '../scripts/enforce-premium-fetch.mjs';

const ADAPTERS = new Set(['proFreshRpcFetch']);

/**
 * Canonical affirmative delegation. Mutations below start from this text so a
 * green run is evidence the proof rejected that exact edit — not a fixture
 * that never resembled the live adapter.
 */
const CANONICAL = `export function proFreshRpcFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (isPremiumRpcTarget(input)) {
    return premiumFetch(input, init);
  }
  return globalThis.fetch(input, init);
}
`;

function mutate(source, find, replacement) {
  assert.ok(source.includes(find), `canonical fixture lost the text to mutate: ${find}`);
  return source.replace(find, replacement);
}

describe('assertDelegatingAdapters — affirmative premium delegation', () => {
  it('accepts the live premium-fetch.ts adapters', () => {
    assert.doesNotThrow(() => assertDelegatingAdapters());
    assert.ok(DELEGATING_ADAPTERS.has('proFreshRpcFetch'));
    assert.match(readFileSync(PREMIUM_FETCH_SRC, 'utf8'), /export function proFreshRpcFetch/);
  });

  it('accepts the canonical affirmative fixture', () => {
    assert.doesNotThrow(() => assertDelegatingAdapters(CANONICAL, ADAPTERS));
  });

  it('rejects an inverted guard that still mentions both names', () => {
    const inverted = mutate(
      CANONICAL,
      'if (isPremiumRpcTarget(input))',
      'if (!isPremiumRpcTarget(input))',
    );
    assert.throws(
      () => assertDelegatingAdapters(inverted, ADAPTERS),
      /no longer routes isPremiumRpcTarget/,
    );
  });

  it('rejects a guard that calls isPremiumRpcTarget with the wrong identifier', () => {
    const wrongArg = mutate(
      CANONICAL,
      'if (isPremiumRpcTarget(input))',
      'if (isPremiumRpcTarget(init))',
    );
    assert.throws(
      () => assertDelegatingAdapters(wrongArg, ADAPTERS),
      /no longer routes isPremiumRpcTarget/,
    );
  });

  it('rejects a then-branch that returns premiumFetch with swapped identifiers', () => {
    const swapped = mutate(
      CANONICAL,
      'return premiumFetch(input, init);',
      'return premiumFetch(init, input);',
    );
    assert.throws(
      () => assertDelegatingAdapters(swapped, ADAPTERS),
      /no longer routes isPremiumRpcTarget/,
    );
  });

  it('rejects a text-only mutation the old substring scan would accept', () => {
    const textOnly = mutate(
      CANONICAL,
      'if (isPremiumRpcTarget(input)) {\n    return premiumFetch(input, init);\n  }',
      "if ('isPremiumRpcTarget') {\n    return 'premiumFetch(input, init)';\n  }",
    );
    assert.throws(
      () => assertDelegatingAdapters(textOnly, ADAPTERS),
      /no longer routes isPremiumRpcTarget/,
    );
  });
});
