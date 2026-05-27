export const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied';

export interface CloudPrefsAppliedDetail {
  keys: string[];
}

export function dispatchCloudPrefsAppliedEvent(
  keys: string[],
  target: Pick<Window, 'dispatchEvent'> = window,
): void {
  const uniqueKeys = Array.from(new Set(keys));
  if (uniqueKeys.length === 0) return;
  target.dispatchEvent(new CustomEvent<CloudPrefsAppliedDetail>(CLOUD_PREFS_APPLIED_EVENT, {
    detail: { keys: uniqueKeys },
  }));
}

export function readCloudPrefsAppliedKeys(event: Event): string[] {
  const detail = (event as CustomEvent<CloudPrefsAppliedDetail>).detail;
  return Array.isArray(detail?.keys)
    ? detail.keys.filter((key): key is string => typeof key === 'string')
    : [];
}

export function addCloudPrefsAppliedListener(
  target: EventTarget,
  onKeys: (keys: string[]) => void,
): () => void {
  const handler = (event: Event): void => {
    onKeys(readCloudPrefsAppliedKeys(event));
  };
  target.addEventListener(CLOUD_PREFS_APPLIED_EVENT, handler);
  return () => target.removeEventListener(CLOUD_PREFS_APPLIED_EVENT, handler);
}
