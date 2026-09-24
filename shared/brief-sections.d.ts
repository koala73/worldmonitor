export type BriefSectionKey = 'situation' | 'implications' | 'risks' | 'outlook' | 'watch';

export const BRIEF_SECTION_KEYS: readonly BriefSectionKey[];
export const IMPLICATIONS_HEADING_PREFIX: string;
export const BRIEF_FIXED_SECTION_HEADINGS: readonly string[];

export function briefSectionHeading(key: BriefSectionKey, countryName: string): string;
export function briefSectionKey(heading: string): BriefSectionKey | null;
