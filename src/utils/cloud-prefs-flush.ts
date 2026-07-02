export interface ObservableCloudPrefsFlushSuccessOptions {
  syncVersion: unknown;
  myGeneration: number;
  getAuthGeneration: () => number;
  getSyncVersion: () => number;
  setSyncVersion: (syncVersion: number) => void;
  clearSettledDirtyKeys: () => void;
  setLastSyncAt: (timestampMs: number) => void;
  isIdle: () => boolean;
  setSynced: () => void;
  now?: () => number;
}

/**
 * Apply an observable keepalive flush response after a tab is hidden.
 * Real unloads usually do not run this path; tab switches do, and the echoed
 * syncVersion must be adopted so the next alive-tab save does not hit 409.
 */
export function applyObservableCloudPrefsFlushSuccess(
  opts: ObservableCloudPrefsFlushSuccessOptions,
): boolean {
  if (typeof opts.syncVersion !== 'number') return false;
  if (opts.getAuthGeneration() !== opts.myGeneration) return false;
  if (opts.syncVersion <= opts.getSyncVersion()) return false;

  opts.setSyncVersion(opts.syncVersion);
  opts.clearSettledDirtyKeys();
  opts.setLastSyncAt((opts.now ?? Date.now)());
  if (opts.isIdle()) opts.setSynced();
  return true;
}
