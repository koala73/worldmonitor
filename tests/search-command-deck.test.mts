import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEARCH_SCOPES,
  commandMatchesSearchScope,
  resultMatchesSearchScope,
} from '../src/components/search-scope.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modalSource = readFileSync(resolve(root, 'src/components/SearchModal.ts'), 'utf8');

describe('intelligence command deck scopes', () => {
  it('exposes the complete operator channel set in a stable order', () => {
    assert.deepEqual(SEARCH_SCOPES, ['all', 'signals', 'map', 'panels', 'actions']);
  });

  it('routes commands into exclusive operational channels', () => {
    assert.equal(commandMatchesSearchScope('all', 'panels'), true);
    assert.equal(commandMatchesSearchScope('signals', 'country'), true);
    assert.equal(commandMatchesSearchScope('signals', 'layers'), false);
    assert.equal(commandMatchesSearchScope('map', 'navigate'), true);
    assert.equal(commandMatchesSearchScope('map', 'layers'), true);
    assert.equal(commandMatchesSearchScope('map', 'panels'), false);
    assert.equal(commandMatchesSearchScope('panels', 'panels'), true);
    assert.equal(commandMatchesSearchScope('panels', 'view'), false);
    assert.equal(commandMatchesSearchScope('actions', 'view'), true);
    assert.equal(commandMatchesSearchScope('actions', 'actions'), true);
    assert.equal(commandMatchesSearchScope('actions', 'country'), false);
  });

  it('keeps entity results out of command-only channels', () => {
    assert.equal(resultMatchesSearchScope('all', 'news'), true);
    assert.equal(resultMatchesSearchScope('signals', 'news'), true);
    assert.equal(resultMatchesSearchScope('signals', 'market'), true);
    assert.equal(resultMatchesSearchScope('signals', 'country'), false);
    assert.equal(resultMatchesSearchScope('map', 'country'), true);
    assert.equal(resultMatchesSearchScope('map', 'pipeline'), true);
    assert.equal(resultMatchesSearchScope('map', 'market'), false);
    assert.equal(resultMatchesSearchScope('panels', 'news'), false);
    assert.equal(resultMatchesSearchScope('actions', 'hotspot'), false);
  });
});

describe('intelligence command deck interaction wiring', () => {
  it('renders semantic scope controls and applies the selected scope to both command and entity matching', () => {
    assert.match(modalSource, /role="toolbar" aria-label="Filter intelligence search"/);
    assert.match(modalSource, /aria-pressed="\$\{scope === this\.activeScope\}"/);
    assert.match(modalSource, /commandMatchesSearchScope\(this\.activeScope, cmd\.category\)/);
    assert.match(modalSource, /resultMatchesSearchScope\(this\.activeScope, source\.type\)/);
  });

  it('makes tactical launch cards executable from the keyboard', () => {
    assert.match(modalSource, /private quickLaunchExamples: string\[\]/);
    assert.match(modalSource, /const idleItemCount = this\.activeScope === 'all'/);
    assert.match(modalSource, /: this\.quickLaunchExamples\[index\]/);
  });

  it('remembers command queries as well as entity queries', () => {
    assert.match(
      modalSource,
      /if \(cmd\) \{\s*this\.saveRecentSearch\(this\.input\?\.value\.trim\(\) \|\| ''\);\s*this\.close\(\);/,
    );
  });
});
