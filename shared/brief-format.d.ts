export const BRIEF_SECTION_HEADERS: readonly string[];
export function isBriefSectionHeader(line: string): boolean;
export function isBriefBullet(line: string): boolean;
export function stripBriefBullet(line: string): string;
export function isBriefOutlookRow(line: string): boolean;
