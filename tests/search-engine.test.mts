import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  querySearchIndex,
  searchSourceItemsEqual,
  type SearchIndexQueryOptions,
} from '../src/components/search-engine.ts';
import type { SearchScope } from '../src/components/search-scope.ts';
import type { SearchResultType, SearchableSource } from '../src/components/search-types.ts';
import type { Command } from '../src/config/commands.ts';

type QueryOverrides = Pick<SearchIndexQueryOptions, 'rawInput'>
  & Partial<Omit<SearchIndexQueryOptions, 'rawInput'>>;

function command(
  id: string,
  category: Command['category'],
  keywords: string[] = ['needle'],
  label = id,
): Command {
  return { id, category, keywords, label, icon: '' };
}

function source(
  type: SearchResultType,
  items: Array<{ id: string; title: string; subtitle?: string }>,
): SearchableSource {
  return {
    type,
    items: items.map((item) => ({ ...item, data: { sourceId: item.id } })),
  };
}

function repeatedSource(type: SearchResultType, count: number, query = 'match'): SearchableSource {
  return source(type, Array.from({ length: count }, (_, index) => ({
    id: `${type}-${index}`,
    title: `${query} ${type} ${index}`,
  })));
}

function search(overrides: QueryOverrides) {
  const defaults: SearchIndexQueryOptions = {
    rawInput: overrides.rawInput,
    scope: 'all',
    sources: [],
    commands: [],
    isMobile: false,
    flightPrefixEnabled: true,
    isPanelCommandVisible: () => true,
    isLayerCommandExecutable: () => true,
    isCommandVisible: () => true,
    isResultVisible: () => true,
    resolveCommandLabel: (candidate) => candidate.label,
    resolveCommandCategoryLabel: (candidate) => `category:${candidate.category}`,
  };
  return querySearchIndex({ ...defaults, ...overrides });
}

function commandIds(result: ReturnType<typeof search>): string[] {
  return result.commandMatches.map((match) => match.command.id);
}

function entityIds(result: ReturnType<typeof search>): string[] {
  return result.entityMatches.map((match) => match.result.id);
}

function entityTypes(result: ReturnType<typeof search>): SearchResultType[] {
  return result.entityMatches.map((match) => match.result.type);
}

describe('querySearchIndex', () => {
  it('treats subtitle-only source refreshes as the same logical index', () => {
    const previous = source('market', [{ id: 'SPX', title: 'S&P 500', subtitle: '$5,000.00' }]);
    const refreshed = source('market', [{ id: 'SPX', title: 'S&P 500', subtitle: '$5,010.00' }]);

    assert.equal(searchSourceItemsEqual(previous.items, refreshed.items), true);
    assert.equal(
      searchSourceItemsEqual(
        previous.items,
        source('market', [{ id: 'SPX', title: 'S&P 500 revised', subtitle: '$5,010.00' }]).items,
      ),
      false,
    );
  });

  it('normalizes input, ranks commands, and places commands before entities', () => {
    const result = search({
      rawInput: '  ALPHA  ',
      commands: [
        command('nav:contains', 'navigate', ['xxalphaxx'], 'Contains command'),
        command('nav:prefix', 'navigate', ['alphabet'], 'Prefix command'),
        command('nav:exact', 'navigate', ['alpha'], 'Exact command'),
      ],
      sources: [source('market', [{ id: 'alpha-index', title: 'Alpha Index' }])],
    });

    assert.equal(result.query, 'alpha');
    assert.deepEqual(commandIds(result), ['nav:exact', 'nav:prefix', 'nav:contains']);
    assert.deepEqual(result.commandMatches.map((match) => match.score), [3, 2, 1]);
    assert.equal(result.commandMatches[0]?.title, 'Exact command');
    assert.equal(result.commandMatches[0]?.subtitle, 'category:navigate');
    assert.deepEqual(result.orderedMatches.map((match) => match.kind), [
      'command',
      'command',
      'command',
      'result',
    ]);
    assert.equal(result.entityMatches[0]?.score, 2);
  });

  it('uses result-type priority first and match score within each type', () => {
    const result = search({
      rawInput: 'alpha',
      sources: [
        source('country', [
          { id: 'country-contains', title: 'Republic of Alpha' },
          { id: 'country-prefix', title: 'Alpha Republic' },
        ]),
        source('market', [{ id: 'market-prefix', title: 'Alpha Index' }]),
        source('news', [
          { id: 'news-contains', title: 'Inside Alpha' },
          { id: 'news-prefix', title: 'Alpha briefing' },
        ]),
        source('flight', [
          { id: 'flight-contains', title: 'Track Alpha One' },
          { id: 'flight-prefix', title: 'Alpha One' },
        ]),
      ],
    });

    assert.deepEqual(entityIds(result), [
      'flight-prefix',
      'flight-contains',
      'news-prefix',
      'news-contains',
      'market-prefix',
      'country-prefix',
      'country-contains',
    ]);
    assert.deepEqual(result.entityMatches.map((match) => match.score), [2, 1, 2, 1, 2, 2, 1]);
  });

  it('applies command and result scope policy consistently', () => {
    const commands = [
      command('nav:global', 'navigate', ['scope']),
      command('layer:bases', 'layers', ['scope']),
      command('panel:news', 'panels', ['scope']),
      command('view:dark', 'view', ['scope']),
      command('action:refresh', 'actions', ['scope']),
      command('country:US', 'country', ['scope']),
    ];
    const sources = [
      source('news', [{ id: 'news', title: 'Scope news' }]),
      source('country', [{ id: 'country', title: 'Scope country' }]),
      source('base', [{ id: 'base', title: 'Scope base' }]),
    ];
    const expectations: Array<{
      scope: SearchScope;
      commands: string[];
      entities: string[];
    }> = [
      { scope: 'signals', commands: ['country:US'], entities: ['news'] },
      { scope: 'map', commands: ['nav:global', 'layer:bases'], entities: ['country', 'base'] },
      { scope: 'panels', commands: ['panel:news'], entities: [] },
      { scope: 'actions', commands: ['view:dark', 'action:refresh'], entities: [] },
    ];

    for (const expectation of expectations) {
      const result = search({ rawInput: 'scope', scope: expectation.scope, commands, sources });
      assert.deepEqual(commandIds(result), expectation.commands, expectation.scope);
      assert.deepEqual(entityIds(result), expectation.entities, expectation.scope);
    }
  });

  it('enforces general, panel, layer, and entity visibility callbacks', () => {
    const inspectedPanelIds: string[] = [];
    const inspectedLayerKeys: string[] = [];
    const result = search({
      rawInput: 'filter',
      commands: [
        command('nav:shown', 'navigate', ['filter']),
        command('nav:hidden', 'navigate', ['filter']),
        command('panel:visible@desktop', 'panels', ['filter']),
        command('panel:hidden@desktop', 'panels', ['filter']),
        command('layer:visible', 'layers', ['filter']),
        command('layer:hidden', 'layers', ['filter']),
      ],
      sources: [source('market', [
        { id: 'visible-result', title: 'Filter visible' },
        { id: 'hidden-result', title: 'Filter hidden' },
      ])],
      isCommandVisible: (candidate) => candidate.id !== 'nav:hidden',
      isPanelCommandVisible: (panelId) => {
        inspectedPanelIds.push(panelId);
        return panelId !== 'hidden';
      },
      isLayerCommandExecutable: (layerKey) => {
        inspectedLayerKeys.push(layerKey);
        return layerKey !== 'hidden';
      },
      isResultVisible: (candidate) => candidate.id !== 'hidden-result',
    });

    assert.deepEqual(commandIds(result), [
      'nav:shown',
      'panel:visible@desktop',
      'layer:visible',
    ]);
    assert.deepEqual(entityIds(result), ['visible-result']);
    assert.deepEqual(inspectedPanelIds, ['visible', 'hidden']);
    assert.deepEqual(inspectedLayerKeys, ['visible', 'hidden']);
  });

  it('treats an enabled flight prefix as a callsign search and suppresses commands', () => {
    const result = search({
      rawInput: 'Flight ab123',
      commands: [command('panel:flights', 'panels', ['flight ab123'])],
      sources: [source('flight', [
        { id: 'contains', title: 'ZZ-AB123' },
        { id: 'prefix', title: 'AB123' },
        { id: 'hidden', title: 'AB123 SECRET' },
        { id: 'other', title: 'CD456' },
      ])],
      isResultVisible: (candidate) => candidate.id !== 'hidden',
    });

    assert.equal(result.flightCallsign, 'AB123');
    assert.deepEqual(commandIds(result), []);
    assert.deepEqual(entityIds(result), ['prefix', 'contains']);
    assert.deepEqual(result.entityMatches.map((match) => match.score), [2, 1]);
  });

  it('falls back to ordinary command matching when flight-prefix search is disabled or out of scope', () => {
    const flightCommand = command('panel:flights', 'panels', ['flight ab123']);

    const disabled = search({
      rawInput: 'flight ab123',
      commands: [flightCommand],
      flightPrefixEnabled: false,
    });
    assert.equal(disabled.flightCallsign, null);
    assert.deepEqual(commandIds(disabled), ['panel:flights']);

    const panelsScope = search({
      rawInput: 'flight ab123',
      scope: 'panels',
      commands: [flightCommand],
      flightPrefixEnabled: true,
    });
    assert.equal(panelsScope.flightCallsign, null);
    assert.deepEqual(commandIds(panelsScope), ['panel:flights']);
  });

  it('caps commands and desktop results per type', () => {
    const result = search({
      rawInput: 'match',
      commands: Array.from({ length: 7 }, (_, index) => (
        command(`nav:${index}`, 'navigate', ['match'])
      )),
      sources: [
        repeatedSource('news', 8),
        repeatedSource('country', 6),
        repeatedSource('market', 5),
      ],
    });

    assert.deepEqual(commandIds(result), [
      'nav:0',
      'nav:1',
      'nav:2',
      'nav:3',
      'nav:4',
    ]);
    assert.equal(result.entityMatches.filter((match) => match.result.type === 'news').length, 6);
    assert.equal(result.entityMatches.filter((match) => match.result.type === 'country').length, 4);
    assert.equal(result.entityMatches.filter((match) => match.result.type === 'market').length, 3);
    assert.equal(result.entityMatches.length, 13);
  });

  it('applies the mobile per-type and total entity caps', () => {
    const result = search({
      rawInput: 'match',
      isMobile: true,
      sources: [
        repeatedSource('market', 3),
        repeatedSource('prediction', 3),
        repeatedSource('news', 3),
      ],
    });

    assert.equal(result.entityMatches.length, 5);
    assert.deepEqual(entityTypes(result), ['news', 'news', 'prediction', 'prediction', 'market']);
  });

  it('caps desktop entities globally after applying type priority', () => {
    const result = search({
      rawInput: 'match',
      sources: [
        repeatedSource('country', 3),
        repeatedSource('hotspot', 3),
        repeatedSource('conflict', 3),
        repeatedSource('outage', 3),
        repeatedSource('earthquake', 3),
        repeatedSource('market', 3),
        repeatedSource('prediction', 3),
        repeatedSource('news', 3),
        repeatedSource('flight', 3),
      ],
    });

    assert.equal(result.entityMatches.length, 24);
    assert.deepEqual(entityTypes(result).slice(0, 6), [
      'flight',
      'flight',
      'flight',
      'news',
      'news',
      'news',
    ]);
    assert.equal(entityTypes(result).includes('country'), false);
  });
});
