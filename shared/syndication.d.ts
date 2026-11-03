export declare const SYNDICATION_MIN_LEAD_WORDS: number;
export declare const SYNDICATION_MIN_CONTAINMENT: number;

export interface SyndicationGroup {
  /** The families joined because their items carried the same copy, sorted. */
  families: string[];
  /** Their feed labels, first-seen order. */
  labels: string[];
}

export interface SyndicationResult<T> {
  /** The item's family after merging same-copy families ('' for an item with no family). */
  familyOf(item: T): string;
  /** Distinct families after merging. */
  publishers: number;
  /** Each merge, for display and for curation review. */
  groups: SyndicationGroup[];
}

export declare function copyShingles(item: { title?: unknown; snippet?: unknown; description?: unknown }): Set<string> | null;
export declare function copyContainment(a: Set<string>, b: Set<string>): number;
export declare function detectSyndication<T extends { source?: unknown; title?: unknown; snippet?: unknown; description?: unknown }>(
  items: readonly T[],
  familyFor?: (item: T) => string,
): SyndicationResult<T>;
