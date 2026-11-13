import type { ResolvedScope } from '@/services/tab-focus';

/**
 * Dashboard focus (#10453): the pure split behind every filtering panel. Kept
 * apart from `panel-scope-filter.ts` (which renders the strip and needs i18n)
 * so tests run it under plain node.
 */

export type ScopeRelation = 'chosen' | 'neighbour';

/** One ISO 3166-1 alpha-2 code, several (an item about more than one country), or none. */
export type ScopeCountries = string | readonly string[] | null | undefined;

export interface ScopedItem<T> {
  item: T;
  relation: ScopeRelation;
  /** The focused country the item matched; null without a focus. */
  country: string | null;
}

export interface ScopePartition<T> {
  /** Chosen-country items, then neighbour items, each in source order. */
  shown: ScopedItem<T>[];
  /** Items attributed only to countries outside the focus. */
  hiddenCount: number;
  /** Items with no country, in source order. */
  unattributed: T[];
}

function toCodes(value: ScopeCountries): string[] {
  if (!value) return [];
  const list = typeof value === 'string' ? [value] : value;
  const codes: string[] = [];
  for (const code of list) {
    if (typeof code === 'string' && code.trim()) codes.push(code.trim().toUpperCase());
  }
  return codes;
}

/**
 * Split items by the focus. Without a focus every item is shown, in order.
 * An item naming several countries counts as chosen when any of them is
 * chosen, else as a neighbour when any is a neighbour, else as hidden.
 */
export function partitionByScope<T>(
  items: readonly T[],
  getCountry: (item: T) => ScopeCountries,
  resolved: ResolvedScope | null,
): ScopePartition<T> {
  if (!resolved) {
    return { shown: items.map((item) => ({ item, relation: 'chosen', country: null })), hiddenCount: 0, unattributed: [] };
  }
  const chosen = new Set(resolved.chosen);
  const neighbours = new Set(resolved.neighbours);
  const inChosen: ScopedItem<T>[] = [];
  const inNeighbours: ScopedItem<T>[] = [];
  const unattributed: T[] = [];
  let hiddenCount = 0;
  for (const item of items) {
    const codes = toCodes(getCountry(item));
    if (codes.length === 0) {
      unattributed.push(item);
      continue;
    }
    const chosenCode = codes.find((code) => chosen.has(code));
    if (chosenCode) {
      inChosen.push({ item, relation: 'chosen', country: chosenCode });
      continue;
    }
    const neighbourCode = codes.find((code) => neighbours.has(code));
    if (neighbourCode) {
      inNeighbours.push({ item, relation: 'neighbour', country: neighbourCode });
      continue;
    }
    hiddenCount += 1;
  }
  return { shown: [...inChosen, ...inNeighbours], hiddenCount, unattributed };
}
