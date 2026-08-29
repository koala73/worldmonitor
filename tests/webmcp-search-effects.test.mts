import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SearchMatch } from '../src/components/search-types.ts';
import {
  SEARCH_RESULT_EFFECT_CLASSES,
  classifySearchMatchEffect,
  isSearchResultEffectHostExecutable,
  searchResultEffectRequiresCancellation,
} from '../src/app/webmcp-search-effects.ts';

function command(id: string): SearchMatch {
  return {
    kind: 'command',
    score: 1,
    title: id,
    subtitle: 'command',
    command: {
      id,
      keywords: [],
      label: id,
      icon: '',
      category: 'actions',
    },
  };
}

function entity(type: SearchMatch extends { kind: 'result'; result: infer R } ? R['type'] : never): SearchMatch {
  return {
    kind: 'result',
    score: 1,
    result: {
      type,
      id: type,
      title: type,
      data: {},
    },
  };
}

describe('WebMCP search-result effect classes', () => {
  it('names every required effect class', () => {
    assert.deepEqual([...SEARCH_RESULT_EFFECT_CLASSES], [
      'read-only',
      'view-state',
      'persistent',
      'quota-consuming',
      'external-navigation',
    ]);
  });

  it('requires cancellation only for effects that can outlive the caller', () => {
    assert.equal(searchResultEffectRequiresCancellation('read-only'), false);
    assert.equal(searchResultEffectRequiresCancellation('view-state'), false);
    assert.equal(searchResultEffectRequiresCancellation('persistent'), true);
    assert.equal(searchResultEffectRequiresCancellation('quota-consuming'), true);
    assert.equal(searchResultEffectRequiresCancellation('external-navigation'), true);
  });

  it('treats read-only and view-state as host-executable without a target signal', () => {
    assert.equal(isSearchResultEffectHostExecutable('read-only', false), true);
    assert.equal(isSearchResultEffectHostExecutable('view-state', false), true);
    assert.equal(isSearchResultEffectHostExecutable('persistent', false), false);
    assert.equal(isSearchResultEffectHostExecutable('quota-consuming', false), false);
    assert.equal(isSearchResultEffectHostExecutable('external-navigation', false), false);
    assert.equal(isSearchResultEffectHostExecutable('persistent', true), true);
    assert.equal(isSearchResultEffectHostExecutable('quota-consuming', true), true);
    assert.equal(isSearchResultEffectHostExecutable('external-navigation', true), true);
  });

  it('classifies commands and entities onto the five effect classes', () => {
    const enabled = new Set(['live-webcams', 'markets']);
    const isPanelEnabled = (panelId: string): boolean => enabled.has(panelId);

    assert.equal(classifySearchMatchEffect(command('nav:eu'), isPanelEnabled), 'view-state');
    assert.equal(classifySearchMatchEffect(command('time:7d'), isPanelEnabled), 'view-state');
    assert.equal(classifySearchMatchEffect(command('country-map:DE'), isPanelEnabled), 'view-state');
    assert.equal(
      classifySearchMatchEffect(command('panel:live-webcams'), isPanelEnabled),
      'view-state',
    );
    assert.equal(
      classifySearchMatchEffect(command('panel:markets'), isPanelEnabled),
      'view-state',
    );
    assert.equal(
      classifySearchMatchEffect(command('panel:markets@overview'), isPanelEnabled),
      'persistent',
    );
    assert.equal(
      classifySearchMatchEffect(command('panel:consumer-prices@world'), () => true),
      'persistent',
    );
    assert.equal(classifySearchMatchEffect(entity('news'), isPanelEnabled), 'view-state');
    assert.equal(classifySearchMatchEffect(entity('market'), isPanelEnabled), 'view-state');
    assert.equal(classifySearchMatchEffect(entity('hotspot'), isPanelEnabled), 'view-state');
    assert.equal(classifySearchMatchEffect(entity('ailab'), isPanelEnabled), 'view-state');

    assert.equal(
      classifySearchMatchEffect(command('panel:windy-webcams'), isPanelEnabled),
      'persistent',
    );
    assert.equal(classifySearchMatchEffect(command('layer:conflicts'), isPanelEnabled), 'persistent');
    assert.equal(classifySearchMatchEffect(command('layers:military'), isPanelEnabled), 'persistent');
    assert.equal(classifySearchMatchEffect(command('view:dark'), isPanelEnabled), 'persistent');
    assert.equal(classifySearchMatchEffect(command('view:resilience'), isPanelEnabled), 'persistent');
    assert.equal(classifySearchMatchEffect(entity('pipeline'), isPanelEnabled), 'persistent');
    assert.equal(classifySearchMatchEffect(entity('flight'), isPanelEnabled), 'persistent');

    assert.equal(classifySearchMatchEffect(command('country:US'), isPanelEnabled), 'quota-consuming');
    assert.equal(classifySearchMatchEffect(entity('country'), isPanelEnabled), 'quota-consuming');

    assert.equal(classifySearchMatchEffect(command('view:refresh'), isPanelEnabled), 'external-navigation');
    assert.equal(classifySearchMatchEffect(command('view:settings'), isPanelEnabled), 'external-navigation');
    assert.equal(
      classifySearchMatchEffect(command('view:route-explorer'), isPanelEnabled),
      'external-navigation',
    );
    assert.equal(
      classifySearchMatchEffect(command('view:fullscreen'), isPanelEnabled),
      'external-navigation',
    );
  });

  it('fails closed for unknown commands instead of treating them as view-state', () => {
    assert.equal(classifySearchMatchEffect(command('unknown:thing'), () => true), 'persistent');
  });
});
