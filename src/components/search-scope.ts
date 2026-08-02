export const SEARCH_SCOPES = ['all', 'signals', 'map', 'panels', 'actions'] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

export type SearchCommandCategory = 'navigate' | 'layers' | 'panels' | 'view' | 'actions' | 'country';

/** Strip optional `@variant` suffix so `panel:news@desktop` resolves to `news`. */
export function panelCommandTargetId(commandId: string): string | null {
  if (!commandId.startsWith('panel:')) return null;
  return commandId.slice(6).split('@')[0] || null;
}

/**
 * Idle-list term for keyboard Enter when there are no live results.
 * Prefer recent searches under All Intel; otherwise tactical launch examples.
 * Returns undefined when the input still holds a query (no-results must not
 * rehydrate idle history).
 */
export function resolveIdleSelectionTerm(
  activeScope: SearchScope,
  recentSearches: readonly string[],
  quickLaunchExamples: readonly string[],
  index: number,
  inputEmpty: boolean,
): string | undefined {
  if (!inputEmpty) return undefined;
  if (activeScope === 'all' && recentSearches.length > 0) {
    return recentSearches[index];
  }
  return quickLaunchExamples[index];
}

const SIGNAL_RESULT_TYPES = new Set([
  'news',
  'hotspot',
  'market',
  'prediction',
  'conflict',
  'earthquake',
  'outage',
  'nuclear',
  'flight',
]);

const MAP_RESULT_TYPES = new Set([
  'country',
  'hotspot',
  'conflict',
  'base',
  'pipeline',
  'cable',
  'datacenter',
  'earthquake',
  'outage',
  'nuclear',
  'irradiator',
  'techcompany',
  'ailab',
  'startup',
  'techevent',
  'techhq',
  'accelerator',
  'exchange',
  'financialcenter',
  'centralbank',
  'commodityhub',
  'flight',
]);

export function commandMatchesSearchScope(scope: SearchScope, category: SearchCommandCategory): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'signals':
      return category === 'country';
    case 'map':
      return category === 'navigate' || category === 'layers';
    case 'panels':
      return category === 'panels';
    case 'actions':
      return category === 'view' || category === 'actions';
  }
}

export function resultMatchesSearchScope(scope: SearchScope, type: string): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'signals':
      return SIGNAL_RESULT_TYPES.has(type);
    case 'map':
      return MAP_RESULT_TYPES.has(type);
    case 'panels':
    case 'actions':
      return false;
  }
}
