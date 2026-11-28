export function rssFeedCacheKey(variant: string, url: string): string {
  return `rss:feed:v11:${variant}:${url}`;
}

/**
 * The rows a full-variant parse keeps after the digest's per-feed cap, for
 * whole-catalog readers (country headlines, media perspective, claim search).
 * They live apart from rssFeedCacheKey because every digest build reads that
 * key for every feed and never uses these rows, which were three quarters of
 * its bytes.
 */
export function rssFeedCountryCacheKey(variant: string, url: string): string {
  return `rss:feed-country:v1:${variant}:${url}`;
}

/**
 * A feed's digest rows followed by its retained country rows. The country
 * entry counts only when it came from the same parse as the feed entry, so a
 * failed or newer parse never serves another parse's pool. Entries written
 * before the split carry the pool inline as `countryItems`.
 */
export function feedRowsWithCountryItems(entry: { items: unknown[] }, countryEntry: unknown): unknown[] {
  const inline = (entry as { countryItems?: unknown }).countryItems;
  if (Array.isArray(inline)) return [...entry.items, ...inline];
  const parsedAt = (entry as { parsedAt?: unknown }).parsedAt;
  if (typeof parsedAt !== 'number' || !countryEntry || typeof countryEntry !== 'object') return entry.items;
  const country = countryEntry as { parsedAt?: unknown; items?: unknown };
  return country.parsedAt === parsedAt && Array.isArray(country.items) ? [...entry.items, ...country.items] : entry.items;
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
