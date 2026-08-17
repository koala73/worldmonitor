export const ACCOUNT_PROVENANCE_PREFERENCE_KEYS = [
  'worldmonitor-free-tier-source-ownership',
  'worldmonitor-free-tier-layer-ownership',
] as const;

export const ROLLING_DEPLOYMENT_PREFERENCE_KEYS = [
  ...ACCOUNT_PROVENANCE_PREFERENCE_KEYS,
  'wm-font-scale',
] as const;
