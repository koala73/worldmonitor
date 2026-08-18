import type { Command } from '@/config/commands';

export type SearchResultType =
  | 'country'
  | 'news'
  | 'hotspot'
  | 'market'
  | 'prediction'
  | 'conflict'
  | 'base'
  | 'pipeline'
  | 'cable'
  | 'datacenter'
  | 'earthquake'
  | 'outage'
  | 'nuclear'
  | 'irradiator'
  | 'techcompany'
  | 'ailab'
  | 'startup'
  | 'techevent'
  | 'techhq'
  | 'accelerator'
  | 'exchange'
  | 'financialcenter'
  | 'centralbank'
  | 'commodityhub'
  | 'flight';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle?: string;
  data: unknown;
}

export interface SearchableSource {
  type: SearchResultType;
  items: { id: string; title: string; subtitle?: string; searchText?: string; data: unknown }[];
}

export interface SearchCommandMatch {
  kind: 'command';
  command: Command;
  score: number;
  title: string;
  subtitle: string;
}

export interface SearchEntityMatch {
  kind: 'result';
  result: SearchResult;
  score: number;
}

export type SearchMatch = SearchCommandMatch | SearchEntityMatch;

export function searchMatchIdentity(match: SearchMatch): string {
  if (match.kind === 'command') return JSON.stringify(['command', match.command.id]);
  const flightLayer = match.result.type === 'flight'
    ? String((match.result.data as { layer?: unknown }).layer ?? '')
    : '';
  // Indexed subtitle text (prices, probabilities, flight status) can update
  // without changing the logical target. Keep it out of the identity so an
  // opener can resolve and dispatch the fresh payload after a benign refresh.
  return JSON.stringify([
    'result',
    match.result.type,
    match.result.id,
    match.result.title,
    flightLayer,
  ]);
}
