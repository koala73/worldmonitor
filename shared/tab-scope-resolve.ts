/**
 * Expands a focus scope (#10453) to its chosen countries plus their neighbours.
 *
 * Kept out of shared/tab-scope.ts on purpose: the tab store validates scopes
 * at first paint and must not pull the adjacency table into that chunk.
 */

import { neighboursOf } from './country-adjacency';
import type { TabScope } from './tab-scope';

/** Chosen countries in their given order, plus the sorted union of their neighbours. */
export function resolveScope(scope: TabScope): { chosen: string[]; neighbours: string[] } {
  const chosen = [...scope.countries];
  if (scope.neighbours === false) return { chosen, neighbours: [] };
  const picked = new Set(chosen);
  const neighbours = new Set<string>();
  for (const code of chosen) {
    for (const n of neighboursOf(code)) if (!picked.has(n)) neighbours.add(n);
  }
  return { chosen, neighbours: [...neighbours].sort() };
}
