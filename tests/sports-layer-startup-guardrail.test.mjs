import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const appSrc = readFileSync(new URL('../src/App.ts', import.meta.url), 'utf8');
const sportsVariantSrc = readFileSync(new URL('../src/config/variants/sports.ts', import.meta.url), 'utf8');

describe('sports layer startup guardrail', () => {
  it('sports variant keeps fixtures enabled by default in variant config', () => {
    assert.match(
      sportsVariantSrc,
      /sportsFixtures:\s*true/,
      'sports variant defaults should enable sportsFixtures for new sessions',
    );
  });

  it('App startup does not force-enable sportsFixtures over stored or URL layer state', () => {
    assert.doesNotMatch(
      appSrc,
      /mapLayers\.sportsFixtures\s*=\s*true/,
      'App startup should not forcibly overwrite sportsFixtures layer state',
    );
  });
});
