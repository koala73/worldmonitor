import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/components/CountryBriefPage.ts', import.meta.url), 'utf8');

describe('CountryBriefPage citation link handling', () => {
  it('only intercepts in-page citation anchors', () => {
    const start = source.indexOf('// Citation links');
    const end = source.indexOf('// Clicking anywhere else closes the export menu if open', start);
    const handler = source.slice(start, end);

    assert.match(
      handler,
      /if \(href\?\.startsWith\('#'\)\) \{\s*e\.preventDefault\(\);/,
      'external source citations should navigate normally while fragment citations are intercepted',
    );
  });
});
