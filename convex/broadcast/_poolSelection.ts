/**
 * Per-page eligibility filter for `pickWaveAction`.
 *
 * Pure (no side effects, no Convex APIs) so it's unit-testable without
 * mocking Resend / scheduler / Convex action runtime. Wired into
 * pickWaveAction's existing pagination loop, BEFORE `reservoir.offer()`.
 *
 * Filter-before-reservoir is load-bearing: filtering after sampling
 * silently underfills (sample 1000, exclude 200, send 800 even though
 * thousands of eligible English contacts exist elsewhere in the pool).
 *
 * For each registration row, applies ordered filters:
 *   1. empty / missing email                             → skip
 *   2. suppressed (bounce / complaint history)           → skip
 *   3. paid customer                                     → skip (don't email "buy PRO!" to a PRO)
 *   4. already-stamped with a previous wave              → skip
 *   ─── pageEligibleCount counts everything that survives the above ───
 *   5. excludeNonEnglish AND row's locale is non-English → skip (locale-excluded)
 *   ─── eligible[] is what survives ALL of the above ───
 */
import { inferLocaleFromEmail } from "./_localeHeuristic";

export type FilterPageResult = {
  /** Emails that survive all filters; pickWaveAction passes these to the reservoir. */
  eligible: string[];
  /**
   * Count of rows that passed the non-locale filters (suppressed / paid / stamped).
   * Includes locale-excluded rows. This is the "pool size before locale filter" —
   * the metric the operator uses to decide whether the locale filter's impact is
   * acceptable (per the dry-run report).
   */
  pageEligibleCount: number;
  /** Map of localePrimary → count of rows excluded because of locale. */
  pageExcludedByLocale: Record<string, number>;
  /** Sum of pageExcludedByLocale values; convenience accumulator. */
  pageExcludedTotal: number;
};

export type FilterPageArgs = {
  page: ReadonlyArray<{ normalizedEmail: string; proLaunchWave?: string }>;
  suppressedSet: ReadonlySet<string>;
  paidSet: ReadonlySet<string>;
  /**
   * Per-page lookup of users-table locale data. Built by the caller via
   * `_getUsersByEmailPage` for the candidate emails on this page only —
   * NOT a global map. Missing entries are valid: a registration whose
   * owner never authenticated post-launch has no users row, falls back
   * to email-TLD inference.
   */
  usersByEmail: ReadonlyMap<string, { localePrimary?: string }>;
  excludeNonEnglish: boolean;
};

export function filterPageForEligibility(args: FilterPageArgs): FilterPageResult {
  const eligible: string[] = [];
  let pageEligibleCount = 0;
  const pageExcludedByLocale: Record<string, number> = {};
  let pageExcludedTotal = 0;

  for (const row of args.page) {
    const email = row.normalizedEmail;
    if (!email || email.length === 0) continue;
    if (args.suppressedSet.has(email)) continue;
    if (args.paidSet.has(email)) continue;
    if (row.proLaunchWave) continue;
    pageEligibleCount++;

    if (!args.excludeNonEnglish) {
      eligible.push(email);
      continue;
    }

    // users-table data is authoritative when present (the user actively
    // signed in post-launch and ensureRecord captured their browser locale).
    // Otherwise fall back to email-TLD heuristic for legacy registrations.
    const userInfo = args.usersByEmail.get(email);
    const localePrimary: string | null =
      (userInfo?.localePrimary ?? null) || inferLocaleFromEmail(email);

    if (localePrimary && localePrimary !== "en") {
      pageExcludedByLocale[localePrimary] =
        (pageExcludedByLocale[localePrimary] ?? 0) + 1;
      pageExcludedTotal++;
      continue;
    }
    eligible.push(email);
  }

  return { eligible, pageEligibleCount, pageExcludedByLocale, pageExcludedTotal };
}
