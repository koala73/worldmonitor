/**
 * Source tier system for news feed prioritization.
 *
 * Canonical RSS data: shared/source-tiers.json — loaded here via
 * resolveJsonModule (for Vercel edge + the main relay container) and by
 * scripts/ais-relay.cjs via requireShared('source-tiers.json').
 * `requireShared()` resolves from
 * `../shared` OR `./shared` depending on packaging root, so Railway services
 * using rootDirectory=scripts (which cannot see repo-root shared/) pick up
 * scripts/shared/source-tiers.json.
 * Telegram and X tiers are additive typed overlays. Keeping them out of the RSS
 * JSON makes their registries mechanically testable and prevents renamed
 * channels or accounts from leaving stale public tier keys.
 */
import sourceTiersData from '../../shared/source-tiers.json';
import { TELEGRAM_SOURCE_TIERS } from '../../shared/telegram-channel-trust';
import { X_ACCOUNT_SOURCE_TIERS } from '../../shared/x-account-trust';
import { foldPublisherName } from '../../shared/publisher-name.js';

export const SOURCE_TIERS: Record<string, number> = {
  ...(sourceTiersData as Record<string, number>),
  ...TELEGRAM_SOURCE_TIERS,
  ...X_ACCOUNT_SOURCE_TIERS,
};

export function getSourceTier(sourceName: string): number {
  return SOURCE_TIERS[sourceName] ?? 4;
}

export type DeclaredTier = 1 | 2 | 3 | 4;

/** What each tier means, in the words the docs table, the app and MCP schemas use. */
export const TIER_MEANING: Readonly<Record<DeclaredTier, string>> = Object.freeze({
  1: 'Wire services and official bodies',
  2: 'Major outlets',
  3: 'Specialist, regional and think-tank sources',
  4: 'Aggregators and blogs',
});

/** The public tier table's path on the web origin. The docs site keeps "&" in heading anchors. */
export const TIER_DOCS_PATH = '/docs/data-sources#source-credibility-%26-feed-tiering';

/**
 * The tier a label was explicitly assigned in the RSS, Telegram or X tables,
 * or null. Unlike getSourceTier it never defaults: an undeclared source has an
 * unknown tier, and treating it as tier 4 would claim something about the
 * source that no table says.
 */
export function declaredSourceTier(sourceName: string): DeclaredTier | null {
  const key = declaredSourceTierKey(sourceName);
  const tier = key === null ? undefined : SOURCE_TIERS[key];
  return tier === 1 || tier === 2 || tier === 3 || tier === 4 ? tier : null;
}

/**
 * The tier-table key a label names, or null. An exact key wins, then a key
 * that differs only in case, then one that differs only in case and a leading
 * "The" (the fold publisher families use). A fold two keys share resolves to
 * neither: "The Hacker News" and "Hacker News" are different outlets.
 */
export function declaredSourceTierKey(sourceName: string): string | null {
  if (Object.prototype.hasOwnProperty.call(SOURCE_TIERS, sourceName)) return sourceName;
  const { byLowerName, byFoldedName } = tierKeyIndex();
  return byLowerName.get(sourceName.trim().toLowerCase()) ?? byFoldedName.get(foldPublisherName(sourceName)) ?? null;
}

let tierKeys: { byLowerName: Map<string, string>; byFoldedName: Map<string, string | null> } | null = null;
function tierKeyIndex() {
  if (!tierKeys) {
    tierKeys = { byLowerName: new Map(), byFoldedName: new Map() };
    for (const name of Object.keys(SOURCE_TIERS)) {
      const lower = name.trim().toLowerCase();
      if (!tierKeys.byLowerName.has(lower)) tierKeys.byLowerName.set(lower, name);
      const folded = foldPublisherName(name);
      tierKeys.byFoldedName.set(folded, tierKeys.byFoldedName.has(folded) ? null : name);
    }
  }
  return tierKeys;
}
