export type BriefIrrelevanceReason = 'sport' | 'entertainment' | 'lifestyle' | 'award';

export function briefIrrelevanceReason(title: unknown): BriefIrrelevanceReason | null;

export function isBriefRelevantTitle(title: unknown): boolean;
