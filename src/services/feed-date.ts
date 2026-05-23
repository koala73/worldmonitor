/**
 * Feed-date parsing + the single ranking/recency helper consumers must use
 * for any "is this item fresh?" decision.
 *
 * Background: RSS 2.0 makes `pubDate` optional; Atom uses `<updated>` and
 * `<published>` separately. Real feeds frequently ship items with missing
 * or malformed timestamps. The legacy `parseFeedDateOrNow` substituted
 * `Date.now()` for any unparseable input — that produced FALSE FRESHNESS:
 * an item with no real date would sort ahead of legitimately fresh items
 * and fire breaking-news alerts that shouldn't fire.
 *
 * Contract:
 *   - `parseFeedDate(value)` returns `{ date, missing }`. The Date is still
 *     populated (using `Date.now()` as the synthesized stamp) so display
 *     consumers can format it without null-handling. The `missing` flag
 *     records whether the source had a parseable timestamp.
 *   - `effectivePubDateMs(item)` returns 0 for items with `pubDateMissing:
 *     true`, otherwise `item.pubDate.getTime()`. Every ranking/recency
 *     consumer in `src/services/` and `src/app/` MUST route through this
 *     helper instead of calling `item.pubDate.getTime()` directly. The
 *     static guardrail test `tests/feed-date-ranking-uses-effective.test.
 *     mts` enforces this.
 *
 * Recency-window semantics: returning 0 makes any positive-duration
 * recency gate (`Date.now() - effectivePubDateMs(item) < windowMs`)
 * evaluate false, which EXCLUDES missing-date items from freshness
 * windows. They remain in the underlying catalog and render normally with
 * the synthesized timestamp; they just never claim to be fresh. This is
 * the deliberate trade-off — see plan U3 Key Technical Decisions.
 */

/**
 * @deprecated Use `parseFeedDate` + `effectivePubDateMs` instead. Kept as
 * a re-export so callers in non-rss paths (none currently) don't crash if
 * they ever appear; the rss.ts parse site has migrated.
 */
export function parseFeedDateOrNow(value: string | null | undefined): Date {
  return parseFeedDate(value).date;
}

export interface ParsedFeedDate {
  /** Best-effort Date for display. Always a valid Date instance — uses
   *  `Date.now()` as the synthesized stamp when input was unparseable. */
  date: Date;
  /** True when the source had no parseable timestamp. Ranking/recency
   *  code reads this via `effectivePubDateMs` to deprioritize the item. */
  missing: boolean;
}

export function parseFeedDate(value: string | null | undefined): ParsedFeedDate {
  if (!value) return { date: new Date(), missing: true };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date: new Date(), missing: true };
  return { date: parsed, missing: false };
}

/**
 * Returns the timestamp a ranking/recency comparator should use for this
 * item. Items flagged `pubDateMissing: true` get 0 — they sort last in
 * "newest first" comparators and fail every positive-duration recency
 * gate. The `pubDateMissing` field is OPTIONAL on the input type so this
 * helper accepts items from non-RSS producers (synthesized items from
 * analysis/prediction paths) without forcing every construction site to
 * set it.
 */
export function effectivePubDateMs(item: {
  pubDate: Date | string | number;
  pubDateMissing?: boolean;
}): number {
  if (item.pubDateMissing === true) return 0;
  if (item.pubDate instanceof Date) {
    const ms = item.pubDate.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof item.pubDate === 'number') {
    // Filter NaN / Infinity. Cache-deserialized entries or future numeric
    // pubDate constructors should never claim freshness with a non-finite
    // stamp — sort comparators on NaN have unspecified behavior per the
    // JS spec.
    return Number.isFinite(item.pubDate) ? item.pubDate : 0;
  }
  // String case (serialized form, e.g. from cache deserialization).
  const ms = new Date(item.pubDate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
