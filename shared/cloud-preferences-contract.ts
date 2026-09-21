export const PREFERENCE_VARIANTS = ['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as const;

export type PreferenceVariant = (typeof PREFERENCE_VARIANTS)[number];

export function isPreferenceVariant(value: unknown): value is PreferenceVariant {
  return typeof value === 'string' && (PREFERENCE_VARIANTS as readonly string[]).includes(value);
}

export const ACCOUNT_PROVENANCE_PREFERENCE_KEYS = [
  'worldmonitor-free-tier-source-ownership',
  'worldmonitor-free-tier-layer-ownership',
] as const;

export const ROLLING_DEPLOYMENT_PREFERENCE_KEYS = [
  ...ACCOUNT_PROVENANCE_PREFERENCE_KEYS,
  'wm-font-scale',
  'wm-live-media-idle-stop',
] as const;
