/** Types for dedup.mjs (plain JS so .mjs tests can import it directly). */

export function deduplicateHeadlines(headlines: string[]): string[];

export function assignStoryIdentity<T extends { title: string; source: string; publishedAt?: number }>(
  items: T[],
  normalizeTitle: (title: string) => string,
  sha256Hex: (text: string) => Promise<string>,
): Promise<Map<T, { titleHash: string; corroborationCount: number; memberTitleHashes: string[] }>>;

export function adoptExistingCanonical(
  memberTitleHashes: string[] | undefined,
  defaultHash: string,
  aliasTargetByHash: Map<string, string> | Record<string, string> | undefined,
): string;
