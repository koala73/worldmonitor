/**
 * Command ranking against the real command catalogue. Dogfood found two
 * tie-breaks that ran the wrong command from the search modal's own examples:
 * "brief china" opened Andorra, and "iran" toggled the Middle East strikes layer
 * instead of moving the map. Ties fall back to catalogue order, so every query
 * a user is told to type must win on score.
 */
import { describe, expect, it, vi } from 'vitest';
import { querySearchIndex } from '@/components/search-engine';
import { getAllCommands, type Command } from '@/config/commands';
import { CURATED_COUNTRIES } from '@/config/countries';
import * as i18n from '@/services/i18n';

function topCommands(rawInput: string, translatedLabel?: (command: Command) => string, commands = getAllCommands()): string[] {
  return querySearchIndex({
    rawInput,
    scope: 'all',
    sources: [],
    commands,
    isMobile: false,
    flightPrefixEnabled: true,
    isPanelCommandVisible: () => true,
    isLayerCommandExecutable: () => true,
    isCommandVisible: () => true,
    isResultVisible: () => true,
    resolveCommandLabel: (command) => (translatedLabel && command.id.startsWith('panel:') ? translatedLabel(command) : command.label),
    resolveCommandCategoryLabel: (command) => command.category,
  }).commandMatches.map((match) => match.command.id);
}

describe('search command ranking', () => {
  it('opens the named country for "brief <country>"', () => {
    expect(topCommands('brief china')[0]).toBe('country:CN');
    expect(topCommands('brief ukraine')[0]).toBe('country:UA');
    // A name that contains a shorter country's name: every word must count.
    expect(topCommands('brief south sudan')[0]).toBe('country:SS');
    expect(topCommands('brief equatorial guinea')[0]).toBe('country:GQ');
    expect(topCommands('brief guinea')[0]).toBe('country:GN');
  });

  it('ranks more matched words above stronger matches on fewer words', () => {
    const commands: Command[] = [
      { id: 'panel:fewer', keywords: ['brief'], label: 'Fewer', icon: '', category: 'panels' },
      { id: 'panel:more', keywords: ['briefing', 'china'], label: 'More', icon: '', category: 'panels' },
    ];
    expect(topCommands(`${'brief '.repeat(104)}china`, undefined, commands)[0]).toBe('panel:more');
  });

  it('ranks a whole-query prefix above a partial word match', () => {
    expect(topCommands('oil ne')[0]).toBe('panel:energy');
  });

  it('still ranks a keyword equal to the whole query first', () => {
    expect(topCommands('middle east strikes')[0]).toBe('layer:iran');
    expect(topCommands('world news')[0]).toBe('panel:politics');
  });

  it('keeps the strikes layer and the US panel findable, below the map command', () => {
    const iran = topCommands('iran');
    expect(iran[0]).toBe('country-map:IR');
    expect(iran).toContain('layer:iran');
    expect(topCommands('show iran')[0]).toBe('layer:iran');
    expect(topCommands('united states')).toContain('panel:us');
    expect(topCommands('united states news')[0]).toBe('panel:us');
    // Translated views label the panel in their language ("Panel: États-Unis"),
    // so the English query must still reach it through a keyword.
    expect(topCommands('united states', () => 'Panel: États-Unis')).toContain('panel:us');
    // Australia has no curated entry, so a translated view has no English
    // keyword on its country commands; Oceania must still answer "australia".
    const translatedAustralia = getAllCommands().filter((command) => !command.id.endsWith(':AU'));
    expect(topCommands('australia', undefined, translatedAustralia)).toContain('nav:oceania');
  });

  it.each(['en', 'zh'])('ranks the United Kingdom and Ukraine above aliases for other countries in %s', (language) => {
    const mock = vi.spyOn(i18n, 'getCurrentLanguageTag').mockReturnValue(language);
    try {
      const catalogue = getAllCommands();
      const ukraine = catalogue.find(command => command.id === 'country-map:UA');
      expect(ukraine?.label).toBe(language === 'zh' ? '乌克兰' : 'Ukraine');
      const commands = topCommands('uk', undefined, catalogue);
      expect(commands.slice(0, 4)).toEqual(['country-map:GB', 'country:GB', 'country-map:UA', 'country:UA']);
      expect(commands).not.toContain('country-map:RU');
      expect(commands).not.toContain('country:RU');
    } finally {
      mock.mockRestore();
    }
  });

  it('ranks the map command first when the query is a country name', () => {
    const countryNames = [
      ...Object.entries(CURATED_COUNTRIES).map(([code, country]) => ({ code, query: country.name })),
      ...getAllCommands()
        .filter((command) => command.id.startsWith('country-map:'))
        .map((command) => ({ code: command.id.slice('country-map:'.length), query: command.label })),
    ];
    const misses = countryNames
      .map(({ code, query }) => ({ code, query, top: topCommands(query)[0] }))
      .filter(({ code, top }) => top !== `country-map:${code}`);
    expect(misses).toEqual([]);
  });
});
