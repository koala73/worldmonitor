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
  // Ahead of news: a user who types a headline from an alert is looking for
  // that alert, and on a phone only the first types fit.
  'alert',
  'news',
  // Directly after loaded news: mobile shows five results, filled in this order.
  'headline',
  'prediction', 'market', 'earthquake', 'outage',
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
  // Every country's brief command carries "brief", so for "brief china" the
  // whole-query score ties across all of them. Break that tie on how many
  // query words a command matches ("brief south sudan": South Sudan matches
  // three, Sudan two), then on how well: exact beats prefix beats substring,
  // so "brief ukraine" picks Ukraine over Russia, whose aliases mention Ukraine.
  const words = query.split(/\s+/).filter((word) => word.length >= 2);
  const coverage = new Map<SearchCommandMatch, { matched: number; strength: number; countryNamePrefix: number }>();
  const wordScore = (terms: string[], word: string): number => Math.max(0, ...terms.map((term) => (
    term === word ? 3 : term.startsWith(word) ? 2 : term.includes(word) ? 1 : 0
  )));
  const wordCoverage = (terms: string[]): { matched: number; strength: number } => {
    if (words.length < 2) return { matched: 0, strength: 0 };
    const scores = words.map((word) => wordScore(terms, word));
    return { matched: scores.filter((score) => score > 0).length, strength: scores.reduce((sum, score) => sum + score, 0) };
  };

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
        const score = term.trim() === query ? 3 : term.startsWith(query) ? 2 : 1;
        if (score > bestScore) bestScore = score;
      }
    }
    if (bestScore > 0) {
      const match: SearchCommandMatch = {
        kind: 'command',
        command,
        score: bestScore,
        title,
        subtitle: options.resolveCommandCategoryLabel(command),
      };
      matched.push(match);
      const isCountry = command.category === 'country' || command.id.startsWith('country-map:');
      const countryNamePrefix = Number(isCountry && command.label.toLowerCase().startsWith(query));
      coverage.set(match, { ...wordCoverage(terms), countryNamePrefix });
    }
  }

  // Break remaining ties in favor of a country whose name starts with the query.
  return matched
    .sort((left, right) => (right.score - left.score)
      || (coverage.get(right)!.matched - coverage.get(left)!.matched)
      || (coverage.get(right)!.strength - coverage.get(left)!.strength)
      || (coverage.get(right)!.countryNamePrefix - coverage.get(left)!.countryNamePrefix))
    .slice(0, MAX_COMMANDS);
}

// What alert channels put before a headline: the email subject prefix and the
// severity tag that opens a Telegram, Slack or Discord message
// (scripts/notification-relay.cjs formatSubject, formatMessage). A subject or
// message line pasted whole searches for the headline it carries.
const ALERT_WORDING_PREFIX = /^(?:worldmonitor alert:|\[(?:critical|high|medium|low|info)\])\s*/;

function withoutAlertWording(query: string): string {
  return query.replace(ALERT_WORDING_PREFIX, '') || query;
}

function resultPerTypeLimit(type: SearchResultType, isMobile: boolean): number {
  if (isMobile) return 2;
  if (type === 'news') return 6;
  if (type === 'headline') return 8;
  if (type === 'alert') return 5;
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

  const entityQuery = withoutAlertWording(query);
  for (const source of options.sources) {
    if (!resultMatchesSearchScope(options.scope, source.type)) continue;
    for (const item of source.items) {
      const titleLower = item.title.toLowerCase();
      const subtitleLower = item.subtitle?.toLowerCase() ?? '';
      const searchTextLower = item.searchText?.toLowerCase() ?? '';
      if (
        !titleLower.includes(entityQuery)
        && !subtitleLower.includes(entityQuery)
        && !searchTextLower.includes(entityQuery)
      ) continue;

      const matches = byType.get(source.type) ?? [];
      const result = {
        type: source.type,
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        data: item.data,
        // A title that is the whole query outranks a prefix match, so a
        // pasted headline lists the item it names first.
        _score: titleLower.trim() === entityQuery ? 3 : (
          titleLower.startsWith(entityQuery)
          || subtitleLower.startsWith(entityQuery)
          || searchTextLower.startsWith(entityQuery)
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
