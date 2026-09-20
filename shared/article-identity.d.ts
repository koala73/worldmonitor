/** Types for article-identity.js (plain JS so .mjs scripts and tests import it directly). */

export function normalizeArticleUrl(value: unknown): string;

export function dedupeByArticleUrl<T>(rows: T[], getUrl: (row: T) => unknown): T[];

export function duplicateArticleUrls<T>(rows: T[], getUrl: (row: T) => unknown): string[];
