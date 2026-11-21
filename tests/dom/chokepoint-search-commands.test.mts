import { describe, expect, it } from 'vitest';

import { COMMANDS } from '@/config/commands';
import { querySearchIndex } from '@/components/search-engine';

function panelCommandsFor(rawInput: string): string[] {
  return querySearchIndex({
    rawInput,
    scope: 'all',
    sources: [],
    commands: COMMANDS,
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

// The daily transit history per chokepoint lives in the Supply Chain panel's
// Chokepoints tab. Searching a strait's name must reach it, not only the
// status strip and the WTO tracker.
describe('chokepoint search reaches the transit history', () => {
  for (const query of ['hormuz', 'suez', 'chokepoints', 'transits']) {
    it(`lists the Supply Chain panel for "${query}"`, () => {
      expect(panelCommandsFor(query)).toContain('panel:supply-chain');
    });
  }

  it('still lists the strip and the WTO tracker for "hormuz"', () => {
    const ids = panelCommandsFor('hormuz');
    expect(ids).toContain('panel:chokepoint-strip');
    expect(ids).toContain('panel:hormuz-tracker');
  });
});
