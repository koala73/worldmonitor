/**
 * Full-variant first-visit order.  This is intentionally a key-only policy:
 * panel ownership and a user's saved order remain in App/PanelLayout.
 */
export const FULL_ECONOMY_FIRST_PANEL_KEYS = [
  // Market overview and the native stock workspace entry are surfaced by the
  // Market panel itself; stock-analysis is the adjacent dashboard surface.
  'markets',
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'market-implications',
  // Macro, commodities, FX and aggregate trade.
  'economic',
  'macro-signals',
  'consumer-prices',
  'commodities',
  'fx',
  'market-breadth',
  'economic-calendar',
  'trade-policy',
  'global-procurement',
  // Logistics and China industrial/trade surfaces.
  'supply-chain',
  'china-corridors',
  'china-activity-nowcast',
  'hormuz-tracker',
  // News and event context follows the economic workspaces.
  'live-news',
  'politics',
  'intel',
  'gdelt-intel',
  // Disaster and infrastructure precede the provider-dependent posture tools.
  'disaster-correlation',
  'cascade',
] as const;

/** Provider-dependent posture panels stay at the bottom of a fresh full layout. */
export const FULL_DEPRIORITIZED_REALTIME_PANEL_KEYS = [
  'military-correlation',
  'escalation-correlation',
  'airline-intel',
] as const;

/** First-visit collapse defaults. They never overwrite a stored user choice. */
export const FULL_DEFAULT_COLLAPSED_PANEL_KEYS = FULL_DEPRIORITIZED_REALTIME_PANEL_KEYS;

export const FULL_ECONOMY_LAYOUT_MIGRATION_KEY = 'worldmonitor-full-economy-layout-v1';

/**
 * Reorders known keys without dropping a panel or introducing duplicates.
 * Unknown/future keys retain their relative input order between the priority
 * and deliberately-deprioritized groups.
 */
export function prioritizeFullPanelKeys(keys: readonly string[]): string[] {
  const present = new Set(keys);
  const picked = new Set<string>();
  const ordered: string[] = [];

  const append = (key: string) => {
    if (!present.has(key) || picked.has(key)) return;
    picked.add(key);
    ordered.push(key);
  };

  FULL_ECONOMY_FIRST_PANEL_KEYS.forEach(append);
  keys.forEach((key) => {
    if (!(FULL_DEPRIORITIZED_REALTIME_PANEL_KEYS as readonly string[]).includes(key)) append(key);
  });
  FULL_DEPRIORITIZED_REALTIME_PANEL_KEYS.forEach(append);

  return ordered;
}

/**
 * A saved order is treated as user-owned, even if it might have originated
 * from an old default. The new defaults apply on a true first visit or after a
 * user explicitly clears/resets their layout.
 */
export function shouldSeedFullEconomyDefaultCollapse(
  variant: string,
  hasSavedPanelOrder: boolean,
): boolean {
  return variant === 'full' && !hasSavedPanelOrder;
}
