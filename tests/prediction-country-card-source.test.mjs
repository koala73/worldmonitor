import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const deepDive = readFileSync(new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');
const legacyBrief = readFileSync(new URL('../src/components/CountryBriefPage.ts', import.meta.url), 'utf8');

describe('country prediction-market source attribution', () => {
  it('renders the provider in the active deep-dive card', () => {
    assert.match(deepDive, /this\.el\('span', 'prediction-source', source\)/);
    assert.match(deepDive, /sourceBadge\.dataset\.source\s*=\s*market\.source/);
  });

  it('renders the provider in the legacy country brief card', () => {
    assert.match(legacyBrief, /class="prediction-source" data-source="\$\{sourceKey\}"/);
    assert.match(legacyBrief, />\$\{source\}<\/span>/);
  });
});
