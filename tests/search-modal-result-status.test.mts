import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// #7023 (SearchModal slice): the combobox already reports selection through
// aria-activedescendant, but the outcome of a keystroke — how many results,
// or none — was never announced. These source-structural assertions pin the
// polite status region and its updates; behavioral combobox coverage lives
// in search-result-options / search-command-deck.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(REPO_ROOT, 'src/components/SearchModal.ts'), 'utf8');

describe('search modal result-count announcements (#7023)', () => {
  before(() => {
    assert.ok(source.length > 0, 'SearchModal source must be readable');
  });

  it('ships a visually-hidden status region in both modal variants', () => {
    const markupCount = source.match(/class="search-results-status wm-visually-hidden"/g)?.length ?? 0;
    assert.equal(markupCount, 2, 'both the mobile sheet and the desktop deck need the status region');
  });

  it('the status region is a polite live region', () => {
    assert.match(source, /resultsStatus\.setAttribute\('role', 'status'\)/);
    assert.match(source, /resultsStatus\.setAttribute\('aria-live', 'polite'\)/);
  });

  it('announces the result count on a populated render', () => {
    assert.match(
      source,
      /this\.announceResultCount\(this\.totalResultCount\)/,
      'the populated render path must announce how many results the query produced',
    );
  });

  it('announces zero results on the empty render', () => {
    assert.match(
      source,
      /this\.announceResultCount\(0\)/,
      'the no-results render must announce that the query produced nothing',
    );
  });

  it('announces the live-flight action before its early return', () => {
    assert.match(
      source,
      /this\.renderFlightSearchTrigger\(this\.currentFlightCallsign\);\s*this\.announceResultCount\(1\);/,
    );
  });

  it('localizes the complete populated-result announcement', () => {
    assert.match(
      source,
      /t\('modals\.search\.resultAnnouncement', \{ count, query \}\)/,
    );
  });
});
