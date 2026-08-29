import type { SearchMatch } from '@/components/search-types';

/**
 * Effect class of one issued search result. Bound to the opaque token at
 * issuance so a caller cannot supply a weaker class later.
 *
 *   - read-only: no dashboard mutation. Reserved; current openers always
 *     change something visible or persistent.
 *   - view-state: reversible visible dashboard change (open an enabled panel
 *     with no tab deep-link, move the map, scroll a live feed).
 *   - persistent: writes storage or starts a session-outliving stream (layer
 *     toggles, enabling a disabled panel, theme).
 *   - quota-consuming: can spend the caller's daily LLM allowance.
 *   - external-navigation: leaves the current dashboard document.
 */
export const SEARCH_RESULT_EFFECT_CLASSES = [
  'read-only',
  'view-state',
  'persistent',
  'quota-consuming',
  'external-navigation',
] as const;

export type SearchResultEffectClass = (typeof SEARCH_RESULT_EFFECT_CLASSES)[number];

const PERSISTENT_ENTITY_TYPES = new Set([
  'pipeline',
  'cable',
  'datacenter',
  'nuclear',
  'irradiator',
  'techcompany',
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

const VIEW_STATE_ENTITY_TYPES = new Set([
  'news',
  'hotspot',
  'market',
  'prediction',
  'conflict',
  'base',
  'earthquake',
  'outage',
  'ailab',
]);

const EXTERNAL_NAVIGATION_VIEW_ACTIONS = new Set([
  'settings',
  'refresh',
  'route-explorer',
  'fullscreen',
]);

export function searchResultEffectRequiresCancellation(
  effect: SearchResultEffectClass,
): boolean {
  return effect === 'persistent'
    || effect === 'quota-consuming'
    || effect === 'external-navigation';
}

export function isSearchResultEffectHostExecutable(
  effect: SearchResultEffectClass,
  targetCancellationSupported: boolean,
): boolean {
  return targetCancellationSupported || !searchResultEffectRequiresCancellation(effect);
}

export function classifySearchMatchEffect(
  match: SearchMatch,
  isPanelEnabled: (panelId: string) => boolean,
): SearchResultEffectClass {
  if (match.kind === 'result') {
    if (match.result.type === 'country') return 'quota-consuming';
    if (VIEW_STATE_ENTITY_TYPES.has(match.result.type)) return 'view-state';
    if (PERSISTENT_ENTITY_TYPES.has(match.result.type)) return 'persistent';
    return 'persistent';
  }

  const [category = '', action = ''] = match.command.id.split(':', 2);
  switch (category) {
    case 'nav':
    case 'time':
    case 'country-map':
      return 'view-state';
    case 'country':
      return 'quota-consuming';
    case 'layer':
    case 'layers':
      return 'persistent';
    case 'panel': {
      const [panelId = '', subAction = ''] = action.split('@');
      // Tab deep-links such as panel:consumer-prices@world write panel
      // settings to localStorage after presentation. Fail closed for any
      // @sub-action rather than treating an enabled panel as view-state.
      if (subAction) return 'persistent';
      return panelId && isPanelEnabled(panelId) ? 'view-state' : 'persistent';
    }
    case 'view':
      if (action === 'resilience') return 'persistent';
      if (action === 'dark' || action === 'light') return 'persistent';
      if (EXTERNAL_NAVIGATION_VIEW_ACTIONS.has(action)) return 'external-navigation';
      return 'persistent';
    default:
      return 'persistent';
  }
}
