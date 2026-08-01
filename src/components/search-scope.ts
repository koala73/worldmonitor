export const SEARCH_SCOPES = ['all', 'signals', 'map', 'panels', 'actions'] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

export type SearchCommandCategory = 'navigate' | 'layers' | 'panels' | 'view' | 'actions' | 'country';

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
