export function rssFeedCacheKey(variant: string, url: string): string {
  return `rss:feed:v11:${variant}:${url}`;
}

// The 96-hour floor covers a Friday-to-Monday publishing gap. Ranking may
// de-prioritize older articles; country grounding must use the same age limit.
export function resolveMaxAgeMs(): number {
  const raw = Number.parseInt(process.env.NEWS_MAX_AGE_HOURS ?? '', 10);
  const hours = Number.isInteger(raw) && raw > 0 ? raw : 96;
  return hours * 60 * 60 * 1000;
}

// Items more than an hour ahead are clock skew or malformed publisher dates.
export const FUTURE_DATE_TOLERANCE_MS = 60 * 60 * 1000;
