export declare function foldWireReprints(entries: readonly { title?: unknown; family: string }[]): string[];
export declare function wireAwareFamilyFor<T extends { title?: unknown }>(
  items: readonly T[],
  familyFor?: (item: T) => string,
): (item: T) => string;
