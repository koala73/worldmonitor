// Type surface for scripts/_conflict-gdelt.mjs (pure, import-safe helpers) so
// server/ TypeScript consumers pass typecheck:api — same pattern as
// _simulation-queue-constants.d.mts. Keep in sync with the .mjs exports.

export declare const GDELT_COUNTRY_NAMES: Record<string, string>;
export declare const GDELT_CONFLICT_TERMS: string;
export declare const GDELT_MAX_ARTICLES_PER_COUNTRY: number;

/** GDELT seendate ('YYYYMMDDTHHMMSSZ' or digits-only) → 'YYYY-MM-DD', '' if unparseable. */
export declare function gdeltSeenDateToIso(seendate: unknown): string;

/** GDELT 14-digit timestamp → epoch ms, NaN if unparseable. */
export declare function gdeltSeenDateToMs(value: unknown): number;

export declare function buildGdeltConflictUrl(cc: string, name?: string, maxRecords?: number): string;

export declare function mapGdeltArticlesToEvents(
  articles: unknown,
  cc: string,
  name?: string,
): Array<{
  id: string;
  eventType: string;
  country: string;
  event_date: string;
  occurredAt: number;
  source: string;
  title: string;
  url: string;
}>;
