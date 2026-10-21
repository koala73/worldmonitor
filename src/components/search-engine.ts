import type { Command } from '@/config/commands';
import {
  commandMatchesSearchScope,
  panelCommandTargetId,
  resultMatchesSearchScope,
  type SearchScope,
} from '@/components/search-scope';
import {
  searchMatchIdentity,
  type SearchCommandMatch,
  type SearchEntityMatch,
  type SearchMatch,
  type SearchResult,
  type SearchResultType,
  type SearchableSource,
} from '@/components/search-types';

const MAX_COMMANDS = 5;
const DESKTOP_MAX_RESULTS = 24;
const MOBILE_MAX_RESULTS = 5;

const RESULT_TYPE_PRIORITY: readonly SearchResultType[] = [
  'flight',
  'news', 'prediction', 'market', 'earthquake', 'outage',
  'conflict', 'hotspot', 'country',
  'base', 'pipeline', 'cable', 'datacenter', 'nuclear', 'irradiator',
  'techcompany', 'ailab', 'startup', 'techevent', 'techhq', 'accelerator',
  'exchange', 'financialcenter', 'centralbank', 'commodityhub',
];

export interface SearchIndexQueryOptions {
  rawInput: string;
  scope: SearchScope;
  sources: readonly SearchableSource[];
  commands: readonly Command[];
  isMobile: boolean;
  flightPrefixEnabled: boolean;
  isPanelCommandVisible(panelId: string): boolean;
  isLayerCommandExecutable(layerKey: string): boolean;
  isCommandVisible(command: Command): boolean;
  isResultVisible(result: SearchResult): boolean;
  resolveCommandLabel(command: Command): string;
  resolveCommandCategoryLabel(command: Command): string;
}

export interface SearchIndexQueryResult {
  query: string;
  commandMatches: SearchCommandMatch[];
  entityMatches: SearchEntityMatch[];
  orderedMatches: SearchMatch[];
  flightCallsign: string | null;
}

/**
 * Compare the fields that define a searchable target, not its live display
 * metadata. Source registration always replaces the payload, so subtitle-only
 * changes must not invalidate an issued capability.
 */
export function searchSourceItemsEqual(
  left: SearchableSource['items'],
  right: SearchableSource['items'],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const next = right[index];
    return next !== undefined
      && item.id === next.id
      && item.title === next.title
      && item.searchText === next.searchText;
  });
}

function matchCommands(
  query: string,
  options: SearchIndexQueryOptions,
): SearchCommandMatch[] {
  if (query.length < 2) return [];
  const matched: SearchCommandMatch[] = [];

  for (const command of options.commands) {
    if (!commandMatchesSearchScope(options.scope, command.category)) continue;
    if (!options.isCommandVisible(command)) continue;
    const panelId = panelCommandTargetId(command.id);
    if (panelId && !options.isPanelCommandVisible(panelId)) continue;
    if (
      command.id.startsWith('layer:')
      && !options.isLayerCommandExecutable(command.id.slice(6))
    ) continue;

    const title = options.resolveCommandLabel(command);
    const terms = [...command.keywords, title].map((term) => term.toLowerCase());
    let bestScore = 0;
    for (const term of terms) {
      if (term.includes(query) || (term.length >= 3 && query.includes(term))) {
        const score = term === query ? 3 : term.startsWith(query) ? 2 : 1;
        if (score > bestScore) bestScore = score;
      }
    }
    if (bestScore > 0) {
      matched.push({
        kind: 'command',
        command,
        score: bestScore,
        title,
        subtitle: options.resolveCommandCategoryLabel(command),
      });
    }
  }

  return matched.sort((left, right) => right.score - left.score).slice(0, MAX_COMMANDS);
}

function resultPerTypeLimit(type: SearchResultType, isMobile: boolean): number {
  if (isMobile) return 2;
  if (type === 'news') return 6;
  if (type === 'country') return 4;
  return 3;
}

/**
 * Pure matching/ranking implementation shared by the command-deck UI and
 * programmatic dashboard search. It never writes DOM, recent-search, modal,
 * analytics, or dashboard state.
 */
export function querySearchIndex(options: SearchIndexQueryOptions): SearchIndexQueryResult {
  const query = options.rawInput.toLowerCase().trim();
  if (!query) {
    return {
      query,
      commandMatches: [],
      entityMatches: [],
      orderedMatches: [],
      flightCallsign: null,
    };
  }

  const byType = new Map<SearchResultType, (SearchResult & { _score: number })[]>();
  let flightCallsign: string | null = null;
  const flightPrefixAllowed = (
    query.startsWith('flight ')
    && options.flightPrefixEnabled
    && resultMatchesSearchScope(options.scope, 'flight')
  );
  const commandMatches = flightPrefixAllowed ? [] : matchCommands(query, options);

  if (flightPrefixAllowed) {
    const callsign = query.slice(7).trim().toUpperCase();
    if (callsign) {
      flightCallsign = callsign;
      const flightSource = options.sources.find((source) => source.type === 'flight');
      if (flightSource?.items.length) {
        byType.set('flight', flightSource.items
          .filter((item) => item.title.toUpperCase().includes(callsign))
          .map((item) => ({
            type: 'flight' as const,
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            data: item.data,
            _score: item.title.toUpperCase().startsWith(callsign) ? 2 : 1,
          }))
          .filter((result) => options.isResultVisible({
            type: result.type,
            id: result.id,
            title: result.title,
            subtitle: result.subtitle,
            data: result.data,
          })));
      }
    }
  }

  for (const source of options.sources) {
    if (!resultMatchesSearchScope(options.scope, source.type)) continue;
    for (const item of source.items) {
      const titleLower = item.title.toLowerCase();
      const subtitleLower = item.subtitle?.toLowerCase() ?? '';
      const searchTextLower = item.searchText?.toLowerCase() ?? '';
      if (
        !titleLower.includes(query)
        && !subtitleLower.includes(query)
        && !searchTextLower.includes(query)
      ) continue;

      const matches = byType.get(source.type) ?? [];
      const result = {
        type: source.type,
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        data: item.data,
        _score: (
          titleLower.startsWith(query)
          || subtitleLower.startsWith(query)
          || searchTextLower.startsWith(query)
        ) ? 2 : 1,
      };
      if (!options.isResultVisible({
        type: result.type,
        id: result.id,
        title: result.title,
        subtitle: result.subtitle,
        data: result.data,
      })) continue;
      matches.push(result);
      byType.set(source.type, matches);
    }
  }

  const maxEntityResults = options.isMobile ? MOBILE_MAX_RESULTS : DESKTOP_MAX_RESULTS;
  const entityMatches: SearchEntityMatch[] = [];
  const seenIdentities = new Set<string>();
  for (const type of RESULT_TYPE_PRIORITY) {
    const matches = byType.get(type) ?? [];
    matches.sort((left, right) => right._score - left._score);
    let acceptedForType = 0;
    for (const match of matches) {
      const candidate: SearchEntityMatch = {
        kind: 'result',
        score: match._score,
        result: {
          type: match.type,
          id: match.id,
          title: match.title,
          subtitle: match.subtitle,
          data: match.data,
        },
      };
      const identity = searchMatchIdentity(candidate);
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
      entityMatches.push(candidate);
      acceptedForType += 1;
      if (acceptedForType >= resultPerTypeLimit(type, options.isMobile)) break;
    }
    if (entityMatches.length >= maxEntityResults) break;
  }
  entityMatches.splice(maxEntityResults);

  return {
    query,
    commandMatches,
    entityMatches,
    orderedMatches: [...commandMatches, ...entityMatches],
    flightCallsign,
  };
}
