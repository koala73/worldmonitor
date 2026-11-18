/**
 * Command ranking against the real command catalogue. Dogfood found two
 * tie-breaks that ran the wrong command from the search modal's own examples:
 * "brief china" opened Andorra, and "iran" toggled the Middle East strikes layer
 * instead of moving the map. Ties fall back to catalogue order, so every query
 * a user is told to type must win on score.
 */
import { describe, expect, it } from 'vitest';
import { querySearchIndex } from '@/components/search-engine';
import { getAllCommands } from '@/config/commands';
import { CURATED_COUNTRIES } from '@/config/countries';

function topCommands(rawInput: string): string[] {
  return querySearchIndex({
    rawInput,
    scope: 'all',
    sources: [],
    commands: getAllCommands(),
    isMobile: false,
    flightPrefixEnabled: true,
    isPanelCommandVisible: () => true,
    isLayerCommandExecutable: () => true,
    isCommandVisible: () => true,
    isResultVisible: () => true,
    resolveCommandLabel: (command) => command.label,
    resolveCommandCategoryLabel: (command) => command.category,
  }).commandMatches.map((match) => match.command.id);
}

describe('search command ranking', () => {
  it('opens the named country for "brief <country>"', () => {
    expect(topCommands('brief china')[0]).toBe('country:CN');
    expect(topCommands('brief ukraine')[0]).toBe('country:UA');
  });

  it('still ranks a keyword equal to the whole query first', () => {
    expect(topCommands('middle east strikes')[0]).toBe('layer:iran');
    expect(topCommands('world news')[0]).toBe('panel:politics');
  });

  it('keeps the strikes layer and the US panel findable, below the map command', () => {
    const iran = topCommands('iran');
    expect(iran[0]).toBe('country-map:IR');
    expect(iran).toContain('layer:iran');
    expect(topCommands('united states')).toContain('panel:us');
  });

  it('ranks the map command first when the query is a country name', () => {
    const misses = Object.entries(CURATED_COUNTRIES)
      .map(([code, country]) => ({ code, query: country.name, top: topCommands(country.name)[0] }))
      .filter(({ code, top }) => top !== `country-map:${code}`);
    expect(misses).toEqual([]);
  });
});
