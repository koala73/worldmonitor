/**
 * Whether — and how — a news panel discloses that it is showing only part of
 * its source list (#5873).
 *
 * A CUSTOM news category (a panel the user added from another variant) is never
 * in the per-variant server digest, so direct per-feed fetch is its only path
 * and that path is capped. The cap now rotates and the panel accumulates across
 * refresh cycles, but for the first cycles the panel genuinely holds only some
 * of its sources while the Sources manager lists all of them as enabled. Saying
 * so is the difference between a panel that is partial and one that lies about
 * being complete.
 *
 * The decision lives here rather than in NewsPanel so its edge cases — full
 * coverage, an empty source list, an unresolved dictionary — are unit-testable
 * without standing up a panel and a DOM.
 */

export interface SourceCoverage {
  /** Distinct sources actually represented in what the panel is rendering. */
  covered: number;
  /** Sources the user has enabled for the category. */
  total: number;
}

export type CoverageStringKey = 'sourceCoverage' | 'sourceCoverageHint';

export type CoverageTranslate = (key: string, vars: Record<string, string>) => string;

/**
 * The badge detail (`"3/10 sources"`) or its explanatory title, or `undefined`
 * when the panel has nothing to disclose and should read plain `LIVE`.
 *
 * Returns `undefined` for four distinct reasons, all of which must stay silent
 * rather than render something wrong:
 *
 *  • `null` coverage — the digest-backed / preset case, i.e. almost every panel.
 *  • Full coverage — rotation gets there within a few cycles, and a permanent
 *    "10/10 sources" would be noise on every custom panel forever.
 *  • A non-positive total, or a `covered` that somehow exceeds it. `covered` is
 *    derived from rendered items and `total` from the enabled feed list, so a
 *    source disabled between the two reads could produce "11/10 sources".
 *  • An unresolved key. These strings sit outside the first-paint i18n shell
 *    deliberately (the badge only appears after a completed news load), so the
 *    lazy dictionary may not have landed. An unresolved key composes into
 *    `LIVE · components.newsPanel.sourceCoverage`, which the raw-key healer
 *    cannot repair — it only rewrites EXACT key matches.
 */
export function coverageBadgeString(
  coverage: SourceCoverage | null,
  key: CoverageStringKey,
  translate: CoverageTranslate,
): string | undefined {
  if (!coverage) return undefined;
  const { covered, total } = coverage;
  if (!Number.isFinite(covered) || !Number.isFinite(total)) return undefined;
  if (total <= 0 || covered < 0 || covered >= total) return undefined;

  const path = `components.newsPanel.${key}`;
  const translated = translate(path, { covered: String(covered), total: String(total) });
  return translated === path ? undefined : translated;
}
