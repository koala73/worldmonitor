export type BriefFontPlatform = 'plain' | 'apple-woff2' | 'apple-woff' | 'hinted';

export function briefFontPlatform(userAgent: string): BriefFontPlatform;
