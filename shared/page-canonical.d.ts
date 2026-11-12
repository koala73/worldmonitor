/** Types for page-canonical.js (plain JS so .mjs scripts and tests import it directly). */

export function declaredHtmlCanonical(html: unknown): string | null;

export function pageCanonicalUrl(pageUrl: string | URL, declaredHref?: string | null): string;
