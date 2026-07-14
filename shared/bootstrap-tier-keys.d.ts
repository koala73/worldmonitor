export type BootstrapTier = 'fast' | 'slow' | 'on-demand';

export const BOOTSTRAP_CACHE_KEYS: Readonly<Record<string, string>>;
export const BOOTSTRAP_TIERS: Readonly<Record<string, BootstrapTier>>;

export function bootstrapTierKeyNames(
  tier: BootstrapTier,
  options?: { iranEventsEnabled?: boolean },
): string[];

export function resolveBootstrapRegistry(options?: { iranEventsEnabled?: boolean }): {
  cacheKeys: Record<string, string>;
  tiers: Record<string, BootstrapTier>;
};
