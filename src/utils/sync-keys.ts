export const CLOUD_SYNC_KEYS = [
  'worldmonitor-panels',
  'worldmonitor-monitors',
  'worldmonitor-layers',
  'worldmonitor-disabled-feeds',
  'worldmonitor-free-tier-source-ownership',
  'worldmonitor-free-tier-layer-ownership',
  'worldmonitor-panel-spans',
  'worldmonitor-panel-col-spans',
  'panel-order',
  'panel-order-bottom-set',
  'worldmonitor-theme',
  'worldmonitor-variant',
  'worldmonitor-map-mode',
  'wm-breaking-alerts-v1',
  'wm-market-watchlist-v1',
  'wm-market-catalog-selection-v1',
  'aviation:watchlist:v1',
  'wm-pinned-webcams',
  'wm-map-provider',
  'wm-font-family',
  'wm-globe-visual-preset',
  'wm-stream-quality',
  'wm-ai-flow-cloud-llm',
  // Sister AI-flow toggles. Without these, the user's "Browser Local Model"
  // and "Headline Memory" prefs reset per variant and disagree with the
  // already-synced Cloud AI toggle — e.g. Headline Memory left on for the
  // full variant silently runs the local ML worker (HuggingFace model
  // downloads) on every page load, but switching to the tech variant shows
  // the toggle as off because tech-variant localStorage is fresh.
  'wm-ai-flow-browser-model',
  'wm-headline-memory',
  'wm-analysis-frameworks',
  'wm-panel-frameworks',
  // Provider-specific map themes (wm-map-theme:<provider>)
  'wm-map-theme:auto',
  'wm-map-theme:pmtiles',
  'wm-map-theme:openfreemap',
  'wm-map-theme:carto',
  // Live-stream mode
  'wm-live-streams-always-on',
  // #4923 read-state: previous-visit timestamp driving "new since you were
  // last here" — synced so a phone visit doesn't re-flag stories already
  // read on desktop.
  'wm-read-state-v1',
] as const;

export type CloudSyncKey = (typeof CLOUD_SYNC_KEYS)[number];

/**
 * Keys whose ABSENCE from a cloud row must not be read as "the user cleared
 * this". `applyCloudBlob` deletes any synced key the incoming row omits, which
 * is correct for a preference the user can reset but wrong for the free-tier
 * gate's ownership sidecars: every row written before #6345 lacks them, as does
 * every upload from an older tab still running a pre-#6345 bundle.
 *
 * Deleting them locally is not a cosmetic loss. Without the sidecar,
 * `reconcileSourceLimitForTier` sees no ownership metadata,
 * `inferExactSourceGateOwnership` declines to guess for any customized profile,
 * and the gate's own disables become indistinguishable from deliberate user
 * choices — so a later Pro upgrade can never reverse them. That is precisely
 * the bug #6345 exists to fix, reintroduced through the cloud path.
 *
 * Tolerating absence loses nothing, because an intentional clear is always an
 * explicit empty-array write (see `persistGateOwnershipTransition`'s Pro path
 * and the variant reset in App.ts), never an omission.
 */
export const ABSENCE_TOLERANT_SYNC_KEYS: ReadonlySet<CloudSyncKey> = new Set([
  'worldmonitor-free-tier-source-ownership',
  'worldmonitor-free-tier-layer-ownership',
] satisfies CloudSyncKey[]);

export type CloudBlobKeyAction =
  | { kind: 'set'; value: string }
  | { kind: 'remove' }
  | { kind: 'keep' };

/**
 * What applying an incoming cloud row should do to one local key.
 *
 * Extracted as a pure decision so the absence rule is testable against real
 * key names rather than asserted by grepping the applier's source text.
 */
export function resolveCloudBlobKeyAction(
  key: CloudSyncKey,
  data: Record<string, unknown>,
): CloudBlobKeyAction {
  const value = data[key];
  if (typeof value === 'string') return { kind: 'set', value };
  if (!(key in data) && !ABSENCE_TOLERANT_SYNC_KEYS.has(key)) return { kind: 'remove' };
  return { kind: 'keep' };
}
