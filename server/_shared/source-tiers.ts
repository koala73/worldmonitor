/**
 * Source tier system for news feed prioritization.
 *
 * Canonical RSS data: shared/source-tiers.json — loaded here via
 * resolveJsonModule (for Vercel edge + the main relay container) and by
 * scripts/ais-relay.cjs via requireShared('source-tiers.json').
 * `requireShared()` resolves from
 * `../shared` OR `./shared` depending on packaging root, so Railway services
 * using rootDirectory=scripts (which cannot see repo-root shared/) pick up
 * scripts/shared/source-tiers.json — a byte-identical mirror enforced by
 * tests/edge-functions.test.mjs (`scripts/shared/ stays in sync with shared/`).
 * Byte-identity is also cross-checked by tests/importance-score-parity.test.mjs.
 * Telegram tiers are an additive typed overlay. Keeping them out of the RSS JSON
 * makes data/telegram-channels.json <-> overlay drift mechanically testable and
 * prevents renamed channels from leaving stale public tier keys.
 *
 * Tier 1: Wire services / official gov/intl orgs — fastest, most authoritative
 * Tier 2: Major established outlets — high-quality journalism
 * Tier 3: Specialty / regional / think tank sources — domain expertise
 * Tier 4: Aggregators and blogs — useful but less authoritative
 */
import sourceTiersData from '../../shared/source-tiers.json';
import { TELEGRAM_SOURCE_TIERS } from '../../shared/telegram-channel-trust';

export const SOURCE_TIERS: Record<string, number> = {
  ...(sourceTiersData as Record<string, number>),
  ...TELEGRAM_SOURCE_TIERS,
};

export function getSourceTier(sourceName: string): number {
  return SOURCE_TIERS[sourceName] ?? 4;
}

export function hasSourceTier(sourceName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SOURCE_TIERS, sourceName);
}
