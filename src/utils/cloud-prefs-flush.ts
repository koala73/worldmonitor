export interface ObservableCloudPrefsFlushSuccessOptions {
  syncVersion: unknown;
  myGeneration: number;
  getAuthGeneration: () => number;
  getSyncVersion: () => number;
  /** Returns false when a usable store REJECTED the version write. */
  setSyncVersion: (syncVersion: number) => boolean;
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

  // A rejected version write means the durable marker is still stale. Going on
  // to settle dirty keys and report synced would claim a reconciliation that
  // did not persist, so bail before touching either (#7833 review).
  if (!opts.setSyncVersion(opts.syncVersion)) return false;
  opts.clearSettledDirtyKeys();
  opts.setLastSyncAt((opts.now ?? Date.now)());
  if (opts.isIdle()) opts.setSynced();
  return true;
}
