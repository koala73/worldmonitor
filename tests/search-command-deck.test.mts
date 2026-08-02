import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_SCOPES,
  commandMatchesSearchScope,
  panelCommandTargetId,
  resolveIdleSelectionTerm,
  resultMatchesSearchScope,
} from '../src/components/search-scope.ts';

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
    assert.equal(resultMatchesSearchScope('signals', 'flight'), true);
    assert.equal(resultMatchesSearchScope('signals', 'country'), false);
    assert.equal(resultMatchesSearchScope('map', 'country'), true);
    assert.equal(resultMatchesSearchScope('map', 'pipeline'), true);
    assert.equal(resultMatchesSearchScope('map', 'exchange'), true);
    assert.equal(resultMatchesSearchScope('map', 'financialcenter'), true);
    assert.equal(resultMatchesSearchScope('map', 'centralbank'), true);
    assert.equal(resultMatchesSearchScope('map', 'commodityhub'), true);
    assert.equal(resultMatchesSearchScope('map', 'market'), false);
    assert.equal(resultMatchesSearchScope('panels', 'news'), false);
    assert.equal(resultMatchesSearchScope('panels', 'flight'), false);
    assert.equal(resultMatchesSearchScope('actions', 'hotspot'), false);
    assert.equal(resultMatchesSearchScope('actions', 'flight'), false);
  });
});

describe('intelligence command deck pure helpers', () => {
  it('strips optional @variant from panel command ids for discovery', () => {
    assert.equal(panelCommandTargetId('panel:news'), 'news');
    assert.equal(panelCommandTargetId('panel:news@desktop'), 'news');
    assert.equal(panelCommandTargetId('panel:country-deep-dive@mobile'), 'country-deep-dive');
    assert.equal(panelCommandTargetId('panel:'), null);
    assert.equal(panelCommandTargetId('layer:ais'), null);
    assert.equal(panelCommandTargetId('navigate:home'), null);
  });

  it('maps keyboard idle selection to recent searches or launch tips', () => {
    const recents = ['ukraine', 'hormuz'];
    const tips = ['brief ukraine', 'open map'];

    assert.equal(
      resolveIdleSelectionTerm('all', recents, tips, 1, true),
      'hormuz',
    );
    assert.equal(
      resolveIdleSelectionTerm('signals', recents, tips, 0, true),
      'brief ukraine',
    );
    assert.equal(
      resolveIdleSelectionTerm('all', [], tips, 1, true),
      'open map',
    );
    // Non-empty no-results query must not rehydrate idle history.
    assert.equal(
      resolveIdleSelectionTerm('all', recents, tips, 0, false),
      undefined,
    );
  });

  it('treats flight entities as out of panels/actions channels', () => {
    // Flight-prefix special case in SearchModal must consult this predicate.
    assert.equal(resultMatchesSearchScope('all', 'flight'), true);
    assert.equal(resultMatchesSearchScope('signals', 'flight'), true);
    assert.equal(resultMatchesSearchScope('map', 'flight'), true);
    assert.equal(resultMatchesSearchScope('panels', 'flight'), false);
    assert.equal(resultMatchesSearchScope('actions', 'flight'), false);
  });
});
